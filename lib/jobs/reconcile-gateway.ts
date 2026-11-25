import { and, asc, eq, gt, gte, inArray, lte } from "drizzle-orm";
import { finishFlow } from "@/lib/admin/reconcile";
import { countsAsBookingRefund, markRefundFailed, settleRefundRow } from "@/lib/booking/confirm";
import type { Deps } from "@/lib/booking/notify";
import { applyPaymentNotice } from "@/lib/booking/payment-notice";
import { payments, reservations } from "@/lib/db/schema";

/** A payment or refund is asked about once it has been pending this long (the gateway's own calls time out far sooner). */
export const GATEWAY_RECONCILE_AFTER_MS = 10 * 60_000;
/** A payment started longer ago than this is no longer asked about (an abandoned payment page). */
export const CHARGE_LOOKBACK_MS = 24 * 3600_000;
/** At most this many charges and this many refunds per run. */
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
 * - Payments started over 10 minutes (and under a day) ago whose notice never came (booking still
 *   pending_payment or expired) → queryTransaction(the latest attempt's merchantOrderNo); succeeded → applied
 *   exactly like a verified notice (applyPaymentNotice: dedupe, amount check, re-hold, channel push); anything
 *   else changes nothing.
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
        await settleRefundRow(deps.db, row, q.refundRef ?? null, countsAsBookingRefund(row.idempotencyKey));
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

  const charges = await deps.db.select({ code: reservations.code, attempt: reservations.chargeAttempt }).from(reservations)
    .where(and(
      eq(reservations.channel, "direct"), inArray(reservations.status, ["pending_payment", "expired"]),
      gt(reservations.chargeAttempt, 0),
      lte(reservations.lastChargeStartedAt, due), gte(reservations.lastChargeStartedAt, now.getTime() - CHARGE_LOOKBACK_MS),
    ))
    .orderBy(asc(reservations.lastChargeStartedAt), asc(reservations.id))
    .limit(GATEWAY_RECONCILE_BATCH);
  for (const { code, attempt } of charges) {
    out.chargesChecked++;
    try {
      const merchantOrderNo = `${code}-${attempt}`;
      const q = await deps.gateway.queryTransaction({ merchantOrderNo }).catch((e: unknown) => ({ error: errorText(e) }));
      if ("error" in q || q.status !== "succeeded" || !q.providerRef || q.amount === undefined) continue;
      const notice = { reservationCode: code, providerRef: q.providerRef, amount: q.amount, status: "succeeded" as const };
      await applyPaymentNotice(deps, notice, JSON.stringify({ source: "gateway_reconcile", merchantOrderNo, query: q }), now);
      out.chargesApplied++;
    } catch (e) {
      console.error(`gateway reconcile: charge of ${code} failed`, e);
    }
  }
  return out;
}
