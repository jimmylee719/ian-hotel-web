import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { PushResult } from "@/lib/channel/types";
import { runAtomic } from "@/lib/db/atomic";
import { holdStatements, isCheckViolation, releaseInventory, type HoldItem } from "@/lib/db/inventory-hold";
import { payments, promoCodes, reservationRooms, reservations, type NotificationKind } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { parseStay } from "@/lib/domain/dates";
import type { Quote } from "@/lib/domain/quote";
import { notifyGuest, notifyStaff, paidAmount, refundableCharges, type ChargeRow, type Deps } from "./notify";
import { transition, type Reservation } from "./state";
import { toChannelReservation } from "./to-channel";

/** Retries after the first failed push; the next failure after this many refunds the guest. */
export const MAX_SYNC_ATTEMPTS = 6;
export const SYNC_RETRY_MS = 5 * 60_000;
/** How long one worker owns a booking while it pushes; after that the retry job may take over. */
export const SYNC_LEASE_MS = 2 * 60_000;

/**
 * Drive a `paid_pending_confirm` booking to its end state. Safe to call from any number of workers:
 * it first takes a short lease, and does nothing if another worker holds it or the time is not due.
 * - Money held ≠ payNow → refund in full (staff alert).
 * - No inventory held (paid after expiry) → take it again, or refund if sold out.
 * - Otherwise push to SiteMinder: success confirms; a retryable failure retries in 5 minutes;
 *   a non-retryable failure, or one after MAX_SYNC_ATTEMPTS retries, refunds.
 */
export async function confirmWithChannel(deps: Deps, reservationId: string, now: Date): Promise<void> {
  const { db } = deps;
  const res = await takeSyncLease(db, reservationId, now);
  if (!res) return;

  const payNow = (res.quote as Quote).payNow;
  const paid = await paidAmount(db, reservationId);
  if (paid !== payNow) {
    await refundAndFail(deps, reservationId, `AMOUNT_MISMATCH: expected ${payNow}, got ${paid}`, now, { staffKind: "staff_payment_alert" });
    return;
  }
  if (res.holdExpiresAt == null && !await reHold(db, res, now)) {
    await refundAndFail(deps, reservationId, "SOLD_OUT_AFTER_EXPIRY", now, { guestKind: "booking_failed_refunded", staffKind: "staff_payment_alert" });
    return;
  }

  let result: PushResult;
  try {
    result = await deps.channel.pushReservation(await toChannelReservation(db, reservationId));
  } catch (e) {
    result = { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
  }

  if (result.ok) {
    // A refund that claimed the booking (syncState "failed") during the push wins.
    const ok = await transition(db, reservationId, "paid_pending_confirm", "confirmed", {
      syncState: "synced", smConfirmation: result.smConfirmation, nextSyncAt: null, lastSyncError: null,
    }, now, ne(reservations.syncState, "failed"));
    if (!ok) return;
    if (res.promoCode)
      await db.update(promoCodes).set({ usedCount: sql`${promoCodes.usedCount} + 1` })
        .where(and(eq(promoCodes.propertyId, res.propertyId), eq(promoCodes.code, res.promoCode)));
    await notifyGuest(deps, reservationId, "booking_confirmed", now);
    await notifyStaff(deps, reservationId, "staff_new_booking", now);
    return;
  }

  const attempts = res.syncAttempts + 1;
  if (result.retryable && res.syncAttempts < MAX_SYNC_ATTEMPTS) {
    await db.update(reservations)
      .set({ syncAttempts: attempts, nextSyncAt: now.getTime() + SYNC_RETRY_MS, lastSyncError: result.error, updatedAt: now.getTime() })
      .where(and(
        eq(reservations.id, reservationId), eq(reservations.status, "paid_pending_confirm"),
        eq(reservations.syncState, "pending"), eq(reservations.syncAttempts, res.syncAttempts),
      ));
    return;
  }
  await refundAndFail(deps, reservationId, result.error, now, {
    guestKind: "booking_failed_refunded", staffKind: "staff_sync_failed", patch: { syncAttempts: attempts },
  });
}

/** One conditional UPDATE: own the booking for SYNC_LEASE_MS if it is due and nobody else owns it. */
async function takeSyncLease(db: Db, reservationId: string, now: Date): Promise<Reservation | undefined> {
  const [res] = await db.update(reservations)
    .set({ nextSyncAt: now.getTime() + SYNC_LEASE_MS })
    .where(and(
      eq(reservations.id, reservationId), eq(reservations.status, "paid_pending_confirm"), eq(reservations.syncState, "pending"),
      or(isNull(reservations.nextSyncAt), lte(reservations.nextSyncAt, now.getTime())),
    ))
    .returning();
  return res;
}

/** Take the rooms again for a booking paid after its hold lapsed. The hold and its marker commit together. */
async function reHold(db: Db, res: Reservation, now: Date): Promise<boolean> {
  const stmts = await holdStatements(db, await holdItemsFor(db, res));
  if (!stmts) return false;
  try {
    await runAtomic(db, [
      ...stmts,
      db.update(reservations).set({ holdExpiresAt: now.getTime() })
        .where(and(eq(reservations.id, res.id), isNull(reservations.holdExpiresAt))),
    ]);
    return true;
  } catch (e) {
    if (isCheckViolation(e)) return false;
    throw e;
  }
}

/**
 * Refund what is left on every succeeded charge and move a `paid_pending_confirm` reservation to
 * `confirm_failed_refunded`, releasing its inventory if it still holds any.
 * It first claims the reservation (syncState → "failed"); after that no push can confirm it.
 * If a refund fails, the status is left alone, the error is recorded and staff are alerted.
 * Returns true when the reservation ended refunded.
 */
export async function refundAndFail(
  deps: Deps, reservationId: string, reason: string, now: Date,
  o: { guestKind?: NotificationKind; staffKind: NotificationKind; patch?: Partial<Reservation> },
): Promise<boolean> {
  const { db } = deps;
  const [res] = await db.update(reservations)
    .set({ ...o.patch, syncState: "failed", nextSyncAt: null, lastSyncError: reason, updatedAt: now.getTime() })
    .where(and(eq(reservations.id, reservationId), eq(reservations.status, "paid_pending_confirm"), ne(reservations.syncState, "failed")))
    .returning();
  if (!res) return false;

  let refunded = 0;
  for (const c of await refundableCharges(db, reservationId)) {
    if (c.remaining <= 0) continue;
    const r = await refundCharge(deps, c, c.remaining, reason, now, { countsAsBookingRefund: true });
    if (!r.ok) {
      await db.update(reservations)
        .set({ lastSyncError: `REFUND_FAILED: ${r.error} (${reason})`, updatedAt: now.getTime() })
        .where(eq(reservations.id, reservationId));
      await notifyStaff(deps, reservationId, "staff_payment_alert", now, {}, r.pendingRefundId ?? "");
      return false;
    }
    refunded += c.remaining;
  }
  const refundedAmount = res.refundedAmount + refunded;

  const held = res.holdExpiresAt != null;
  if (!await transition(db, reservationId, "paid_pending_confirm", "confirm_failed_refunded", { holdExpiresAt: null }, now))
    return false;
  if (held) await releaseInventory(db, await holdItemsFor(db, res));
  if (o.guestKind) await notifyGuest(deps, reservationId, o.guestKind, now, { refundAmount: refundedAmount });
  await notifyStaff(deps, reservationId, o.staffKind, now, { refundAmount: refundedAmount });
  return true;
}

export type RefundOutcome = { ok: true } | { ok: false; error: string; pendingRefundId?: string };

/**
 * Refund `amount` of one charge against its own provider ref.
 * The refund row is written first as a `pending` intent and its id is the gateway's idempotency key;
 * success marks it `succeeded` (and, with `countsAsBookingRefund`, adds it to the booking's
 * refundedAmount in the same batch), a definitive failure marks it `failed`. A thrown gateway call has
 * an unknown outcome, so the intent stays `pending`. While any refund of the booking is `pending`,
 * no new refund is started: it may already have happened, and only a human can reconcile it.
 * Callers alert staff with `pendingRefundId` as the ref when it is set.
 */
export async function refundCharge(
  deps: Deps, charge: ChargeRow, amount: number, reason: string, now: Date, o: { countsAsBookingRefund?: boolean } = {},
): Promise<RefundOutcome> {
  const { db } = deps;
  if (!charge.providerRef) return { ok: false, error: "NO_PROVIDER_REF" };
  const [pending] = await db.select({ id: payments.id }).from(payments).where(and(
    eq(payments.reservationId, charge.reservationId), eq(payments.kind, "refund"), eq(payments.status, "pending"),
  )).limit(1);
  if (pending) return { ok: false, error: `REFUND_OUTCOME_UNKNOWN: ${pending.id}`, pendingRefundId: pending.id };

  const id = crypto.randomUUID();
  await db.insert(payments).values({
    id, reservationId: charge.reservationId, kind: "refund", method: charge.method, amount,
    status: "pending", refundOf: charge.id, createdAt: now.getTime(),
  });
  let r: Awaited<ReturnType<Deps["gateway"]["refund"]>>;
  try {
    r = await deps.gateway.refund({ providerRef: charge.providerRef, amount, reason, idempotencyKey: id });
  } catch (e) {
    return { ok: false, error: `REFUND_OUTCOME_UNKNOWN: ${e instanceof Error ? e.message : String(e)}`, pendingRefundId: id };
  }
  if (!r.ok) {
    await db.update(payments).set({ status: "failed" }).where(eq(payments.id, id));
    return r;
  }
  await runAtomic(db, [
    db.update(payments).set({ status: "succeeded", providerRef: r.refundRef }).where(eq(payments.id, id)),
    ...(o.countsAsBookingRefund
      ? [db.update(reservations).set({ refundedAmount: sql`${reservations.refundedAmount} + ${amount}` }).where(eq(reservations.id, charge.reservationId))]
      : []),
  ]);
  return { ok: true };
}

/** The inventory a reservation holds: its rooms grouped by room type and rate plan, for every night. */
export async function holdItemsFor(db: Db, res: Pick<Reservation, "id" | "checkIn" | "checkOut">): Promise<HoldItem[]> {
  const stay = parseStay(res.checkIn, res.checkOut);
  if (!stay.ok) throw new Error(`Reservation ${res.id} has an invalid stay: ${stay.error}`);
  const rooms = await db.select().from(reservationRooms).where(eq(reservationRooms.reservationId, res.id));
  const items = new Map<string, HoldItem>();
  for (const r of rooms) {
    const key = `${r.unitTypeId}|${r.ratePlanId}`;
    const item = items.get(key) ?? { unitTypeId: r.unitTypeId, ratePlanId: r.ratePlanId, nights: stay.nights, rooms: 0 };
    item.rooms++;
    items.set(key, item);
  }
  return [...items.values()];
}
