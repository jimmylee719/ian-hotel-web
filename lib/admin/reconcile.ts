import { and, desc, eq, exists, sql } from "drizzle-orm";
import { countsAsBookingRefund, finishRefundAndFail, refundOnce, type RefundAndFailKinds } from "@/lib/booking/confirm";
import { cancelConfirmed, cancelKey } from "@/lib/booking/manage";
import { refundableCharges, type Deps } from "@/lib/booking/notify";
import { runAtomic } from "@/lib/db/atomic";
import { hasSqliteError } from "@/lib/db/inventory-hold";
import { auditLog, payments, reservations } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { todayInTaipei } from "@/lib/domain/dates";
import { recordAudit, type AuditEntry } from "./audit";
import type { StaffContext } from "./auth";
import { looksLikeCardNumber } from "./front-desk";
import { can } from "./permissions";

export type RefundListRow = {
  id: string; reservationId: string; code: string; amount: number; createdAt: number; idempotencyKey: string | null;
};

/**
 * Refund rows of one property in `status` (default `pending`: the outcome is unknown and needs staff to check
 * the bank), oldest first. `failed` lists the ones that can be retried.
 */
export async function listPendingRefunds(db: Db, propertyId: string, status: "pending" | "failed" = "pending"): Promise<RefundListRow[]> {
  return db.select({
    id: payments.id, reservationId: payments.reservationId, code: reservations.code, amount: payments.amount,
    createdAt: payments.createdAt, idempotencyKey: payments.idempotencyKey,
  }).from(payments)
    .innerJoin(reservations, eq(reservations.id, payments.reservationId))
    .where(and(eq(reservations.propertyId, propertyId), eq(payments.kind, "refund"), eq(payments.status, status)))
    .orderBy(status === "pending" ? payments.createdAt : desc(payments.createdAt), payments.id);
}

type ReservationStatus = typeof reservations.$inferSelect["status"];

/** How the hotel paid a refund back itself when the gateway would not (settle_offline). */
export const OFFLINE_REFUND_METHODS = ["transfer", "cash", "edc"] as const;
export type OfflineRefundMethod = (typeof OFFLINE_REFUND_METHODS)[number];
const OFFLINE_METHOD_LABEL: Record<OfflineRefundMethod, string> = { transfer: "匯款", cash: "現金", edc: "刷卡機退刷" };
/** Longest settle_offline reference. */
export const OFFLINE_REFERENCE_MAX = 200;

export type ReconcileAction =
  | { kind: "mark_succeeded"; providerRef: string }
  | { kind: "mark_failed" }
  | { kind: "retry" }
  | { kind: "settle_offline"; reference: string; method: OfflineRefundMethod };

export type ReconcileResult =
  | {
      ok: true; status: "succeeded" | "failed";
      /** The flow this refund was waiting on and that this call finished, or null (nothing to finish, or not finishable yet). */
      completed: "cancellation" | "refund_and_fail" | null;
      /** The booking's status after the call. */
      reservationStatus: ReservationStatus;
      /**
       * settle_offline only: the gateway reported the refund made after all, so its result settled the row and
       * the offline entry was NOT used (the hotel should check it did not also pay the guest back itself).
       */
      settledByGateway?: true;
    }
  | {
      ok: false;
      error: "NOT_FOUND" | "FORBIDDEN" | "ALREADY_RESOLVED" | "NOT_FAILED" | "PROVIDER_REF_REQUIRED" | "DUPLICATE_PROVIDER_REF" | "REFUND_FAILED"
        | "REFERENCE_REQUIRED" | "INVALID_REFERENCE" | "LOOKS_LIKE_CARD_NUMBER" | "PAYMENTS_UNAVAILABLE";
    };


/**
 * Settle a refund row by hand (needs `payments.reconcile` at the booking's property; another property's row is NOT_FOUND).
 * - `mark_succeeded` (staff confirmed with the bank): pending → succeeded with the bank's reference, the amount
 *   added to refundedAmount and the audit row, all in one batch and only while the row is still pending; then the
 *   flow it belonged to is finished (finishFlow): a still-confirmed booking's cancellation (`cancel:`) through the
 *   cancel core, a failed booking (`fail:`) through refundAndFail's remaining steps. A second call is ALREADY_RESOLVED.
 * - `mark_failed`: pending → failed, nothing else; it is not retried automatically.
 * - `retry`: only a failed row (a succeeded one is ALREADY_RESOLVED); refundOnce again under the row's own key (the gateway's idempotency key), then
 *   finishes the flow as above.
 * - `settle_offline`: a failed or pending row the gateway will never take (e.g. its refund window has passed), that
 *   the hotel paid back itself by transfer, cash or card terminal. For a pending row the gateway is asked first
 *   (queryRefund): if it made the refund after all, the row is settled with the gateway's ref instead (no note, the
 *   audit row says `outcome: "gateway_succeeded"`) and the result says `settledByGateway`. The reference (1–200 characters, never something
 *   that looks like a card number) is required. Like mark_succeeded, in one batch guarded by the row's status as
 *   read: the row → succeeded with providerRef `offline:<reference>` and a note saying how, refundedAmount bumped
 *   for `cancel:` / `fail:` rows, the audit row; then finishFlow. A settled `modify:` row stops blocking cancels and
 *   further modifications. The row keeps its online method on purpose: it still reverses the ONLINE charge (the
 *   money the gateway took), so the money module counts it against onlineNet, not the desk; how the cash actually
 *   moved is in the note and the audit row.
 */
export async function reconcileRefund(
  deps: Deps, ctx: StaffContext, paymentId: string, action: ReconcileAction, now: Date,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const { db } = deps;
  if (!can(ctx.staff, "payments.reconcile")) return { ok: false, error: "FORBIDDEN" };
  const [found] = await db.select({ p: payments, propertyId: reservations.propertyId }).from(payments)
    .innerJoin(reservations, eq(reservations.id, payments.reservationId))
    .where(and(eq(payments.id, paymentId), eq(payments.kind, "refund")));
  if (!found || !can(ctx.staff, "payments.reconcile", found.propertyId)) return { ok: false, error: "NOT_FOUND" };
  const row = found.p;
  const gateway = !opts.paymentsUnavailable;
  if (!gateway && action.kind !== "settle_offline") return { ok: false, error: "PAYMENTS_UNAVAILABLE" };
  const audit = (after: Record<string, unknown>): AuditEntry => ({
    action: "payment.reconcile", entity: "payment", entityId: row.id,
    before: { status: row.status, providerRef: row.providerRef }, after: { kind: action.kind, ...after },
  });

  if (action.kind === "retry") {
    if (row.status === "succeeded") return { ok: false, error: "ALREADY_RESOLVED" };
    if (row.status !== "failed") return { ok: false, error: "NOT_FAILED" };
    const charge = (await refundableCharges(db, row.reservationId)).find((c) => c.id === row.refundOf);
    const r = charge && row.idempotencyKey
      ? await refundOnce(deps, row.idempotencyKey, charge, row.amount, "STAFF_RETRY", now, { countsAsBookingRefund: countsAsBookingRefund(row.idempotencyKey) })
      : { ok: false as const, error: "NO_REFUNDABLE_CHARGE" };
    await recordAudit(db, ctx, audit({ outcome: r.ok ? "succeeded" : r.error }), now);
    if (!r.ok) return { ok: false, error: "REFUND_FAILED" };
    return { ok: true, status: "succeeded", ...await finishFlow(deps, row.idempotencyKey, row.reservationId, now) };
  }

  let providerRef: string | null = null;
  let note: string | undefined;
  let extra: Record<string, unknown> = {};
  let settledByGateway = false;
  if (action.kind === "settle_offline") {
    if (row.status === "succeeded") return { ok: false, error: "ALREADY_RESOLVED" };
    const reference = action.reference.trim();
    if (!reference) return { ok: false, error: "REFERENCE_REQUIRED" };
    if (reference.length > OFFLINE_REFERENCE_MAX || !OFFLINE_REFUND_METHODS.includes(action.method)) return { ok: false, error: "INVALID_REFERENCE" };
    if (looksLikeCardNumber(reference)) return { ok: false, error: "LOOKS_LIKE_CARD_NUMBER" };
    // A pending row's refund may still have been made by the gateway: ask first. If it was, the gateway's
    // result settles the row and the hotel's offline entry is not used (staff are told: the guest may now
    // have been paid twice, by the gateway and by the hotel).
    // Without a gateway there is no one to ask: the dialog's warning covers it.
    const made = gateway && row.status === "pending" ? await gatewayMadeRefund(deps, row.idempotencyKey) : null;
    if (made) {
      settledByGateway = true;
      providerRef = made.refundRef;
      extra = { method: action.method, reference, outcome: "gateway_succeeded" };
    } else {
      providerRef = `offline:${reference}`;
      note = `線下退款（${OFFLINE_METHOD_LABEL[action.method]}）：${reference}`;
      extra = { method: action.method, reference };
    }
  } else {
    if (row.status !== "pending") return { ok: false, error: "ALREADY_RESOLVED" };
    providerRef = action.kind === "mark_succeeded" ? action.providerRef.trim() : null;
    if (action.kind === "mark_succeeded" && !providerRef) return { ok: false, error: "PROVIDER_REF_REQUIRED" };
  }
  const settles = action.kind !== "mark_failed";

  // Every statement is guarded by "still in the status read" (pending, or failed for settle_offline), checked before
  // the last one settles the row, so of two concurrent calls only one bumps refundedAmount and writes its audit row.
  const fromStatus = row.status;
  const unchanged = exists(db.select({ one: sql`1` }).from(payments).where(and(eq(payments.id, row.id), eq(payments.status, fromStatus))));
  const auditId = crypto.randomUUID();
  const entry = audit({ ...extra, ...(providerRef ? { providerRef } : {}) });
  const stmts = [
    db.insert(auditLog).select(sql`select ${auditId}, ${ctx.email}, ${entry.action}, ${entry.entity}, ${entry.entityId},
      ${JSON.stringify(entry.before)}, ${JSON.stringify(entry.after)}, ${now.getTime()} where ${unchanged}`),
    ...(settles && countsAsBookingRefund(row.idempotencyKey)
      ? [db.update(reservations).set({ refundedAmount: sql`${reservations.refundedAmount} + ${row.amount}` })
        .where(and(eq(reservations.id, row.reservationId), unchanged))]
      : []),
    db.update(payments)
      .set(settles ? { status: "succeeded", providerRef, settledAt: now.getTime(), ...(note ? { note } : {}) } : { status: "failed" })
      .where(and(eq(payments.id, row.id), eq(payments.status, fromStatus))),
  ];
  try {
    await runAtomic(db, stmts);
  } catch (e) {
    if (hasSqliteError(e, "UNIQUE constraint failed")) return { ok: false, error: "DUPLICATE_PROVIDER_REF" };
    throw e;
  }
  const [won] = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.id, auditId));
  if (!won) return { ok: false, error: "ALREADY_RESOLVED" };
  if (action.kind === "mark_failed") return { ok: true, status: "failed", completed: null, reservationStatus: await statusOf(db, row.reservationId) };
  return {
    ok: true, status: "succeeded", ...await finishFlow(deps, row.idempotencyKey, row.reservationId, now, { gatewayAvailable: gateway }),
    ...(settledByGateway ? { settledByGateway: true as const } : {}),
  };
}

export type ReconcileOptions = {
  /**
   * No payment gateway / channel is configured (deps are the offline ones): only `settle_offline` runs, without
   * asking the gateway first; every other action is PAYMENTS_UNAVAILABLE.
   */
  paymentsUnavailable?: boolean;
};

/** The gateway's refund ref if it reports the refund under `key` as made; null if it says otherwise or cannot say. */
async function gatewayMadeRefund(deps: Deps, key: string | null): Promise<{ refundRef: string | null } | null> {
  if (!key) return null;
  const q = await deps.gateway.queryRefund(key).catch(() => null);
  return q && !("error" in q) && q.status === "succeeded" ? { refundRef: q.refundRef ?? null } : null;
}

async function statusOf(db: Db, reservationId: string): Promise<ReservationStatus> {
  const [r] = await db.select({ status: reservations.status }).from(reservations).where(eq(reservations.id, reservationId));
  return r.status;
}

/**
 * Now that a refund is settled, finish the flow that was waiting on it, if any:
 * - `cancel:<id>`: such a refund only ever pays back a cancellation, so a booking still `confirmed` must end
 *   cancelled, whether or not its claim survived (a definitive gateway refusal drops it) and even inside the
 *   original request's lease (that request already gave up with an unknown outcome). The cancel core re-takes
 *   the claim with `cancelledAt = coalesce(cancelledAt, <intent created>)`, so the cancellation keeps its
 *   original time; the intent fixes the amount and whether the guest is emailed; nights are released from today on (the staff rule).
 * - `fail:<id>:<charge>` of a failed booking (paid_pending_confirm, syncState failed) → refundAndFail's rest,
 *   with the booking's original failure reason so its emails and any new error keep it.
 *   With `gatewayAvailable: false` this happens only if no other charge is still to be refunded.
 * A booking in any other state is left alone; the result reports its status.
 * Also run by the gateway reconcile job after it settles a pending refund the gateway reports made.
 */
export async function finishFlow(
  deps: Deps, key: string | null, reservationId: string, now: Date, o: { gatewayAvailable?: boolean } = {},
): Promise<{ completed: "cancellation" | "refund_and_fail" | null; reservationStatus: ReservationStatus }> {
  const { db } = deps;
  const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  let completed: "cancellation" | "refund_and_fail" | null = null;
  if (key === cancelKey(res.id) && res.status === "confirmed") {
    const [intent] = await db.select().from(payments).where(eq(payments.idempotencyKey, key));
    if (intent?.status === "succeeded") {
      const r = await cancelConfirmed(deps, res.id, now, {
        reason: "RECONCILED", releaseFrom: todayInTaipei(now), takeOverAt: intent.createdAt,
        notifyGuest: intent.notifyGuest !== false, // the cancel's own choice (a staff cancel may have said no)
      });
      if (r.ok && !r.alreadyCancelled) completed = "cancellation";
    }
  } else if (key?.startsWith(`fail:${res.id}:`) && res.status === "paid_pending_confirm" && res.syncState === "failed") {
    const reason = originalFailReason(res.lastSyncError);
    // Without a gateway, finishing must not start refunds of other charges (they could only end up pending).
    const blocked = o.gatewayAvailable === false && (await refundableCharges(db, res.id)).some((c) => c.remaining > 0);
    if (!blocked && await finishRefundAndFail(deps, res, reason, now, failKinds(reason))) completed = "refund_and_fail";
  }
  return { completed, reservationStatus: await statusOf(db, reservationId) };
}

/**
 * refundAndFail's own reason (AMOUNT_MISMATCH: …, SOLD_OUT_AFTER_EXPIRY, a channel error), unwrapped from the
 * "REFUND_FAILED: <error> (<reason>)" it records on each failed refund, however many times it was wrapped.
 */
export function originalFailReason(lastSyncError: string | null): string {
  let e = lastSyncError ?? "";
  const wrapped = /^REFUND_FAILED: [^]*? \(([^]*)\)$/;
  for (let m = wrapped.exec(e); m; m = wrapped.exec(e)) e = m[1];
  return e || "RECONCILED";
}

/**
 * Which emails refundAndFail was going to send, from its original reason, as confirmWithChannel chooses them.
 */
function failKinds(reason: string): RefundAndFailKinds {
  const e = reason;
  if (e.includes("AMOUNT_MISMATCH")) return { guestKind: "payment_refunded", staffKind: "staff_payment_alert" };
  if (e.includes("SOLD_OUT_AFTER_EXPIRY")) return { guestKind: "booking_failed_refunded", staffKind: "staff_payment_alert" };
  return { guestKind: "booking_failed_refunded", staffKind: "staff_sync_failed" };
}
