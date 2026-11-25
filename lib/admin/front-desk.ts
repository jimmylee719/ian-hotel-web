import { and, eq, exists, is, SQL, sql } from "drizzle-orm";
import { runAtomic } from "@/lib/db/atomic";
import { auditLog, payments, reservations } from "@/lib/db/schema";
import { cancelKey } from "@/lib/booking/manage";
import type { Db } from "@/lib/db/types";
import { todayInTaipei } from "@/lib/domain/dates";
import { balanceDue, moneyOf, receivedOf } from "./money-metrics";
import type { AuditEntry } from "./audit";
import type { StaffContext } from "./auth";
import { can, type StaffRole } from "./permissions";

/**
 * Money taken at the front desk: card terminal (edc), cash or bank transfer. It never goes through the
 * payment gateway, so it is never refunded online either: a cancellation reports the desk's share as
 * `frontDeskRefundDue` for staff to hand back (see cancelRefundPlan in lib/booking/manage).
 */
export type FrontDeskMethod = "edc" | "cash" | "transfer";
export const FRONT_DESK_METHODS: readonly FrontDeskMethod[] = ["edc", "cash", "transfer"];

export type FrontDeskPaymentInput = { method: FrontDeskMethod; amount: number; last4?: string; authCode?: string; note?: string };

export type RecordFrontDeskError =
  | "NOT_FOUND" | "FORBIDDEN" | "NOT_PAYABLE" | "CANCEL_IN_PROGRESS" | "INVALID_AMOUNT" | "INVALID_LAST4"
  | "AUTH_CODE_REQUIRED" | "INVALID_AUTH_CODE" | "LOOKS_LIKE_CARD_NUMBER" | "OVERPAY";

export type RecordFrontDeskResult = { ok: true; paymentId: string; balanceDue: number } | { ok: false; error: RecordFrontDeskError };

export type VoidFrontDeskResult =
  | { ok: true; balanceDue: number }
  | {
      ok: false;
      error: "NOT_FOUND" | "FORBIDDEN" | "REASON_REQUIRED" | "NOT_SAME_DAY" | "ALREADY_VOIDED" | "CANCEL_IN_PROGRESS" | "NOT_VOIDABLE";
    };

const LAST4 = /^\d{4}$/;
const AUTH_CODE = /^[A-Za-z0-9]{1,12}$/;
export const NOTE_MAX = 500;

/** A run of 13+ digits once spaces and dashes are ignored: what a pasted card number (13–19 digits) looks like. */
export const looksLikeCardNumber = (s: string): boolean => /\d{13}/.test(s.replace(/[\s-]/g, ""));

/**
 * Who may void a front-desk payment. A role check here rather than a new permission: the plan's matrix
 * (lib/admin/permissions) has no `payments.void`, and voiding is the manager's correction of a desk entry,
 * so it is `payments.front_desk` at the property plus owner or manager.
 */
const VOID_ROLES: readonly StaffRole[] = ["owner", "manager"];

/** Whether this staff member may void front-desk payments at the property (the same-day rule is checked on void). */
export const canVoidFrontDesk = (member: StaffContext["staff"], propertyId: string): boolean =>
  can(member, "payments.front_desk", propertyId) && VOID_ROLES.includes(member.role);

/** Whether a payment taken at `createdAt` may still be voided at `now`: the same Taipei date. */
export const voidableOn = (createdAt: number, now: Date): boolean => todayInTaipei(new Date(createdAt)) === todayInTaipei(now);

/**
 * Where the booking stands for desk money. Front-desk money may move (be recorded or voided) only while the
 * booking is `open`: confirmed, not claimed for cancellation (cancelledAt null) and with no `cancel:<id>`
 * refund row. Once a cancellation has started, its refund split is being (or has been) fixed from the money
 * held; desk money moving under it would be neither refunded nor flagged.
 */
type DeskState = "open" | "cancel_in_progress" | "closed";

/** SQL: the booking is `open` (see DeskState), checked inside the same statement as the write it guards. */
const deskOpenSql = (reservationId: string): SQL => sql`exists (select 1 from ${reservations}
  where ${reservations.id} = ${reservationId} and ${reservations.status} = 'confirmed' and ${reservations.cancelledAt} is null
  and not exists (select 1 from ${payments} where ${payments.idempotencyKey} = ${cancelKey(reservationId)}))`;

async function deskState(db: Db, reservationId: string): Promise<DeskState> {
  const [r] = await db.select({ status: reservations.status, cancelledAt: reservations.cancelledAt })
    .from(reservations).where(eq(reservations.id, reservationId));
  if (!r || r.status !== "confirmed") return "closed";
  if (r.cancelledAt != null) return "cancel_in_progress";
  const [intent] = await db.select({ id: payments.id }).from(payments).where(eq(payments.idempotencyKey, cancelKey(reservationId)));
  return intent ? "cancel_in_progress" : "open";
}

/** Whether desk money on this booking may move now (for the detail page's buttons). */
export async function frontDeskOpen(db: Db, reservationId: string): Promise<boolean> {
  return (await deskState(db, reservationId)) === "open";
}

/** What is still owed on the booking: its total minus what was received (money-metrics' definitions). */
export async function balanceDueOf(db: Db, reservationId: string): Promise<number> {
  const [r] = await db.select({ total: reservations.totalAmount }).from(reservations).where(eq(reservations.id, reservationId));
  if (!r) throw new Error(`Reservation ${reservationId} not found`);
  return balanceDue(r.total, await moneyOf(db, reservationId));
}

/**
 * An audit row inserted only while `guard` holds, so it commits exactly when the guarded write does.
 * `after` may be SQL (a JSON value computed in the same statement).
 */
function guardedAudit(
  db: Db, ctx: StaffContext, id: string, e: Omit<AuditEntry, "after"> & { after: unknown }, guard: SQL, now: Date,
) {
  const after = is(e.after, SQL) ? e.after : JSON.stringify(e.after ?? null);
  return db.insert(auditLog).select(sql`select ${id}, ${ctx.email}, ${e.action}, ${e.entity}, ${e.entityId},
    ${JSON.stringify(e.before ?? null)}, ${after}, ${now.getTime()} where ${guard}`);
}

/**
 * Record a front-desk payment on an open booking (see DeskState; needs `payments.front_desk` at its property,
 * another property's booking is NOT_FOUND). The amount is a positive integer no larger than the balance due;
 * edc needs the card's last four digits and the terminal's authorisation code (1–12 letters/digits); any last4
 * must be four digits; neither the auth code nor the note may hold something that looks like a card number.
 * The payment (kind front_desk, succeeded) and its audit row are one batch, both guarded in SQL by "open and the
 * amount still fits the balance": two desks taking the same balance, or a cancel claimed meanwhile, can't slip in.
 */
export async function recordFrontDeskPayment(
  db: Db, ctx: StaffContext, reservationId: string, p: FrontDeskPaymentInput, now: Date,
): Promise<RecordFrontDeskResult> {
  if (!can(ctx.staff, "payments.front_desk")) return { ok: false, error: "FORBIDDEN" };
  const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  if (!res || !can(ctx.staff, "payments.front_desk", res.propertyId)) return { ok: false, error: "NOT_FOUND" };

  if (!Number.isInteger(p.amount) || p.amount <= 0) return { ok: false, error: "INVALID_AMOUNT" };
  const last4 = p.last4?.trim() || null;
  const authCode = p.authCode?.trim() || null;
  const note = p.note?.trim().slice(0, NOTE_MAX) || null;
  if ((authCode && looksLikeCardNumber(authCode)) || (p.note && looksLikeCardNumber(p.note)))
    return { ok: false, error: "LOOKS_LIKE_CARD_NUMBER" };
  if (last4 !== null && !LAST4.test(last4)) return { ok: false, error: "INVALID_LAST4" };
  if (authCode !== null && !AUTH_CODE.test(authCode)) return { ok: false, error: "INVALID_AUTH_CODE" };
  if (p.method === "edc" && last4 === null) return { ok: false, error: "INVALID_LAST4" };
  if (p.method === "edc" && authCode === null) return { ok: false, error: "AUTH_CODE_REQUIRED" };
  const state = await deskState(db, res.id);
  if (state !== "open") return { ok: false, error: state === "closed" ? "NOT_PAYABLE" : "CANCEL_IN_PROGRESS" };
  if (p.amount > await balanceDueOf(db, res.id)) return { ok: false, error: "OVERPAY" };

  const paymentId = crypto.randomUUID();
  const fits = sql`${deskOpenSql(res.id)} and exists (select 1 from ${reservations} where ${reservations.id} = ${res.id}
    and ${reservations.totalAmount} - ${receivedOf(res.id)} >= ${p.amount})`;
  const auditId = crypto.randomUUID();
  // The audit row goes first: both statements see the balance as it was before this payment.
  await runAtomic(db, [
    guardedAudit(db, ctx, auditId, {
      action: "payment.front_desk", entity: "payment", entityId: paymentId,
      // The balance after this payment, from the same snapshot the guard checks.
      after: sql`json_object('reservationId', ${res.id}, 'method', ${p.method}, 'amount', ${p.amount}, 'last4', ${last4},
        'authCode', ${authCode}, 'note', ${note},
        'balanceDue', (select ${reservations.totalAmount} from ${reservations} where ${reservations.id} = ${res.id}) - ${receivedOf(res.id)} - ${p.amount})`,
    }, fits, now),
    // Positional: payments' columns in schema order (id … createdAt, note). Every column is read back in tests.
    db.insert(payments).select(sql`select ${paymentId}, ${res.id}, 'front_desk', ${p.method}, ${p.amount}, 'succeeded',
      null, ${authCode}, ${last4}, null, null, ${now.getTime()}, ${note} where ${fits}`),
  ]);
  const [won] = await db.select({ id: payments.id }).from(payments).where(eq(payments.id, paymentId));
  if (!won) {
    const lost = await deskState(db, res.id);
    return { ok: false, error: lost === "closed" ? "NOT_PAYABLE" : lost === "cancel_in_progress" ? "CANCEL_IN_PROGRESS" : "OVERPAY" };
  }
  return { ok: true, paymentId, balanceDue: await balanceDueOf(db, res.id) };
}

/**
 * Void a front-desk payment taken today (Taipei) on an open booking (see DeskState): needs `payments.front_desk`
 * at the property and the owner or manager role. A cancelled (or otherwise closed) booking is NOT_VOIDABLE, one
 * whose cancellation has started is CANCEL_IN_PROGRESS. The row is kept and set to failed (so it no longer
 * counts as received), with an audit row in the same batch; both are guarded in SQL by "still succeeded and the
 * booking still open", so a second void is ALREADY_VOIDED and a cancel claimed meanwhile wins.
 */
export async function voidFrontDeskPayment(
  db: Db, ctx: StaffContext, paymentId: string, reason: string, now: Date,
): Promise<VoidFrontDeskResult> {
  if (!can(ctx.staff, "payments.front_desk") || !VOID_ROLES.includes(ctx.staff.role)) return { ok: false, error: "FORBIDDEN" };
  const [found] = await db.select({ p: payments, propertyId: reservations.propertyId }).from(payments)
    .innerJoin(reservations, eq(reservations.id, payments.reservationId))
    .where(and(eq(payments.id, paymentId), eq(payments.kind, "front_desk")));
  if (!found || !can(ctx.staff, "payments.front_desk", found.propertyId)) return { ok: false, error: "NOT_FOUND" };
  const row = found.p;
  const why = reason.trim();
  if (!why) return { ok: false, error: "REASON_REQUIRED" };
  if (row.status !== "succeeded") return { ok: false, error: "ALREADY_VOIDED" };
  if (!voidableOn(row.createdAt, now)) return { ok: false, error: "NOT_SAME_DAY" };
  const stateError = (s: DeskState) => (s === "closed" ? "NOT_VOIDABLE" as const : "CANCEL_IN_PROGRESS" as const);
  const state = await deskState(db, row.reservationId);
  if (state !== "open") return { ok: false, error: stateError(state) };

  const stillSucceeded = exists(db.select({ one: sql`1` }).from(payments).where(and(eq(payments.id, row.id), eq(payments.status, "succeeded"))));
  const guard = sql`${stillSucceeded} and ${deskOpenSql(row.reservationId)}`;
  const auditId = crypto.randomUUID();
  await runAtomic(db, [
    guardedAudit(db, ctx, auditId, {
      action: "payment.void", entity: "payment", entityId: row.id,
      before: { status: "succeeded", method: row.method, amount: row.amount },
      after: { status: "failed", reason: why },
    }, guard, now),
    db.update(payments).set({ status: "failed" }).where(and(eq(payments.id, row.id), eq(payments.status, "succeeded"), deskOpenSql(row.reservationId))),
  ]);
  const [won] = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.id, auditId));
  if (!won) {
    const lost = await deskState(db, row.reservationId);
    return { ok: false, error: lost === "open" ? "ALREADY_VOIDED" : stateError(lost) };
  }
  return { ok: true, balanceDue: await balanceDueOf(db, row.reservationId) };
}
