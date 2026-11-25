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

export type ReconcileAction = { kind: "mark_succeeded"; providerRef: string } | { kind: "mark_failed" } | { kind: "retry" };

export type ReconcileResult =
  | { ok: true; status: "succeeded" | "failed"; completed: "cancellation" | "refund_and_fail" | null }
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
 *   flow it belonged to is finished: a claimed cancellation (`cancel:`) is completed through the cancel core, a
 *   failed booking (`fail:`) through refundAndFail's remaining steps. A second call is ALREADY_RESOLVED.
 * - `mark_failed`: pending → failed, nothing else; it is not retried automatically.
 * - `retry`: only a failed row; refundOnce again under the row's own key (the gateway's idempotency key), then
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
    if (row.status !== "failed") return { ok: false, error: "NOT_FAILED" };
    const charge = (await refundableCharges(db, row.reservationId)).find((c) => c.id === row.refundOf);
    const r = charge && row.idempotencyKey
      ? await refundOnce(deps, row.idempotencyKey, charge, row.amount, "STAFF_RETRY", now, { countsAsBookingRefund: countsAsBookingRefund(row.idempotencyKey) })
      : { ok: false as const, error: "NO_REFUNDABLE_CHARGE" };
    await recordAudit(db, ctx, audit({ outcome: r.ok ? "succeeded" : r.error }), now);
    if (!r.ok) return { ok: false, error: "REFUND_FAILED" };
    return { ok: true, status: "succeeded", completed: await finishFlow(deps, row.idempotencyKey, row.reservationId, now) };
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
  if (action.kind === "mark_failed") return { ok: true, status: "failed", completed: null };
  return { ok: true, status: "succeeded", completed: await finishFlow(deps, row.idempotencyKey, row.reservationId, now) };
}

/**
 * Now that a refund is settled, finish the flow that was waiting on it, if any:
 * - `cancel:<id>` of a claimed cancellation (cancelledAt set, still confirmed) → the cancel core completes it
 *   (transition, release from today on, channel cancel, emails). If the original request still holds a fresh
 *   claim, it finishes the cancellation itself and this returns null.
 * - `fail:<id>:<charge>` of a failed booking (paid_pending_confirm, syncState failed) → refundAndFail's rest.
 */
async function finishFlow(deps: Deps, key: string | null, reservationId: string, now: Date): Promise<"cancellation" | "refund_and_fail" | null> {
  const [res] = await deps.db.select().from(reservations).where(eq(reservations.id, reservationId));
  if (key === cancelKey(res.id) && res.status === "confirmed" && res.cancelledAt != null) {
    const r = await cancelConfirmed(deps, res.id, now, { reason: "RECONCILED", releaseFrom: todayInTaipei(now) });
    return r.ok && !r.alreadyCancelled ? "cancellation" : null;
  }
  if (key?.startsWith(`fail:${res.id}:`) && res.status === "paid_pending_confirm" && res.syncState === "failed")
    return await finishRefundAndFail(deps, res, "RECONCILED", now, failKinds(res.lastSyncError)) ? "refund_and_fail" : null;
  return null;
}

/**
 * Which emails refundAndFail was going to send, recovered from the reason it recorded (lastSyncError keeps it,
 * e.g. "REFUND_FAILED: … (AMOUNT_MISMATCH: …)"), as confirmWithChannel chooses them.
 */
function failKinds(lastSyncError: string | null): RefundAndFailKinds {
  const e = lastSyncError ?? "";
  if (e.includes("AMOUNT_MISMATCH")) return { guestKind: "payment_refunded", staffKind: "staff_payment_alert" };
  if (e.includes("SOLD_OUT_AFTER_EXPIRY")) return { guestKind: "booking_failed_refunded", staffKind: "staff_payment_alert" };
  return { guestKind: "booking_failed_refunded", staffKind: "staff_sync_failed" };
}
