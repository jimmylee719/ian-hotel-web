import { and, asc, desc, eq, gt, gte, isNotNull, isNull, like, lte, ne, notExists, or, sql } from "drizzle-orm";
import { alias, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import { finishFlow } from "@/lib/admin/reconcile";
import { countsAsBookingRefund, markRefundFailed, settleRefundRow, type PaymentRow } from "@/lib/booking/confirm";
import { notifyStaff, type Deps } from "@/lib/booking/notify";
import { applyPaymentNotice } from "@/lib/booking/payment-notice";
import { payments, reservations } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { CallBudget, type StoppedEarly } from "./budget";

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
/** A run stops issuing gateway calls this long after it started (well under its 15-minute interval). */
export const GATEWAY_RECONCILE_BUDGET_MS = 10 * 60_000;

/** The staff alert's ref for a refund row this job found failed: one email per row. */
export const REFUND_FAILED_REF = "refund-failed:";

/** The staff alert's ref for a settled refund whose flow could not be finished: one email per row. */
export const FLOW_UNFINISHED_REF = "flow-unfinished:";

export type GatewayReconcileResult = {
  refundsChecked: number; refundsSettled: number; refundsFailed: number; refundsUnresolved: number;
  /** Bookings the sweep's finishFlow completed (flowsFinished) or threw on (flowsFailed). */
  flowsFinished: number; flowsFailed: number;
  chargesChecked: number; chargesApplied: number;
  /** Set when the run stopped issuing gateway calls early: its wall-clock budget ran out, or too many errors in a row. */
  stoppedEarly?: StoppedEarly;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Every 15 minutes: ask the gateway about money whose outcome is still unknown here, and apply what it says
 * through the same guarded paths as the live flow. It never calls gateway.refund itself.
 * - Refund rows `pending` for over 10 minutes → queryRefund(idempotencyKey):
 *   succeeded → settled as refundOnce settles it (settleRefundRow), then the flow waiting on it is finished as
 *   refund reconciliation finishes it (finishFlow: a cancellation completes, a failed booking is refunded and
 *   closed); failed → marked failed (pending → failed only), staff emailed once per row (staff_payment_alert) and
 *   the dashboard's refund_failed alert raised while the row is still the booking's open intent; not_found, pending
 *   or no answer → left pending for staff (the dashboard's refund_pending alert).
 * - Bookings whose latest payment attempt started under a day ago (any status) → queryTransaction for each
 *   attempt `<code>-1 … <code>-<chargeAttempt>` not yet recorded as a charge (the latest only once 10 minutes old),
 *   newest bookings first, every run for the first hour and hourly after that;
 *   succeeded → applied exactly like a verified notice (applyPaymentNotice: dedupe, amount check, re-hold, channel
 *   push, stray refund of a second payment); the charge row then carries its order number and is not asked about
 *   again. Anything else changes nothing.
 * - Succeeded `cancel:<id>` refunds whose booking is still `confirmed`, and succeeded `fail:<id>:…` refunds whose
 *   booking is still `paid_pending_confirm` with syncState failed, settled over 10 minutes ago (a flow that died
 *   after its refund settled: a live cancel, a refundAndFail, or this job's own finishFlow) → finishFlow again;
 *   a flow that throws emails staff once per row and is tried again next run. A failed booking with another
 *   `fail:` refund failed or pending is left to staff (never re-refunded here). flowsFinished counts completions.
 * One item failing is logged and counted as unresolved; it never stops the others. The run stops issuing gateway
 * calls 10 minutes after it started, or after 5 errors in a row (lib/jobs/budget.ts), and records `stoppedEarly`;
 * what it did not reach waits for the next run.
 */
export async function runGatewayReconcile(
  deps: Deps, now: Date, o: { clock?: () => number } = {},
): Promise<GatewayReconcileResult> {
  const budget = new CallBudget(GATEWAY_RECONCILE_BUDGET_MS, o.clock);
  const out: GatewayReconcileResult = {
    refundsChecked: 0, refundsSettled: 0, refundsFailed: 0, refundsUnresolved: 0, flowsFinished: 0, flowsFailed: 0,
    chargesChecked: 0, chargesApplied: 0,
  };
  const due = now.getTime() - GATEWAY_RECONCILE_AFTER_MS;

  const refunds = await deps.db.select().from(payments)
    .where(and(eq(payments.kind, "refund"), eq(payments.status, "pending"), lte(payments.createdAt, due)))
    .orderBy(asc(payments.createdAt), asc(payments.id))
    .limit(GATEWAY_RECONCILE_BATCH);
  for (const row of refunds) {
    if (!row.idempotencyKey) continue;
    if (!budget.canCall()) break;
    out.refundsChecked++;
    try {
      const q = await deps.gateway.queryRefund(row.idempotencyKey).catch((e: unknown) => ({ error: errorText(e) }));
      budget.record(!("error" in q));
      // Only a definite answer changes the row. not_found is not one here: the gateway may simply not show the
      // refund (yet), so the row stays pending for staff to check with the bank (the refund_pending alert).
      if ("error" in q || q.status === "pending" || q.status === "not_found") {
        out.refundsUnresolved++;
        continue;
      }
      if (q.status === "succeeded") {
        await settleRefundRow(deps.db, row, q.refundRef ?? null, countsAsBookingRefund(row.idempotencyKey), now);
        out.refundsSettled++;
        // If finishing throws, the row is settled all the same: the sweep below finishes it on a later run.
        // A failed booking with another fail: refund failed or pending is left to staff, as in the sweep.
        const leftToStaff = row.idempotencyKey.startsWith("fail:")
          && (await openFailRefunds(deps.db, row.reservationId).limit(1)).length > 0;
        if (!leftToStaff) await finishOrAlert(deps, row, now);
      } else {
        await markRefundFailed(deps.db, row.id);
        // The refund_pending alert goes with the pending row: tell staff (once per row) and let the dashboard's
        // refund_failed alert carry it until the row is retried or settled by hand.
        await notifyStaff(deps, row.reservationId, "staff_payment_alert", now, {}, `${REFUND_FAILED_REF}${row.id}`);
        out.refundsFailed++;
      }
    } catch (e) {
      console.error(`gateway reconcile: refund ${row.id} failed`, e);
      out.refundsUnresolved++;
    }
  }

  // Self-healing: a refund settled (by this job, a live request or staff) whose flow then died — guest refunded,
  // booking still holding the room. Only rows settled over GATEWAY_RECONCILE_AFTER_MS ago, so a live cancel or
  // refundAndFail that has just settled its refund and is finishing right now is never raced. finishFlow is
  // guarded (status as expected, intent succeeded) and safe to run again.
  // A failed booking is finished only while none of its other `fail:` refunds is failed or pending: finishing would
  // refund those again (refundOnce reopens a failed row), and a refund the gateway refused is staff's to retry or
  // settle offline (it already carries the sync_failed and refund alerts) — never retried unattended here.
  // One row per booking (a failed booking may have several), newest first, so bookings that never finish cannot
  // starve a newer orphan out of the batch.
  const settledBefore = now.getTime() - GATEWAY_RECONCILE_AFTER_MS;
  const settled = sql<number>`max(coalesce(${payments.settledAt}, ${payments.createdAt}))`;
  const orphans = await deps.db.select({
    reservationId: payments.reservationId,
    id: sql<string>`min(${payments.id})`, idempotencyKey: sql<string>`min(${payments.idempotencyKey})`,
  }).from(payments)
    .innerJoin(reservations, eq(reservations.id, payments.reservationId))
    .where(and(
      eq(payments.kind, "refund"), eq(payments.status, "succeeded"),
      lte(sql`coalesce(${payments.settledAt}, ${payments.createdAt})`, settledBefore),
      or(
        and(eq(reservations.status, "confirmed"), eq(payments.idempotencyKey, sql`'cancel:' || ${reservations.id}`)),
        and(
          eq(reservations.status, "paid_pending_confirm"), eq(reservations.syncState, "failed"),
          like(payments.idempotencyKey, sql`'fail:' || ${reservations.id} || ':%'`),
          notExists(openFailRefunds(deps.db, reservations.id)),
        ),
      ),
    ))
    .groupBy(payments.reservationId)
    .orderBy(desc(settled), asc(payments.reservationId))
    .limit(GATEWAY_RECONCILE_BATCH);
  for (const row of orphans) {
    if (!budget.canCall()) break; // finishing may refund and call the channel
    const r = await finishOrAlert(deps, row, now);
    if (r === "threw") { out.flowsFailed++; budget.record(false); }
    else if (r === "completed") { out.flowsFinished++; budget.record(true); }
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
      if (out.chargesChecked >= GATEWAY_RECONCILE_BATCH || !budget.canCall()) break charges;
      out.chargesChecked++;
      try {
        const q = await deps.gateway.queryTransaction({ merchantOrderNo }).catch((e: unknown) => ({ error: errorText(e) }));
        budget.record(!("error" in q));
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
  if (budget.stoppedEarly) out.stoppedEarly = budget.stoppedEarly;
  return out;
}

/**
 * finishFlow for a settled refund row. Never throws: a failure is logged and staff are emailed once per row
 * (staff_payment_alert, ref FLOW_UNFINISHED_REF + row id); the sweep tries again on later runs.
 * "completed" when finishFlow finished the flow, "unfinished" when it ran but left the booking as it was.
 */
async function finishOrAlert(
  deps: Deps, row: Pick<PaymentRow, "id" | "idempotencyKey" | "reservationId">, now: Date,
): Promise<"completed" | "unfinished" | "threw"> {
  try {
    const r = await finishFlow(deps, row.idempotencyKey, row.reservationId, now);
    return r.completed ? "completed" : "unfinished";
  } catch (e) {
    console.error(`gateway reconcile: finishing the flow of refund ${row.id} failed`, e);
    await notifyStaff(deps, row.reservationId, "staff_payment_alert", now, {}, `${FLOW_UNFINISHED_REF}${row.id}`);
    return "threw";
  }
}

const sibling = alias(payments, "sibling");

/**
 * The booking's `fail:` refunds that are failed or pending, as a subquery (one row each). While any exists, this
 * job never finishes the failed booking: finishing would reopen a refused refund at the gateway (refundOnce flips
 * failed → pending), which is staff's to retry or settle offline. Shared by the refund loop and the sweep.
 * `reservationId` is a column (correlated, in the sweep) or an id.
 */
function openFailRefunds(db: Db, reservationId: SQLiteColumn | string) {
  return db.select({ one: sql`1` }).from(sibling).where(and(
    eq(sibling.reservationId, reservationId), eq(sibling.kind, "refund"),
    like(sibling.idempotencyKey, sql`'fail:' || ${reservationId} || ':%'`), ne(sibling.status, "succeeded"),
  ));
}
