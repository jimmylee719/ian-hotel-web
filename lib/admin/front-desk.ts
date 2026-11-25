import { and, eq, exists, is, SQL, sql } from "drizzle-orm";
import { runAtomic } from "@/lib/db/atomic";
import { auditLog, payments, reservations } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { todayInTaipei } from "@/lib/domain/dates";
import { receivedAmount } from "@/lib/booking/notify";
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
  | "NOT_FOUND" | "FORBIDDEN" | "NOT_PAYABLE" | "INVALID_AMOUNT" | "INVALID_LAST4" | "AUTH_CODE_REQUIRED" | "OVERPAY";

export type RecordFrontDeskResult = { ok: true; paymentId: string; balanceDue: number } | { ok: false; error: RecordFrontDeskError };

export type VoidFrontDeskResult =
  | { ok: true; balanceDue: number }
  | { ok: false; error: "NOT_FOUND" | "FORBIDDEN" | "REASON_REQUIRED" | "NOT_SAME_DAY" | "ALREADY_VOIDED" };

const LAST4 = /^\d{4}$/;
export const NOTE_MAX = 500;
const AUTH_CODE_MAX = 32;

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

/** SQL: total received (online net + front-desk net) of the reservation, as MoneyHeld defines it. */
const receivedSql = (reservationId: string) => sql`(select coalesce(sum(case when ${payments.kind} = 'refund'
  then -${payments.amount} else ${payments.amount} end), 0) from ${payments}
  where ${payments.reservationId} = ${reservationId} and ${payments.status} = 'succeeded'
  and ${payments.kind} in ('charge', 'refund', 'front_desk'))`;

/** What is still owed on the booking: its total minus the total received. */
export async function balanceDueOf(db: Db, reservationId: string): Promise<number> {
  const [r] = await db.select({ total: reservations.totalAmount }).from(reservations).where(eq(reservations.id, reservationId));
  if (!r) throw new Error(`Reservation ${reservationId} not found`);
  return r.total - await receivedAmount(db, reservationId);
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
 * Record a front-desk payment on a confirmed booking (needs `payments.front_desk` at its property; another
 * property's booking is NOT_FOUND). The amount is a positive integer no larger than the balance due; edc needs
 * the card's last four digits and the terminal's authorisation code; any last4 must be four digits.
 * The payment (kind front_desk, succeeded) and its audit row are one batch, both guarded by "confirmed and the
 * amount still fits the balance", so two desks taking the same balance at once record it only once.
 */
export async function recordFrontDeskPayment(
  db: Db, ctx: StaffContext, reservationId: string, p: FrontDeskPaymentInput, now: Date,
): Promise<RecordFrontDeskResult> {
  if (!can(ctx.staff, "payments.front_desk")) return { ok: false, error: "FORBIDDEN" };
  const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  if (!res || !can(ctx.staff, "payments.front_desk", res.propertyId)) return { ok: false, error: "NOT_FOUND" };

  if (!Number.isInteger(p.amount) || p.amount <= 0) return { ok: false, error: "INVALID_AMOUNT" };
  const last4 = p.last4?.trim() || null;
  const authCode = p.authCode?.trim().slice(0, AUTH_CODE_MAX) || null;
  if (last4 !== null && !LAST4.test(last4)) return { ok: false, error: "INVALID_LAST4" };
  if (p.method === "edc" && last4 === null) return { ok: false, error: "INVALID_LAST4" };
  if (p.method === "edc" && authCode === null) return { ok: false, error: "AUTH_CODE_REQUIRED" };
  if (res.status !== "confirmed") return { ok: false, error: "NOT_PAYABLE" };
  if (p.amount > await balanceDueOf(db, res.id)) return { ok: false, error: "OVERPAY" };

  const paymentId = crypto.randomUUID();
  const note = p.note?.trim().slice(0, NOTE_MAX) || null;
  const fits = sql`exists (select 1 from ${reservations} where ${reservations.id} = ${res.id}
    and ${reservations.status} = 'confirmed' and ${reservations.totalAmount} - ${receivedSql(res.id)} >= ${p.amount})`;
  const auditId = crypto.randomUUID();
  // The audit row goes first: both statements see the balance as it was before this payment.
  await runAtomic(db, [
    guardedAudit(db, ctx, auditId, {
      action: "payment.front_desk", entity: "payment", entityId: paymentId,
      // The balance after this payment, from the same snapshot the guard checks.
      after: sql`json_object('reservationId', ${res.id}, 'method', ${p.method}, 'amount', ${p.amount}, 'last4', ${last4},
        'authCode', ${authCode}, 'note', ${note},
        'balanceDue', (select ${reservations.totalAmount} from ${reservations} where ${reservations.id} = ${res.id}) - ${receivedSql(res.id)} - ${p.amount})`,
    }, fits, now),
    db.insert(payments).select(sql`select ${paymentId}, ${res.id}, 'front_desk', ${p.method}, ${p.amount}, 'succeeded',
      null, ${authCode}, ${last4}, null, null, ${now.getTime()}, ${note} where ${fits}`),
  ]);
  const [won] = await db.select({ id: payments.id }).from(payments).where(eq(payments.id, paymentId));
  if (!won) return { ok: false, error: "OVERPAY" };
  return { ok: true, paymentId, balanceDue: await balanceDueOf(db, res.id) };
}

/**
 * Void a front-desk payment taken today (Taipei): needs `payments.front_desk` at the property and the owner or
 * manager role. The row is kept and set to failed (so it no longer counts as received), with an audit row in
 * the same batch; both are guarded by "still succeeded", so a second void is ALREADY_VOIDED.
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

  const stillSucceeded = exists(db.select({ one: sql`1` }).from(payments).where(and(eq(payments.id, row.id), eq(payments.status, "succeeded"))));
  const auditId = crypto.randomUUID();
  await runAtomic(db, [
    guardedAudit(db, ctx, auditId, {
      action: "payment.void", entity: "payment", entityId: row.id,
      before: { status: "succeeded", method: row.method, amount: row.amount },
      after: { status: "failed", reason: why },
    }, stillSucceeded, now),
    db.update(payments).set({ status: "failed" }).where(and(eq(payments.id, row.id), eq(payments.status, "succeeded"))),
  ]);
  const [won] = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.id, auditId));
  if (!won) return { ok: false, error: "ALREADY_VOIDED" };
  return { ok: true, balanceDue: await balanceDueOf(db, row.reservationId) };
}
