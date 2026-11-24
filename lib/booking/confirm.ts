import { and, eq, ne, sql } from "drizzle-orm";
import type { PushResult } from "@/lib/channel/types";
import { releaseInventory, type HoldItem } from "@/lib/db/inventory-hold";
import { payments, promoCodes, reservationRooms, reservations, type NotificationKind } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { parseStay } from "@/lib/domain/dates";
import { notifyGuest, notifyStaff, type Deps } from "./notify";
import { transition, type Reservation } from "./state";
import { toChannelReservation } from "./to-channel";

/** Retries after the first failed push; the next failure after this many refunds the guest. */
export const MAX_SYNC_ATTEMPTS = 6;
export const SYNC_RETRY_MS = 5 * 60_000;

/**
 * Push a paid reservation to SiteMinder. Success confirms it; a retryable failure schedules a retry
 * in 5 minutes; a non-retryable failure, or one after MAX_SYNC_ATTEMPTS, refunds the guest.
 */
export async function confirmWithChannel(deps: Deps, reservationId: string, now: Date): Promise<void> {
  const { db } = deps;
  const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  // syncState "failed" means a refund owns this reservation (or a human does).
  if (!res || res.status !== "paid_pending_confirm" || res.syncState === "failed") return;

  let result: PushResult;
  try {
    result = await deps.channel.pushReservation(await toChannelReservation(db, reservationId));
  } catch (e) {
    result = { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
  }

  if (result.ok) {
    const ok = await transition(db, reservationId, "paid_pending_confirm", "confirmed", {
      syncState: "synced", smConfirmation: result.smConfirmation, nextSyncAt: null, lastSyncError: null,
    }, now);
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
      .set({ syncState: "pending", syncAttempts: attempts, nextSyncAt: now.getTime() + SYNC_RETRY_MS, lastSyncError: result.error, updatedAt: now.getTime() })
      .where(and(eq(reservations.id, reservationId), eq(reservations.status, "paid_pending_confirm"), eq(reservations.syncAttempts, res.syncAttempts)));
    return;
  }
  await refundAndFail(deps, reservationId, result.error, now, {
    guestKind: "booking_failed_refunded", staffKind: "staff_sync_failed", patch: { syncAttempts: attempts },
  });
}

/**
 * Refund every succeeded charge in full and move a `paid_pending_confirm` reservation to
 * `confirm_failed_refunded`, releasing its inventory if it still holds any.
 * It first claims the reservation (syncState → "failed") so no retry or second caller races it.
 * If a refund fails, the status is left alone, the error is recorded and staff are alerted.
 * Returns true when the reservation ended refunded.
 */
export async function refundAndFail(
  deps: Deps, reservationId: string, reason: string, now: Date,
  o: { guestKind?: NotificationKind; staffKind: NotificationKind; patch?: Partial<Reservation> },
): Promise<boolean> {
  const { db, gateway } = deps;
  const [res] = await db.update(reservations)
    .set({ ...o.patch, syncState: "failed", nextSyncAt: null, lastSyncError: reason, updatedAt: now.getTime() })
    .where(and(eq(reservations.id, reservationId), eq(reservations.status, "paid_pending_confirm"), ne(reservations.syncState, "failed")))
    .returning();
  if (!res) return false;

  const charges = await db.select().from(payments)
    .where(and(eq(payments.reservationId, reservationId), eq(payments.kind, "charge"), eq(payments.status, "succeeded")));
  let refunded = 0;
  let error: string | undefined;
  for (const c of charges) {
    if (!c.providerRef) { error = "NO_PROVIDER_REF"; break; }
    let r: Awaited<ReturnType<typeof gateway.refund>>;
    try {
      r = await gateway.refund({ providerRef: c.providerRef, amount: c.amount, reason });
    } catch (e) {
      r = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!r.ok) { error = r.error; break; }
    await db.insert(payments).values({
      id: crypto.randomUUID(), reservationId, kind: "refund", method: c.method, amount: c.amount,
      status: "succeeded", providerRef: r.refundRef, createdAt: now.getTime(),
    });
    refunded += c.amount;
  }
  const refundedAmount = res.refundedAmount + refunded;

  if (error) {
    await db.update(reservations)
      .set({ refundedAmount, lastSyncError: `REFUND_FAILED: ${error} (${reason})`, updatedAt: now.getTime() })
      .where(eq(reservations.id, reservationId));
    await notifyStaff(deps, reservationId, "staff_payment_alert", now);
    return false;
  }

  const held = res.holdExpiresAt != null;
  if (!await transition(db, reservationId, "paid_pending_confirm", "confirm_failed_refunded", { refundedAmount, holdExpiresAt: null }, now))
    return false;
  if (held) await releaseInventory(db, await holdItemsFor(db, res));
  if (o.guestKind) await notifyGuest(deps, reservationId, o.guestKind, now, { refundAmount: refundedAmount });
  await notifyStaff(deps, reservationId, o.staffKind, now, { refundAmount: refundedAmount });
  return true;
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
