import { and, eq, exists, is, SQL, sql } from "drizzle-orm";
import { runAtomic } from "@/lib/db/atomic";
import { auditLog, payments, reservations } from "@/lib/db/schema";
import { cancelKey } from "@/lib/booking/manage";
import type { Db } from "@/lib/db/types";
import { todayInTaipei } from "@/lib/domain/dates";
import { balanceDue, moneyOf, receivedOf, receivedWithout } from "./money-metrics";
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
      error: "NOT_FOUND" | "FORBIDDEN" | "REASON_REQUIRED" | "NOT_SAME_DAY" | "ALREADY_VOIDED" | "CANCEL_IN_PROGRESS" | "NOT_VOIDABLE"
        | "DESK_DUE_OUTSTANDING";
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
export const deskOpenSql = (reservationId: string): SQL => sql`exists (select 1 from ${reservations}
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

type EntryError = "INVALID_AMOUNT" | "INVALID_LAST4" | "AUTH_CODE_REQUIRED" | "INVALID_AUTH_CODE" | "LOOKS_LIKE_CARD_NUMBER";

/**
 * The rules for any money entered at the desk (in or out): a positive whole amount; edc needs the card's last four
 * digits and the terminal's authorisation code (1–12 letters/digits); any last4 must be four digits; neither the
 * auth code nor the note may hold something that looks like a card number. Returns the trimmed fields.
 */
function deskEntry(p: FrontDeskPaymentInput):
  | { ok: true; last4: string | null; authCode: string | null; note: string | null }
  | { ok: false; error: EntryError } {
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
  return { ok: true, last4, authCode, note };
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
 * The payment (kind front_desk, succeeded), its audit row and a bump of the booking's updatedAt (its version, which
 * staff modifications check) are one batch, all guarded in SQL by "open and the amount still fits the balance":
 * two desks taking the same balance, or a cancel claimed meanwhile, can't slip in.
 */
export async function recordFrontDeskPayment(
  db: Db, ctx: StaffContext, reservationId: string, p: FrontDeskPaymentInput, now: Date,
): Promise<RecordFrontDeskResult> {
  if (!can(ctx.staff, "payments.front_desk")) return { ok: false, error: "FORBIDDEN" };
  const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  if (!res || !can(ctx.staff, "payments.front_desk", res.propertyId)) return { ok: false, error: "NOT_FOUND" };

  const entry = deskEntry(p);
  if (!entry.ok) return entry;
  const { last4, authCode, note } = entry;
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
    // The booking's version moves with its money, so a staff modification planned before this payment conflicts.
    db.update(reservations).set({ updatedAt: now.getTime() }).where(and(eq(reservations.id, res.id), fits)),
    // Positional: payments' columns in schema order (id … createdAt, note, merchantOrderNo, notifyGuest, settledAt). Every column is read back in tests.
    db.insert(payments).select(sql`select ${paymentId}, ${res.id}, 'front_desk', ${p.method}, ${p.amount}, 'succeeded',
      null, ${authCode}, ${last4}, null, null, ${now.getTime()}, ${note}, null, null, null where ${fits}`),
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
 * counts as received), with an audit row and an updatedAt bump in the same batch; all are guarded in SQL by "still succeeded and the
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
  if (await deskDueOutstanding(db, row.reservationId)) return { ok: false, error: "DESK_DUE_OUTSTANDING" };

  const stillSucceeded = exists(db.select({ one: sql`1` }).from(payments).where(and(eq(payments.id, row.id), eq(payments.status, "succeeded"))));
  const guard = sql`${stillSucceeded} and ${deskOpenSql(row.reservationId)} and ${noDeskDueSql(row.reservationId)}`;
  const auditId = crypto.randomUUID();
  await runAtomic(db, [
    guardedAudit(db, ctx, auditId, {
      action: "payment.void", entity: "payment", entityId: row.id,
      before: { status: "succeeded", method: row.method, amount: row.amount },
      after: { status: "failed", reason: why },
    }, guard, now),
    // The booking's version moves with its money, so a staff modification planned before this void conflicts.
    db.update(reservations).set({ updatedAt: now.getTime() }).where(and(eq(reservations.id, row.reservationId), guard)),
    db.update(payments).set({ status: "failed" })
      .where(and(eq(payments.id, row.id), eq(payments.status, "succeeded"), deskOpenSql(row.reservationId), noDeskDueSql(row.reservationId))),
  ]);
  const [won] = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.id, auditId));
  if (!won) {
    const lost = await deskState(db, row.reservationId);
    if (lost !== "open") return { ok: false, error: stateError(lost) };
    return { ok: false, error: await deskDueOutstanding(db, row.reservationId) ? "DESK_DUE_OUTSTANDING" : "ALREADY_VOIDED" };
  }
  return { ok: true, balanceDue: await balanceDueOf(db, row.reservationId) };
}

/**
 * SQL: the desk owes this booking's guest nothing, now or for a cancellation in flight. A void would take money
 * out of `received` that a payout of that debt still has to come from, so voids wait until it is settled (or a
 * cancel / modification recomputes it).
 */
const noDeskDueSql = (reservationId: string): SQL => sql`not exists (select 1 from ${reservations}
  where ${reservations.id} = ${reservationId} and (${reservations.frontDeskRefundDue} > 0 or ${reservations.cancelDeskDue} > 0))`;

async function deskDueOutstanding(db: Db, reservationId: string): Promise<boolean> {
  const [r] = await db.select({ due: reservations.frontDeskRefundDue, cancel: reservations.cancelDeskDue })
    .from(reservations).where(eq(reservations.id, reservationId));
  return !!r && (r.due > 0 || r.cancel > 0);
}

export type RecordFrontDeskRefundResult =
  | { ok: true; paymentId: string; frontDeskRefundDue: number }
  | { ok: false; error: "NOT_FOUND" | "FORBIDDEN" | "EXCEEDS_DESK_DUE" | "EXCEEDS_RECEIVED" | "CANCEL_IN_PROGRESS" | EntryError };

/**
 * SQL: the desk may pay `amount` (payment row `paymentId`, inserted in the same batch) out on this booking now:
 * - it owes at least that much (frontDeskRefundDue);
 * - what was received, not counting this payout, covers it: no payout ever drives `received` below zero
 *   (defence in depth: desk-due should never exceed received);
 * - the booking is open (see DeskState) or cancelled. Not while a cancellation is in flight: its desk share is
 *   still being fixed (it lands in frontDeskRefundDue only as the booking turns cancelled).
 */
const payoutAllowedSql = (reservationId: string, paymentId: string, amount: number): SQL => sql`exists (select 1 from ${reservations}
  where ${reservations.id} = ${reservationId} and ${reservations.frontDeskRefundDue} >= ${amount}
  and ${receivedWithout(reservationId, paymentId)} - ${amount} >= 0
  and (${reservations.status} = 'cancelled' or ${deskOpenSql(reservationId)}))`;

/**
 * Record money the desk handed back to the guest (card terminal refund, cash, transfer): what a price-lowering
 * modification or a cancellation left in frontDeskRefundDue. Needs `payments.front_desk` at the booking's property
 * (another property's booking is NOT_FOUND); the desk entry rules of recordFrontDeskPayment apply; the amount may
 * not exceed frontDeskRefundDue (EXCEEDS_DESK_DUE). Allowed on an open or a cancelled booking.
 * ONE batch, every statement guarded by payoutAllowedSql (the booking row is updated last): the audit row, a
 * succeeded `refund` payment with the desk method (which the money module counts off the desk's net, so
 * `received` drops), and frontDeskRefundDue − amount with an updatedAt bump.
 */
export async function recordFrontDeskRefund(
  db: Db, ctx: StaffContext, reservationId: string, p: FrontDeskPaymentInput, now: Date,
): Promise<RecordFrontDeskRefundResult> {
  if (!can(ctx.staff, "payments.front_desk")) return { ok: false, error: "FORBIDDEN" };
  const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  if (!res || !can(ctx.staff, "payments.front_desk", res.propertyId)) return { ok: false, error: "NOT_FOUND" };
  const entry = deskEntry(p);
  if (!entry.ok) return entry;
  const { last4, authCode, note } = entry;
  if (p.amount > res.frontDeskRefundDue) return { ok: false, error: "EXCEEDS_DESK_DUE" };
  if (p.amount > (await moneyOf(db, res.id)).received) return { ok: false, error: "EXCEEDS_RECEIVED" };

  const paymentId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const guard = payoutAllowedSql(res.id, paymentId, p.amount);
  await runAtomic(db, [
    guardedAudit(db, ctx, auditId, {
      action: "payment.front_desk_refund", entity: "payment", entityId: paymentId,
      before: { frontDeskRefundDue: res.frontDeskRefundDue },
      after: sql`json_object('reservationId', ${res.id}, 'method', ${p.method}, 'amount', ${p.amount}, 'last4', ${last4},
        'authCode', ${authCode}, 'note', ${note},
        'frontDeskRefundDue', (select ${reservations.frontDeskRefundDue} from ${reservations} where ${reservations.id} = ${res.id}) - ${p.amount})`,
    }, guard, now),
    // Positional: payments' columns in schema order (id … createdAt, note, merchantOrderNo, notifyGuest, settledAt).
    db.insert(payments).select(sql`select ${paymentId}, ${res.id}, 'refund', ${p.method}, ${p.amount}, 'succeeded',
      null, ${authCode}, ${last4}, null, null, ${now.getTime()}, ${note}, null, null, ${now.getTime()} where ${guard}`),
    db.update(reservations)
      .set({
        frontDeskRefundDue: sql`${reservations.frontDeskRefundDue} - ${p.amount}`,
        deskDueSince: sql`case when ${reservations.frontDeskRefundDue} - ${p.amount} > 0 then ${reservations.deskDueSince} else null end`,
        updatedAt: now.getTime(),
      })
      .where(and(eq(reservations.id, res.id), guard)),
  ]);
  const [won] = await db.select({ id: payments.id }).from(payments).where(eq(payments.id, paymentId));
  const [cur] = await db.select().from(reservations).where(eq(reservations.id, res.id));
  if (!won) {
    if (cur.frontDeskRefundDue < p.amount) return { ok: false, error: "EXCEEDS_DESK_DUE" };
    if ((await moneyOf(db, res.id)).received < p.amount) return { ok: false, error: "EXCEEDS_RECEIVED" };
    return { ok: false, error: "CANCEL_IN_PROGRESS" };
  }
  return { ok: true, paymentId, frontDeskRefundDue: cur.frontDeskRefundDue };
}
