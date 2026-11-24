import { and, eq, exists, isNull, lte, notExists, or, sql } from "drizzle-orm";
import type { CancelResult } from "@/lib/channel/types";
import { releaseInventory } from "@/lib/db/inventory-hold";
import { payments, ratePlans, reservationRooms, reservations, unitTypes, type I18n } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { todayInTaipei } from "@/lib/domain/dates";
import { refundAmount } from "@/lib/domain/cancellation";
import type { Quote } from "@/lib/domain/quote";
import { holdItemsFor, MAX_SYNC_ATTEMPTS, refundOnce, SYNC_LEASE_MS, SYNC_RETRY_MS, type RefundOutcome } from "./confirm";
import { notifyGuest, notifyStaff, paidAmount, refundableCharges, type Deps } from "./notify";
import { payingChargeId } from "./payment-notice";
import { transition, type Reservation, type ResStatus } from "./state";

/** How long one request owns a cancellation (refund in flight); after that another request may take over. */
export const CANCEL_LEASE_MS = 2 * 60_000;

export type ReservationView = {
  code: string;
  status: ResStatus;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  rooms: number;
  roomTypeName: I18n;
  ratePlanName: I18n;
  quote: Quote;
  /** Money currently held: succeeded charges minus succeeded refunds. */
  paid: number;
  refunded: number;
  refundIfCancelledNow: number;
  canCancel: boolean;
};

export type CancelOutcome =
  | { ok: true; refunded: number; alreadyCancelled: boolean }
  | { ok: false; error: "NOT_FOUND" | "NOT_CANCELLABLE" | "REFUND_FAILED" };

/** A reservation by code (any case) and guest email (any case); both must match. */
async function lookup(db: Db, code: string, email: string): Promise<Reservation | undefined> {
  const [res] = await db.select().from(reservations).where(and(
    eq(reservations.code, code.trim().toUpperCase()), eq(reservations.guestEmailLower, email.trim().toLowerCase()),
  ));
  return res;
}

export async function findReservation(db: Db, code: string, email: string, now: Date = new Date()): Promise<ReservationView | null> {
  const res = await lookup(db, code, email);
  if (!res) return null;
  const rooms = await db.select({ unitName: unitTypes.name, planName: ratePlans.name })
    .from(reservationRooms)
    .innerJoin(unitTypes, eq(unitTypes.id, reservationRooms.unitTypeId))
    .innerJoin(ratePlans, eq(ratePlans.id, reservationRooms.ratePlanId))
    .where(eq(reservationRooms.reservationId, res.id));
  const room = rooms[0];
  const canCancel = res.status === "confirmed" && withinCancelWindow(res, now);
  return {
    code: res.code,
    status: res.status,
    checkIn: res.checkIn,
    checkOut: res.checkOut,
    adults: res.adults,
    children: res.children,
    rooms: rooms.length,
    roomTypeName: room.unitName,
    ratePlanName: room.planName,
    quote: res.quote as Quote,
    paid: await paidAmount(db, res.id),
    refunded: res.refundedAmount,
    refundIfCancelledNow: canCancel ? await cancellationRefund(db, res, now) : 0,
    canCancel,
  };
}

/**
 * Guests may cancel up to and including check-in day (Taipei). After that the stay has begun or ended:
 * releasing its nights would let the room be resold while occupied, so the front desk handles it.
 * A cancellation already claimed (in flight) is judged at its claim time, so it can still finish.
 */
function withinCancelWindow(res: Reservation, now: Date): boolean {
  return todayInTaipei(new Date(res.cancelledAt ?? now.getTime())) <= res.checkIn;
}

/** The one refund row of a guest cancellation; every attempt at that cancellation converges on it. */
const cancelKey = (reservationId: string) => `cancel:${reservationId}`;

async function cancelIntent(db: Db, reservationId: string) {
  const [row] = await db.select().from(payments).where(eq(payments.idempotencyKey, cancelKey(reservationId)));
  return row;
}

/**
 * What cancelling refunds: the amount already fixed in the cancellation's refund row if an earlier
 * attempt created it, otherwise the rate plan's policy applied to the net amount paid at `at`.
 * The preview and the actual cancel share this.
 */
async function cancellationRefund(db: Db, res: Reservation, at: Date): Promise<number> {
  const intent = await cancelIntent(db, res.id);
  if (intent) return intent.amount;
  const [plan] = await db.select({ policy: ratePlans.cancelPolicy }).from(reservationRooms)
    .innerJoin(ratePlans, eq(ratePlans.id, reservationRooms.ratePlanId))
    .where(eq(reservationRooms.reservationId, res.id))
    .limit(1);
  return refundAmount(plan.policy, await paidAmount(db, res.id), res.checkIn, at);
}

/**
 * Cancel a confirmed reservation for the guest and refund what the policy allows.
 * 1. Claim it: stamp `cancelledAt` (status stays `confirmed`) unless another request holds a fresh claim.
 *    The policy is applied at the first request's time.
 * 2. Refund against the paying charge through ONE intent row keyed `cancel:<id>` (refundOnce): its
 *    amount is fixed when it is created, and every later attempt reuses it, so retries never refund twice.
 *    - Outcome unknown (row pending: another attempt in flight, or it died) → staff alert, REFUND_FAILED,
 *      the claim is kept so that a slow first attempt can still finish.
 *    - Definitive failure → the claim is dropped, staff alert, REFUND_FAILED; a later cancel retries the row.
 * 3. `confirmed` → `cancelled`, allowed only when the refund row succeeded (or there is none: nothing to
 *    refund); the channel cancel is queued (syncState pending).
 * 4. Give the rooms back, 5. cancel on the channel (the retry job retries), 6. email guest and staff.
 */
export async function cancelReservation(deps: Deps, code: string, email: string, now: Date): Promise<CancelOutcome> {
  const { db } = deps;
  const res = await lookup(db, code, email);
  if (!res) return { ok: false, error: "NOT_FOUND" };
  if (res.status === "cancelled") return { ok: true, refunded: res.refundedAmount, alreadyCancelled: true };
  if (res.status !== "confirmed" || !withinCancelWindow(res, now)) return { ok: false, error: "NOT_CANCELLABLE" };

  const claim = await claimCancellation(db, res.id, now);
  if (!claim) return settledElsewhere(db, res.id);

  const r = await refundCancellation(deps, claim, now);
  if (!r.ok) {
    if (!r.pendingRefundId)
      await db.update(reservations)
        .set({ cancelledAt: null, lastSyncError: `CANCEL_REFUND_FAILED: ${r.error}`, updatedAt: now.getTime() })
        .where(and(eq(reservations.id, res.id), eq(reservations.status, "confirmed"), eq(reservations.updatedAt, claim.updatedAt)));
    const ref = r.pendingRefundId ?? `cancel-refund-failed:${now.getTime()}`;
    await notifyStaff(deps, res.id, "staff_payment_alert", now, {}, ref);
    return { ok: false, error: "REFUND_FAILED" };
  }

  // refundOnce already added the refund to refundedAmount.
  // nextSyncAt = now: from this moment the retry job is the safety net for the channel cancel.
  const key = cancelKey(res.id);
  const refundSettled = or(
    notExists(db.select({ one: sql`1` }).from(payments).where(eq(payments.idempotencyKey, key))),
    exists(db.select({ one: sql`1` }).from(payments).where(and(eq(payments.idempotencyKey, key), eq(payments.status, "succeeded")))),
  );
  const cancelled = await transition(db, res.id, "confirmed", "cancelled", {
    holdExpiresAt: null,
    syncState: "pending", syncAttempts: 0, nextSyncAt: now.getTime(), lastSyncError: null,
  }, now, refundSettled);
  if (!cancelled) return settledElsewhere(db, res.id);

  if (claim.holdExpiresAt != null) await releaseInventory(db, await holdItemsFor(db, claim));
  await cancelWithChannel(deps, res.id, now);
  await notifyGuest(deps, res.id, "cancelled", now, { refundAmount: r.amount });
  await notifyStaff(deps, res.id, "cancelled", now, { refundAmount: r.amount });
  return { ok: true, refunded: r.amount, alreadyCancelled: false };
}

/** Run (or finish, or join) the cancellation's refund. Nothing to refund → `{ ok: true, amount: 0 }`. */
async function refundCancellation(deps: Deps, claim: Reservation, now: Date): Promise<RefundOutcome> {
  const { db } = deps;
  const intent = await cancelIntent(db, claim.id);
  const amount = intent ? intent.amount : await cancellationRefund(db, claim, new Date(claim.cancelledAt!));
  if (amount <= 0) return { ok: true, amount: 0 };
  const chargeId = intent?.refundOf ?? await payingChargeId(db, claim.id);
  const charge = (await refundableCharges(db, claim.id)).find((c) => c.id === chargeId);
  if (!charge) return { ok: false, error: "NO_PAYING_CHARGE" };
  if (!intent && charge.remaining < amount) return { ok: false, error: `REFUNDABLE_${charge.remaining}_LT_${amount}` };
  return refundOnce(deps, cancelKey(claim.id), charge, amount, "GUEST_CANCELLED", now, { countsAsBookingRefund: true });
}

/**
 * One conditional UPDATE: own the cancellation of a confirmed booking. `cancelledAt` keeps the time
 * of the first request (the policy is applied at that time); `updatedAt` is the lease.
 */
async function claimCancellation(db: Db, reservationId: string, now: Date): Promise<Reservation | undefined> {
  const [res] = await db.update(reservations)
    .set({ cancelledAt: sql`coalesce(${reservations.cancelledAt}, ${now.getTime()})`, updatedAt: now.getTime() })
    .where(and(
      eq(reservations.id, reservationId), eq(reservations.status, "confirmed"),
      or(isNull(reservations.cancelledAt), lte(reservations.updatedAt, now.getTime() - CANCEL_LEASE_MS)),
    ))
    .returning();
  return res;
}

/** Another request owns (or just finished) this cancellation: report what it did, if it is done. */
async function settledElsewhere(db: Db, reservationId: string): Promise<CancelOutcome> {
  const [cur] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  return cur.status === "cancelled"
    ? { ok: true, refunded: cur.refundedAmount, alreadyCancelled: true }
    : { ok: false, error: "NOT_CANCELLABLE" };
}

/**
 * Tell the channel a `cancelled` booking is gone. Lease-guarded like confirmWithChannel, so the
 * cancel request and the retry job never call it at the same time. Success → synced; a retryable
 * failure retries in 5 minutes; a non-retryable one, or one after MAX_SYNC_ATTEMPTS retries, → failed
 * and staff are alerted.
 */
export async function cancelWithChannel(deps: Deps, reservationId: string, now: Date): Promise<void> {
  const { db } = deps;
  const [res] = await db.update(reservations)
    .set({ nextSyncAt: now.getTime() + SYNC_LEASE_MS })
    .where(and(
      eq(reservations.id, reservationId), eq(reservations.status, "cancelled"), eq(reservations.syncState, "pending"),
      or(isNull(reservations.nextSyncAt), lte(reservations.nextSyncAt, now.getTime())),
    ))
    .returning();
  if (!res) return;

  let r: CancelResult;
  try {
    r = await deps.channel.cancelReservation(res.code);
  } catch (e) {
    r = { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
  }
  const mine = and(
    eq(reservations.id, reservationId), eq(reservations.status, "cancelled"),
    eq(reservations.syncState, "pending"), eq(reservations.syncAttempts, res.syncAttempts),
  );
  if (r.ok) {
    await db.update(reservations).set({ syncState: "synced", nextSyncAt: null, lastSyncError: null, updatedAt: now.getTime() }).where(mine);
    return;
  }
  const error = r.error ?? "CHANNEL_CANCEL_FAILED";
  const attempts = res.syncAttempts + 1;
  if (r.retryable && res.syncAttempts < MAX_SYNC_ATTEMPTS) {
    await db.update(reservations)
      .set({ syncAttempts: attempts, nextSyncAt: now.getTime() + SYNC_RETRY_MS, lastSyncError: error, updatedAt: now.getTime() })
      .where(mine);
    return;
  }
  const failed = await db.update(reservations)
    .set({ syncState: "failed", syncAttempts: attempts, nextSyncAt: null, lastSyncError: error, updatedAt: now.getTime() })
    .where(mine).returning({ id: reservations.id });
  if (failed.length) await notifyStaff(deps, reservationId, "staff_sync_failed", now, {}, "cancel");
}
