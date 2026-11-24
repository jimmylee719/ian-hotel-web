import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { CancelResult } from "@/lib/channel/types";
import { releaseInventory } from "@/lib/db/inventory-hold";
import { payments, ratePlans, reservationRooms, reservations, unitTypes, type I18n } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { refundAmount } from "@/lib/domain/cancellation";
import type { Quote } from "@/lib/domain/quote";
import { holdItemsFor, MAX_SYNC_ATTEMPTS, refundCharge, SYNC_LEASE_MS, SYNC_RETRY_MS, type RefundOutcome } from "./confirm";
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
  const [room] = await db.select({ unitName: unitTypes.name, planName: ratePlans.name })
    .from(reservationRooms)
    .innerJoin(unitTypes, eq(unitTypes.id, reservationRooms.unitTypeId))
    .innerJoin(ratePlans, eq(ratePlans.id, reservationRooms.ratePlanId))
    .where(eq(reservationRooms.reservationId, res.id))
    .limit(1);
  const canCancel = res.status === "confirmed";
  return {
    code: res.code,
    status: res.status,
    checkIn: res.checkIn,
    checkOut: res.checkOut,
    roomTypeName: room.unitName,
    ratePlanName: room.planName,
    quote: res.quote as Quote,
    paid: await paidAmount(db, res.id),
    refunded: res.refundedAmount,
    refundIfCancelledNow: canCancel ? (await cancellationRefund(db, res, now, null)).target : 0,
    canCancel,
  };
}

/**
 * What cancelling refunds: the rate plan's policy applied to the net amount paid, at the time the
 * cancellation was first asked for. The preview (`claimedAt` null) and the actual cancel share this.
 * A cancellation taken over after a crash counts the refund an earlier attempt already recorded
 * against the paying charge (since `claimedAt`), so it is never refunded twice: `due` is what is left.
 */
async function cancellationRefund(db: Db, res: Reservation, now: Date, claimedAt: number | null) {
  const [plan] = await db.select({ policy: ratePlans.cancelPolicy }).from(reservationRooms)
    .innerJoin(ratePlans, eq(ratePlans.id, reservationRooms.ratePlanId))
    .where(eq(reservationRooms.reservationId, res.id))
    .limit(1);
  const payingId = await payingChargeId(db, res.id);
  const paying = (await refundableCharges(db, res.id)).find((c) => c.id === payingId);
  const done = claimedAt == null || !payingId ? 0 : (await db.select({ amount: payments.amount }).from(payments).where(and(
    eq(payments.kind, "refund"), eq(payments.status, "succeeded"), eq(payments.refundOf, payingId), gte(payments.createdAt, claimedAt),
  ))).reduce((s, r) => s + r.amount, 0);
  const paid = await paidAmount(db, res.id) + done;
  const target = refundAmount(plan.policy, paid, res.checkIn, claimedAt == null ? now : new Date(claimedAt));
  return { target, due: target - done, paying };
}

/**
 * Cancel a confirmed reservation for the guest and refund what the policy allows.
 * 1. Claim it: stamp `cancelledAt` (status stays `confirmed`) unless another request holds a fresh claim.
 * 2. Refund against the paying charge. On failure the claim is dropped, the booking stays `confirmed`
 *    and staff are alerted.
 * 3. `confirmed` → `cancelled` with the refund recorded and the channel cancel queued (syncState pending).
 * 4. Give the rooms back, 5. cancel on the channel (the retry job retries), 6. email guest and staff.
 */
export async function cancelReservation(deps: Deps, code: string, email: string, now: Date): Promise<CancelOutcome> {
  const { db } = deps;
  const res = await lookup(db, code, email);
  if (!res) return { ok: false, error: "NOT_FOUND" };
  if (res.status === "cancelled") return { ok: true, refunded: res.refundedAmount, alreadyCancelled: true };
  if (res.status !== "confirmed") return { ok: false, error: "NOT_CANCELLABLE" };

  const claim = await claimCancellation(db, res.id, now);
  if (!claim) return settledElsewhere(db, res.id);
  const claimedAt = claim.cancelledAt!;

  const { target, due, paying } = await cancellationRefund(db, claim, now, claimedAt);
  if (due > 0) {
    const r: RefundOutcome = !paying ? { ok: false, error: "NO_PAYING_CHARGE" }
      : paying.remaining < due ? { ok: false, error: `REFUNDABLE_${paying.remaining}_LT_${due}` }
      : await refundCharge(deps, paying, due, "GUEST_CANCELLED", now, { countsAsBookingRefund: true });
    if (!r.ok) {
      await db.update(reservations)
        .set({ cancelledAt: null, lastSyncError: `CANCEL_REFUND_FAILED: ${r.error}`, updatedAt: now.getTime() })
        .where(and(eq(reservations.id, res.id), eq(reservations.status, "confirmed"), eq(reservations.updatedAt, claim.updatedAt)));
      const ref = r.pendingRefundId ?? `cancel-refund-failed:${now.getTime()}`;
      await notifyStaff(deps, res.id, "staff_payment_alert", now, { refundAmount: due }, ref);
      return { ok: false, error: "REFUND_FAILED" };
    }
  }

  // refundCharge already added the refund to refundedAmount.
  // nextSyncAt = now: from this moment the retry job is the safety net for the channel cancel.
  const cancelled = await transition(db, res.id, "confirmed", "cancelled", {
    holdExpiresAt: null,
    syncState: "pending", syncAttempts: 0, nextSyncAt: now.getTime(), lastSyncError: null,
  }, now, eq(reservations.cancelledAt, claimedAt));
  if (!cancelled) return settledElsewhere(db, res.id);

  if (claim.holdExpiresAt != null) await releaseInventory(db, await holdItemsFor(db, claim));
  await cancelWithChannel(deps, res.id, now);
  await notifyGuest(deps, res.id, "cancelled", now, { refundAmount: target });
  await notifyStaff(deps, res.id, "cancelled", now, { refundAmount: target });
  return { ok: true, refunded: target, alreadyCancelled: false };
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
