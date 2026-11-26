import { and, eq, exists, isNull, lte, ne, or, sql } from "drizzle-orm";
import { runAtomic } from "@/lib/db/atomic";
import { holdStatements, isCheckViolation, releaseInventory, type HoldItem } from "@/lib/db/inventory-hold";
import { payments, promoCodes, reservationRooms, reservations, type NotificationKind } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { parseStay } from "@/lib/domain/dates";
import type { Quote } from "@/lib/domain/quote";
import { notifyGuest, notifyStaff, onlineNetAmount, refundableCharges, type ChargeRow, type Deps } from "./notify";
import { kickChannelSync, SYNC_LEASE_MS } from "./channel-sync";
import { transition, type Reservation } from "./state";

/**
 * Drive a `paid_pending_confirm` booking to its end state. Safe to call from any number of workers:
 * it first takes a short lease, and does nothing if another worker holds it or the time is not due.
 * - Money held ≠ payNow → refund in full (staff alert).
 * - No inventory held (paid after expiry) → take it again, or refund if sold out.
 * - Otherwise the booking is confirmed here and now (the guest and staff are emailed) and handed to the channel
 *   (kickChannelSync): the push runs in the background, is retried until it succeeds and never refunds the guest
 *   (owner decision 2026-11-27; SiteMinder does not accept or reject bookings, doc §3.4).
 */
export async function confirmPaid(deps: Deps, reservationId: string, now: Date): Promise<void> {
  const { db } = deps;
  const res = await takeConfirmLease(db, reservationId, now);
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

  // A refund that claimed the booking (syncState "failed") wins. The push is due at once. A booking left by the
  // earlier design with push attempts already made may be at the channel: it counts as pushed.
  const ok = await transition(db, reservationId, "paid_pending_confirm", "confirmed", {
    syncState: "pending", syncAttempts: 0, nextSyncAt: now.getTime(), lastSyncError: null,
    ...(res.syncAttempts > 0 ? { channelPushedAt: sql`coalesce(${reservations.channelPushedAt}, ${now.getTime()})` } : {}),
  }, now, ne(reservations.syncState, "failed"));
  if (!ok) return;
  if (res.promoCode)
    await db.update(promoCodes).set({ usedCount: sql`${promoCodes.usedCount} + 1` })
      .where(and(eq(promoCodes.propertyId, res.propertyId), eq(promoCodes.code, res.promoCode)));
  await notifyGuest(deps, reservationId, "booking_confirmed", now);
  await notifyStaff(deps, reservationId, "staff_new_booking", now);
  await kickChannelSync(deps, reservationId, now);
}

/** One conditional UPDATE: own the booking for SYNC_LEASE_MS if it is due and nobody else owns it. */
async function takeConfirmLease(db: Db, reservationId: string, now: Date): Promise<Reservation | undefined> {
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
 * `confirm_failed_refunded`, releasing its inventory if it still holds any. Only genuine payment problems get here
 * (amount mismatch, sold out after a late payment): a booking is never refunded because the channel hand-off failed.
 * It first claims the reservation (syncState → "failed"); after that it cannot be confirmed.
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
 * is left on every charge, then `confirm_failed_refunded` (channel cancel queued only for a booking the earlier design
 * had already tried to push), release, emails. Refund reconciliation calls it again once a stuck refund is settled by hand; refunds already settled
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
  // A paid_pending_confirm booking is never pushed now. Only one the earlier design already tried to push (and then
  // refunded) may be at the channel: it is queued for the channel cancel (re-push, then cancel; channel-sync.ts).
  const check = res.syncAttempts > 0
    ? { syncState: "pending" as const, syncAttempts: 0, nextSyncAt: now.getTime(), channelPushedAt: sql`coalesce(${reservations.channelPushedAt}, ${now.getTime()})` } : {};
  if (!await transition(db, reservationId, "paid_pending_confirm", "confirm_failed_refunded", { holdExpiresAt: null, ...check }, now))
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
 * idempotency key. `notifyGuest: false` is stored on a row this call creates (see payments.notifyGuest). By the row's status:
 * - `succeeded`: nothing to do, report success.
 * - `pending`: another attempt is in flight, or died with an unknown outcome → never call the gateway;
 *   report `pendingRefundId` so the caller alerts staff.
 * - `failed`: one attempt flips it back to `pending` (conditional UPDATE) and retries.
 * Gateway success marks the row `succeeded` (with `countsAsBookingRefund`, also adds it to the
 * booking's refundedAmount, in the same batch); a definite rejection marks it `failed`. When the outcome is
 * unknown (the call threw, or the gateway reports `outcomeUnknown`: timeout, network error) the gateway is
 * asked with queryRefund(key) instead: `succeeded` settles the row as above, `failed` / `not_found` marks
 * it `failed` (retrying is safe), `pending` or a failed query leaves it `pending` for refund reconciliation.
 */
export async function refundOnce(
  deps: Deps, key: string, charge: ChargeRow, amount: number, reason: string, now: Date,
  o: { countsAsBookingRefund?: boolean; notifyGuest?: boolean } = {},
): Promise<RefundOutcome> {
  const { db } = deps;
  if (!charge.providerRef) return { ok: false, error: "NO_PROVIDER_REF" };
  const created = await db.insert(payments).values({
    id: crypto.randomUUID(), reservationId: charge.reservationId, kind: "refund", method: charge.method, amount,
    status: "pending", refundOf: charge.id, idempotencyKey: key, createdAt: now.getTime(),
    ...(o.notifyGuest === false ? { notifyGuest: false } : {}),
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

  const pending = row;
  const markFailed = async (error: string): Promise<RefundOutcome> => {
    await markRefundFailed(db, pending.id);
    return { ok: false, error, refundId: pending.id };
  };
  let refundRef: string | null;
  const r = await deps.gateway.refund({ providerRef: charge.providerRef, amount: row.amount, reason, idempotencyKey: key })
    .catch((e: unknown) => ({ ok: false as const, error: errorText(e), outcomeUnknown: true }));
  if (r.ok) refundRef = r.refundRef;
  else if (!r.outcomeUnknown) return markFailed(r.error);
  else {
    // The call may have reached the provider (timeout, network): ask it rather than assume either way.
    const q = await deps.gateway.queryRefund(key).catch((e: unknown) => ({ error: errorText(e) }));
    if ("error" in q || q.status === "pending") {
      const why = "error" in q ? `query ${q.error}` : "query pending";
      return { ok: false, error: `REFUND_OUTCOME_UNKNOWN: ${r.error}; ${why}`, pendingRefundId: row.id, refundId: row.id };
    }
    if (q.status !== "succeeded") return markFailed(`${r.error}; query ${q.status}`);
    refundRef = q.refundRef ?? null;
  }
  await settleRefundRow(db, row, refundRef, !!o.countsAsBookingRefund, now);
  return { ok: true, amount: row.amount };
}

/**
 * Mark a refund row the gateway confirmed as made `succeeded` (with its refund ref, settledAt = now), and with
 * `countsAsBookingRefund` add its amount to the booking's refundedAmount, in one batch.
 * Only the first writer to settle the row counts it: staff may have marked it succeeded by hand
 * (refund reconciliation) while a call was in flight. The bump runs first, while the row is unsettled.
 * Used by refundOnce and by the gateway reconcile job (a pending row whose queryRefund says succeeded).
 */
export async function settleRefundRow(
  db: Db, row: Pick<PaymentRow, "id" | "amount" | "reservationId">, refundRef: string | null, countsAsBookingRefund: boolean,
  now: Date,
): Promise<void> {
  const unsettled = and(eq(payments.id, row.id), ne(payments.status, "succeeded"));
  await runAtomic(db, [
    ...(countsAsBookingRefund
      ? [db.update(reservations).set({ refundedAmount: sql`${reservations.refundedAmount} + ${row.amount}` })
        .where(and(eq(reservations.id, row.reservationId), exists(db.select({ one: sql`1` }).from(payments).where(unsettled))))]
      : []),
    db.update(payments).set({ status: "succeeded", providerRef: refundRef, settledAt: now.getTime() }).where(unsettled),
  ]);
}

/** A refund row the gateway definitely did not make: pending → failed (only while still pending), so it may be retried. */
export async function markRefundFailed(db: Db, refundId: string): Promise<void> {
  await db.update(payments).set({ status: "failed" }).where(and(eq(payments.id, refundId), eq(payments.status, "pending")));
}

/** Refunds that count toward the booking's refundedAmount (cancellations and failed bookings); stray-charge and modification refunds do not. */
export const countsAsBookingRefund = (key: string | null) => !!key && (key.startsWith("cancel:") || key.startsWith("fail:"));

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
