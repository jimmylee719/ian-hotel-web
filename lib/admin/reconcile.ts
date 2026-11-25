import { and, desc, eq, exists, sql } from "drizzle-orm";
import { finishRefundAndFail, refundOnce, type RefundAndFailKinds } from "@/lib/booking/confirm";
import { cancelConfirmed, cancelKey } from "@/lib/booking/manage";
import { refundableCharges, type Deps } from "@/lib/booking/notify";
import { runAtomic } from "@/lib/db/atomic";
import { hasSqliteError } from "@/lib/db/inventory-hold";
import { auditLog, payments, reservations } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { todayInTaipei } from "@/lib/domain/dates";
import { recordAudit, type AuditEntry } from "./audit";
import type { StaffContext } from "./auth";
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

export type ReconcileAction = { kind: "mark_succeeded"; providerRef: string } | { kind: "mark_failed" } | { kind: "retry" };

export type ReconcileResult =
  | {
      ok: true; status: "succeeded" | "failed";
      /** The flow this refund was waiting on and that this call finished, or null (nothing to finish, or not finishable yet). */
      completed: "cancellation" | "refund_and_fail" | null;
      /** The booking's status after the call. */
      reservationStatus: ReservationStatus;
    }
  | {
      ok: false;
      error: "NOT_FOUND" | "FORBIDDEN" | "ALREADY_RESOLVED" | "NOT_FAILED" | "PROVIDER_REF_REQUIRED" | "DUPLICATE_PROVIDER_REF" | "REFUND_FAILED";
    };

/** Refunds that count toward the booking's refundedAmount (as refundOnce is told for them); stray-charge refunds do not. */
const countsAsBookingRefund = (key: string | null) => !!key && (key.startsWith("cancel:") || key.startsWith("fail:"));

/**
 * Settle a refund row by hand (needs `payments.reconcile` at the booking's property; another property's row is NOT_FOUND).
 * - `mark_succeeded` (staff confirmed with the bank): pending → succeeded with the bank's reference, the amount
 *   added to refundedAmount and the audit row, all in one batch and only while the row is still pending; then the
 *   flow it belonged to is finished (finishFlow): a still-confirmed booking's cancellation (`cancel:`) through the
 *   cancel core, a failed booking (`fail:`) through refundAndFail's remaining steps. A second call is ALREADY_RESOLVED.
 * - `mark_failed`: pending → failed, nothing else; it is not retried automatically.
 * - `retry`: only a failed row (a succeeded one is ALREADY_RESOLVED); refundOnce again under the row's own key (the gateway's idempotency key), then
 *   finishes the flow as above.
 */
export async function reconcileRefund(
  deps: Deps, ctx: StaffContext, paymentId: string, action: ReconcileAction, now: Date,
): Promise<ReconcileResult> {
  const { db } = deps;
  if (!can(ctx.staff, "payments.reconcile")) return { ok: false, error: "FORBIDDEN" };
  const [found] = await db.select({ p: payments, propertyId: reservations.propertyId }).from(payments)
    .innerJoin(reservations, eq(reservations.id, payments.reservationId))
    .where(and(eq(payments.id, paymentId), eq(payments.kind, "refund")));
  if (!found || !can(ctx.staff, "payments.reconcile", found.propertyId)) return { ok: false, error: "NOT_FOUND" };
  const row = found.p;
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

  if (row.status !== "pending") return { ok: false, error: "ALREADY_RESOLVED" };
  const providerRef = action.kind === "mark_succeeded" ? action.providerRef.trim() : null;
  if (action.kind === "mark_succeeded" && !providerRef) return { ok: false, error: "PROVIDER_REF_REQUIRED" };

  // Every statement is guarded by "still pending", checked before the last one settles the row, so of two
  // concurrent calls only one bumps refundedAmount and writes its audit row.
  const stillPending = exists(db.select({ one: sql`1` }).from(payments).where(and(eq(payments.id, row.id), eq(payments.status, "pending"))));
  const auditId = crypto.randomUUID();
  const entry = audit(providerRef ? { providerRef } : {});
  const stmts = [
    db.insert(auditLog).select(sql`select ${auditId}, ${ctx.email}, ${entry.action}, ${entry.entity}, ${entry.entityId},
      ${JSON.stringify(entry.before)}, ${JSON.stringify(entry.after)}, ${now.getTime()} where ${stillPending}`),
    ...(action.kind === "mark_succeeded" && countsAsBookingRefund(row.idempotencyKey)
      ? [db.update(reservations).set({ refundedAmount: sql`${reservations.refundedAmount} + ${row.amount}` })
        .where(and(eq(reservations.id, row.reservationId), stillPending))]
      : []),
    db.update(payments)
      .set(action.kind === "mark_succeeded" ? { status: "succeeded", providerRef } : { status: "failed" })
      .where(and(eq(payments.id, row.id), eq(payments.status, "pending"))),
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
  return { ok: true, status: "succeeded", ...await finishFlow(deps, row.idempotencyKey, row.reservationId, now) };
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
 *   original time; the intent fixes the amount; nights are released from today on (the staff rule).
 * - `fail:<id>:<charge>` of a failed booking (paid_pending_confirm, syncState failed) → refundAndFail's rest,
 *   with the booking's original failure reason so its emails and any new error keep it.
 * A booking in any other state is left alone; the result reports its status.
 */
async function finishFlow(
  deps: Deps, key: string | null, reservationId: string, now: Date,
): Promise<{ completed: "cancellation" | "refund_and_fail" | null; reservationStatus: ReservationStatus }> {
  const { db } = deps;
  const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  let completed: "cancellation" | "refund_and_fail" | null = null;
  if (key === cancelKey(res.id) && res.status === "confirmed") {
    const [intent] = await db.select().from(payments).where(eq(payments.idempotencyKey, key));
    if (intent?.status === "succeeded") {
      const r = await cancelConfirmed(deps, res.id, now, {
        reason: "RECONCILED", releaseFrom: todayInTaipei(now), takeOverAt: intent.createdAt,
      });
      if (r.ok && !r.alreadyCancelled) completed = "cancellation";
    }
  } else if (key?.startsWith(`fail:${res.id}:`) && res.status === "paid_pending_confirm" && res.syncState === "failed") {
    const reason = originalFailReason(res.lastSyncError);
    if (await finishRefundAndFail(deps, res, reason, now, failKinds(reason))) completed = "refund_and_fail";
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
