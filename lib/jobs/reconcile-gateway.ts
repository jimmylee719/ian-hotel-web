import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { finishFlow } from "@/lib/admin/reconcile";
import { countsAsBookingRefund, markRefundFailed, settleRefundRow } from "@/lib/booking/confirm";
import type { Deps } from "@/lib/booking/notify";
import { applyPaymentNotice } from "@/lib/booking/payment-notice";
import { payments, reservations } from "@/lib/db/schema";

/** A payment or refund is asked about once it has been pending this long (the gateway's own calls time out far sooner). */
export const GATEWAY_RECONCILE_AFTER_MS = 10 * 60_000;
/** A payment started longer ago than this is no longer asked about (an abandoned payment page). */
export const CHARGE_LOOKBACK_MS = 24 * 3600_000;
/** The gateway reconcile's cron interval (lib/jobs/cron.ts CRON_GATEWAY_RECONCILE). */
const RUN_INTERVAL_MS = 15 * 60_000;
/** A booking whose latest payment started over an hour ago has its attempts asked about only hourly. */
export const SLOW_QUERY_AFTER_MS = 60 * 60_000;
const SLOW_QUERY_EVERY_MS = 60 * 60_000;
/** At most this many refunds and this many charge-attempt queries per run. */
export const GATEWAY_RECONCILE_BATCH = 50;

export type GatewayReconcileResult = {
  refundsChecked: number; refundsSettled: number; refundsFailed: number; refundsUnresolved: number;
  chargesChecked: number; chargesApplied: number;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Every 15 minutes: ask the gateway about money whose outcome is still unknown here, and apply what it says
 * through the same guarded paths as the live flow. It never calls gateway.refund itself.
 * - Refund rows `pending` for over 10 minutes → queryRefund(idempotencyKey):
 *   succeeded → settled as refundOnce settles it (settleRefundRow), then the flow waiting on it is finished as
 *   refund reconciliation finishes it (finishFlow: a cancellation completes, a failed booking is refunded and
 *   closed); failed / not_found → marked failed (pending → failed only); pending or no answer → left pending for
 *   staff (the dashboard's refund_pending alert).
 * - Bookings whose latest payment attempt started under a day ago (any status) → queryTransaction for each
 *   attempt `<code>-1 … <code>-<chargeAttempt>` not yet recorded as a charge (the latest only once 10 minutes old),
 *   newest bookings first, every run for the first hour and hourly after that;
 *   succeeded → applied exactly like a verified notice (applyPaymentNotice: dedupe, amount check, re-hold, channel
 *   push, stray refund of a second payment); the charge row then carries its order number and is not asked about
 *   again. Anything else changes nothing.
 * One item failing is logged and counted as unresolved; it never stops the others.
 */
export async function runGatewayReconcile(deps: Deps, now: Date): Promise<GatewayReconcileResult> {
  const out: GatewayReconcileResult = {
    refundsChecked: 0, refundsSettled: 0, refundsFailed: 0, refundsUnresolved: 0, chargesChecked: 0, chargesApplied: 0,
  };
  const due = now.getTime() - GATEWAY_RECONCILE_AFTER_MS;

  const refunds = await deps.db.select().from(payments)
    .where(and(eq(payments.kind, "refund"), eq(payments.status, "pending"), lte(payments.createdAt, due)))
    .orderBy(asc(payments.createdAt), asc(payments.id))
    .limit(GATEWAY_RECONCILE_BATCH);
  for (const row of refunds) {
    if (!row.idempotencyKey) continue;
    out.refundsChecked++;
    try {
      const q = await deps.gateway.queryRefund(row.idempotencyKey).catch((e: unknown) => ({ error: errorText(e) }));
      if ("error" in q || q.status === "pending") {
        out.refundsUnresolved++;
        continue;
      }
      if (q.status === "succeeded") {
        await settleRefundRow(deps.db, row, q.refundRef ?? null, countsAsBookingRefund(row.idempotencyKey), now);
        await finishFlow(deps, row.idempotencyKey, row.reservationId, now);
        out.refundsSettled++;
      } else {
        await markRefundFailed(deps.db, row.id);
        out.refundsFailed++;
      }
    } catch (e) {
      console.error(`gateway reconcile: refund ${row.id} failed`, e);
      out.refundsUnresolved++;
    }
  }

  // Every attempt of a payment started in the last day, whatever the booking's status since: a guest may pay on
  // one attempt, lose the notice and start another, and the booking may have expired or been paid by that other one.
  // Attempts already recorded as charges are not asked about again; the latest only once it is 10 minutes old.
  const bookings = await deps.db.select({
    id: reservations.id, code: reservations.code, attempts: reservations.chargeAttempt, startedAt: reservations.lastChargeStartedAt,
  }).from(reservations)
    .where(and(
      eq(reservations.channel, "direct"), gt(reservations.chargeAttempt, 0),
      gte(reservations.lastChargeStartedAt, now.getTime() - CHARGE_LOOKBACK_MS),
    ))
    // Newest first: a recent lost notice is the most likely to be recoverable, and never waits behind old attempts.
    .orderBy(desc(reservations.lastChargeStartedAt), asc(reservations.id));
  charges: for (const b of bookings) {
    // Within the first hour every run asks; after that, about once an hour (every 4th 15-minute run since the start),
    // so abandoned attempts the gateway keeps answering not_found / failed do not use up each run's budget.
    const age = now.getTime() - (b.startedAt ?? 0);
    if (age >= SLOW_QUERY_AFTER_MS && Math.floor(age / RUN_INTERVAL_MS) % (SLOW_QUERY_EVERY_MS / RUN_INTERVAL_MS) !== 0) continue;
    const recorded = new Set((await deps.db.select({ order: payments.merchantOrderNo }).from(payments)
      .where(and(eq(payments.reservationId, b.id), eq(payments.kind, "charge"), isNotNull(payments.merchantOrderNo))))
      .map((r) => r.order));
    const last = (b.startedAt ?? 0) <= due ? b.attempts : b.attempts - 1;
    for (let n = 1; n <= last; n++) {
      const merchantOrderNo = `${b.code}-${n}`;
      if (recorded.has(merchantOrderNo)) continue;
      if (out.chargesChecked >= GATEWAY_RECONCILE_BATCH) break charges;
      out.chargesChecked++;
      try {
        const q = await deps.gateway.queryTransaction({ merchantOrderNo }).catch((e: unknown) => ({ error: errorText(e) }));
        if ("error" in q || q.status !== "succeeded" || !q.providerRef || q.amount === undefined) continue;
        // Exactly as a verified notice: the first paid attempt settles the booking (or takes the late-payment path of
        // an expired one); any further paid attempt is a stray charge, refunded once (keyed by its provider ref).
        const notice = { reservationCode: b.code, providerRef: q.providerRef, amount: q.amount, status: "succeeded" as const, merchantOrderNo };
        await applyPaymentNotice(deps, notice, JSON.stringify({ source: "gateway_reconcile", merchantOrderNo, query: q }), now);
        // A real notice may have recorded this charge first, without its order number: note it, so it is not asked again.
        await deps.db.update(payments).set({ merchantOrderNo })
          .where(and(eq(payments.providerRef, q.providerRef), eq(payments.kind, "charge"), isNull(payments.merchantOrderNo)));
        out.chargesApplied++;
      } catch (e) {
        console.error(`gateway reconcile: charge ${merchantOrderNo} failed`, e);
      }
    }
  }
  return out;
}
