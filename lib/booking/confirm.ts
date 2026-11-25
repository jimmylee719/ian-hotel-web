import { and, eq, exists, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { PushResult } from "@/lib/channel/types";
import { runAtomic } from "@/lib/db/atomic";
import { holdStatements, isCheckViolation, releaseInventory, type HoldItem } from "@/lib/db/inventory-hold";
import { payments, promoCodes, reservationRooms, reservations, type NotificationKind } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { parseStay } from "@/lib/domain/dates";
import type { Quote } from "@/lib/domain/quote";
import { notifyGuest, notifyStaff, onlineNetAmount, refundableCharges, type ChargeRow, type Deps } from "./notify";
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
 *   A retry first looks the code up: if the channel already holds it (a push that timed out but landed),
 *   its smConfirmation is the success and nothing is pushed. A failed lookup just falls back to the push,
 *   which is idempotent by code.
 */
export async function confirmWithChannel(deps: Deps, reservationId: string, now: Date): Promise<void> {
  const { db } = deps;
  const res = await takeSyncLease(db, reservationId, now);
  if (!res) return;

  const payNow = (res.quote as Quote).payNow;
  const paid = await onlineNetAmount(db, reservationId); // what the gateway took, against what it should have
  if (paid !== payNow) {
    await refundAndFail(deps, reservationId, `AMOUNT_MISMATCH: expected ${payNow}, got ${paid}`, now, {
      guestKind: "payment_refunded", staffKind: "staff_payment_alert",
    });
    return;
  }
  if (res.holdExpiresAt == null && !await reHold(db, res, now)) {
    await refundAndFail(deps, reservationId, "SOLD_OUT_AFTER_EXPIRY", now, { guestKind: "booking_failed_refunded", staffKind: "staff_payment_alert" });
    return;
  }

  // After a retryable failure the push may have landed with its answer lost: ask before pushing again.
  let result = res.syncAttempts > 0 ? await activeOnChannel(deps, res.code) : undefined;
  if (!result) {
    try {
      result = await deps.channel.pushReservation(await toChannelReservation(db, reservationId));
    } catch (e) {
      result = { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
    }
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

/** A successful push result if the channel already holds `code` as active; otherwise (or if the lookup fails) undefined. */
async function activeOnChannel(deps: Deps, code: string): Promise<PushResult | undefined> {
  try {
    const l = await deps.channel.lookupReservation(code);
    if ("found" in l && l.found && l.state === "active") return { ok: true, smConfirmation: l.smConfirmation };
  } catch {
    // The push decides.
  }
  return undefined;
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
 * `confirm_failed_refunded`, releasing its inventory if it still holds any, and queues a channel check
 * (syncState → "pending"; the retry job cancels it at the channel if a push landed after all).
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
  return finishRefundAndFail(deps, res, reason, now, o);
}

export type RefundAndFailKinds = { guestKind?: NotificationKind; staffKind: NotificationKind };

/**
 * The steps of refundAndFail after its claim (`res` is the claimed row, syncState "failed"): refund what
 * is left on every charge, then `confirm_failed_refunded` (channel check queued: syncState pending), release,
 * emails. Refund reconciliation calls it again once a stuck refund is settled by hand; refunds already settled
 * are skipped.
 */
export async function finishRefundAndFail(
  deps: Deps, res: Reservation, reason: string, now: Date, o: RefundAndFailKinds,
): Promise<boolean> {
  const { db } = deps;
  const reservationId = res.id;
  let refunded = 0;
  for (const c of await refundableCharges(db, reservationId)) {
    if (c.remaining <= 0) continue;
    const r = await refundOnce(deps, `fail:${reservationId}:${c.id}`, c, c.remaining, reason, now, { countsAsBookingRefund: true });
    if (!r.ok) {
      await db.update(reservations)
        .set({ lastSyncError: `REFUND_FAILED: ${r.error} (${reason})`, updatedAt: now.getTime() })
        .where(eq(reservations.id, reservationId));
      // Keyed by the refund intent row, never "", so this alert is not deduped against another one.
      await notifyStaff(deps, reservationId, "staff_payment_alert", now, {}, r.refundId ?? `fail:${reservationId}:${c.id}`);
      return false;
    }
    refunded += r.amount;
  }
  const refundedAmount = res.refundedAmount + refunded;

  const held = res.holdExpiresAt != null;
  // A push may have reached the channel even though none succeeded here (answer lost, or one still in flight):
  // queue a channel check for the retry job (cancelWithChannel), due once any in-flight push is past its lease.
  if (!await transition(db, reservationId, "paid_pending_confirm", "confirm_failed_refunded", {
    holdExpiresAt: null, syncState: "pending", syncAttempts: 0, nextSyncAt: now.getTime() + SYNC_LEASE_MS,
  }, now))
    return false;
  if (held) await releaseInventory(db, await holdItemsFor(db, res));
  if (o.guestKind) await notifyGuest(deps, reservationId, o.guestKind, now, { refundAmount: refundedAmount });
  await notifyStaff(deps, reservationId, o.staffKind, now, { refundAmount: refundedAmount });
  return true;
}

export type RefundOutcome =
  | { ok: true; amount: number }
  | {
      ok: false;
      error: string;
      /** Set when the refund's outcome is unknown (row still pending). */
      pendingRefundId?: string;
      /** The refund intent row, whenever one exists (pending or failed): the ref for staff alerts. */
      refundId?: string;
    };

export type PaymentRow = typeof payments.$inferSelect;

/**
 * Make the refund identified by `key` happen at most once, however many attempts run it.
 * The first attempt creates the intent row (`pending`, with `amount`); every later attempt reads that
 * row back and uses ITS amount (the `amount` passed in is ignored then). `key` is also the gateway's
 * idempotency key. By the row's status:
 * - `succeeded`: nothing to do, report success.
 * - `pending`: another attempt is in flight, or died with an unknown outcome → never call the gateway;
 *   report `pendingRefundId` so the caller alerts staff.
 * - `failed`: one attempt flips it back to `pending` (conditional UPDATE) and retries.
 * Gateway success marks the row `succeeded` (with `countsAsBookingRefund`, also adds it to the
 * booking's refundedAmount, in the same batch); a definitive failure marks it `failed`; a thrown call
 * leaves it `pending`.
 */
export async function refundOnce(
  deps: Deps, key: string, charge: ChargeRow, amount: number, reason: string, now: Date,
  o: { countsAsBookingRefund?: boolean } = {},
): Promise<RefundOutcome> {
  const { db } = deps;
  if (!charge.providerRef) return { ok: false, error: "NO_PROVIDER_REF" };
  const created = await db.insert(payments).values({
    id: crypto.randomUUID(), reservationId: charge.reservationId, kind: "refund", method: charge.method, amount,
    status: "pending", refundOf: charge.id, idempotencyKey: key, createdAt: now.getTime(),
  }).onConflictDoNothing({ target: payments.idempotencyKey }).returning();
  let row: PaymentRow | undefined = created[0];
  if (!row) {
    const [existing] = await db.select().from(payments).where(eq(payments.idempotencyKey, key));
    if (existing.status === "succeeded") return { ok: true, amount: existing.amount };
    if (existing.status === "pending")
      return { ok: false, error: `REFUND_OUTCOME_UNKNOWN: ${existing.id}`, pendingRefundId: existing.id, refundId: existing.id };
    [row] = await db.update(payments).set({ status: "pending" })
      .where(and(eq(payments.id, existing.id), eq(payments.status, "failed"))).returning();
    if (!row) return refundOnce(deps, key, charge, amount, reason, now, o); // another attempt won the retry
  }

  let r: Awaited<ReturnType<Deps["gateway"]["refund"]>>;
  try {
    r = await deps.gateway.refund({ providerRef: charge.providerRef, amount: row.amount, reason, idempotencyKey: key });
  } catch (e) {
    return { ok: false, error: `REFUND_OUTCOME_UNKNOWN: ${e instanceof Error ? e.message : String(e)}`, pendingRefundId: row.id, refundId: row.id };
  }
  if (!r.ok) {
    await db.update(payments).set({ status: "failed" }).where(and(eq(payments.id, row.id), eq(payments.status, "pending")));
    return { ok: false, error: r.error, refundId: row.id };
  }
  // Only the first writer to settle the row counts it: staff may have marked it succeeded by hand
  // (refund reconciliation) while this call was in flight. The bump runs first, while the row is unsettled.
  const unsettled = and(eq(payments.id, row.id), ne(payments.status, "succeeded"));
  await runAtomic(db, [
    ...(o.countsAsBookingRefund
      ? [db.update(reservations).set({ refundedAmount: sql`${reservations.refundedAmount} + ${row.amount}` })
        .where(and(eq(reservations.id, charge.reservationId), exists(db.select({ one: sql`1` }).from(payments).where(unsettled))))]
      : []),
    db.update(payments).set({ status: "succeeded", providerRef: r.refundRef }).where(unsettled),
  ]);
  return { ok: true, amount: row.amount };
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
