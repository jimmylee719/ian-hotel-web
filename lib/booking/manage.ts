import { and, eq, exists, isNull, lte, notExists, or, sql } from "drizzle-orm";
import type { CancelResult } from "@/lib/channel/types";
import { releaseInventory, type HoldItem } from "@/lib/db/inventory-hold";
import { payments, ratePlans, reservationRooms, reservations, unitTypes, type I18n } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { todayInTaipei, type ISODate } from "@/lib/domain/dates";
import { refundAmount } from "@/lib/domain/cancellation";
import type { Quote } from "@/lib/domain/quote";
import { holdItemsFor, MAX_SYNC_ATTEMPTS, refundOnce, SYNC_LEASE_MS, SYNC_RETRY_MS, type RefundOutcome } from "./confirm";
import { moneyHeld, notifyGuest, notifyStaff, receivedAmount, refundableCharges, type Deps } from "./notify";
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
  /** Total received (online net + front-desk net). */
  paid: number;
  refunded: number;
  /** The whole refund a cancel now would give (online and at the front desk). */
  refundIfCancelledNow: number;
  canCancel: boolean;
};

export type CancelOutcome =
  | {
      ok: true;
      /** Refunded online, through the gateway. */
      refunded: number;
      /** Present (> 0) when part of the refund is front-desk money the desk must hand back. */
      frontDeskRefundDue?: number;
      alreadyCancelled: boolean;
    }
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
    paid: await receivedAmount(db, res.id),
    refunded: res.refundedAmount,
    refundIfCancelledNow: canCancel ? refundTotal(await cancelRefundPlan(db, res, now)) : 0,
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
export const cancelKey = (reservationId: string) => `cancel:${reservationId}`;

async function cancelIntent(db: Db, reservationId: string) {
  const [row] = await db.select().from(payments).where(eq(payments.idempotencyKey, cancelKey(reservationId)));
  return row;
}

/** A cancellation's refund, split by where the money goes back from. */
export type CancelRefundPlan = {
  /** Through the gateway, against the paying charge: at most the online net. */
  online: number;
  /** The rest, which the front desk hands back (front-desk money cannot go back online). */
  frontDesk: number;
};

export const refundTotal = (p: CancelRefundPlan) => p.online + p.frontDesk;

/** Present only when there is something for the desk to hand back, so results without one are unchanged. */
const frontDeskField = (amount: number) => (amount > 0 ? { frontDeskRefundDue: amount } : {});

/**
 * What cancelling refunds. Once an attempt has created the cancellation's refund row, its amount (online) and
 * the booking's stored `frontDeskRefundDue` are fixed and every later attempt reuses them. Before that: the
 * total is `override` if given, else the rate plan's policy applied at `at` to the total received; the online
 * part is that total capped at the online net, the rest is due at the front desk.
 * The preview and the actual cancel share this.
 */
async function cancelRefundPlan(db: Db, res: Reservation, at: Date, override?: number): Promise<CancelRefundPlan> {
  const intent = await cancelIntent(db, res.id);
  if (intent) return { online: intent.amount, frontDesk: res.frontDeskRefundDue };
  const money = await moneyHeld(db, res.id);
  let total = override;
  if (total === undefined) {
    const [plan] = await db.select({ policy: ratePlans.cancelPolicy }).from(reservationRooms)
      .innerJoin(ratePlans, eq(ratePlans.id, reservationRooms.ratePlanId))
      .where(eq(reservationRooms.reservationId, res.id))
      .limit(1);
    total = refundAmount(plan.policy, money.received, res.checkIn, at);
  }
  const online = Math.max(0, Math.min(total, money.onlineNet));
  return { online, frontDesk: total - online };
}

/**
 * Cancel a confirmed reservation for the guest and refund what the policy allows (the shared core,
 * `cancelConfirmed`, does the work). Guests may cancel only within the cancel window.
 */
export async function cancelReservation(deps: Deps, code: string, email: string, now: Date): Promise<CancelOutcome> {
  const res = await lookup(deps.db, code, email);
  if (!res) return { ok: false, error: "NOT_FOUND" };
  if (res.status === "cancelled") return alreadyCancelled(res);
  if (res.status !== "confirmed" || !withinCancelWindow(res, now)) return { ok: false, error: "NOT_CANCELLABLE" };
  const r = await cancelConfirmed(deps, res.id, now, { reason: "GUEST_CANCELLED" });
  return r.ok || r.error !== "PAYMENTS_UNAVAILABLE" ? r : { ok: false, error: "REFUND_FAILED" };
}

export type CancelCoreOptions = {
  /** Why, as told to the payment gateway with the refund. */
  reason: string;
  /**
   * The whole refund (online and front desk, at most the total received), used ONLY if this call creates the
   * cancellation's refund intent; an existing intent's split wins.
   */
  refundOverride?: number;
  /** Give back only the nights on or after this date (a stay already under way); default every night. */
  releaseFrom?: ISODate;
  /** Email the guest (default true). Staff are always emailed. */
  notifyGuest?: boolean;
  /**
   * False when no payment gateway is configured: a cancellation that would move money then fails with
   * PAYMENTS_UNAVAILABLE before touching the gateway (the claim is dropped); one refunding 0 goes ahead.
   */
  gatewayAvailable?: boolean;
  /**
   * Only once the cancellation's refund intent has SUCCEEDED (refund reconciliation): take the claim even if
   * another request's lease is fresh, stamping `cancelledAt = coalesce(cancelledAt, takeOverAt)`. The settled
   * refund is the authority; the transition stays guarded by status = confirmed and the succeeded intent, so
   * of two racing completions only one cancels, releases and emails.
   */
  takeOverAt?: number;
};

export type CoreCancelOutcome = CancelOutcome | { ok: false; error: "PAYMENTS_UNAVAILABLE" };

/**
 * The cancellation core shared by the guest cancel, the staff cancel and refund reconciliation.
 * The caller has checked who may cancel and when; this only requires the booking to be `confirmed`.
 * 1. Claim it: stamp `cancelledAt` (status stays `confirmed`) unless another request holds a fresh claim.
 *    The policy is applied at the first request's time.
 * 2. Plan the refund on the total received (cancelRefundPlan): the online part goes back against the paying
 *    charge through ONE intent row keyed `cancel:<id>` (refundOnce), the rest is stored as the booking's
 *    `frontDeskRefundDue` just before that row is created. Both are then fixed: every later attempt reuses
 *    them, so retries never refund twice or change the split.
 *    - Outcome unknown (row pending: another attempt in flight, or it died) → staff alert, REFUND_FAILED,
 *      the claim is kept so that a slow first attempt can still finish.
 *    - Definitive failure → the claim is dropped, staff alert, REFUND_FAILED; a later cancel retries the row.
 * 3. `confirmed` → `cancelled`, allowed only when the refund row succeeded (or there is none: nothing to
 *    refund); the channel cancel is queued (syncState pending).
 * 4. Give the rooms back, 5. cancel on the channel (the retry job retries), 6. email guest and staff, and alert
 *    staff to any front-desk refund due.
 */
export async function cancelConfirmed(deps: Deps, reservationId: string, now: Date, o: CancelCoreOptions): Promise<CoreCancelOutcome> {
  const { db } = deps;
  const claim = await claimCancellation(db, reservationId, now, o.takeOverAt);
  if (!claim) return settledElsewhere(db, reservationId);

  const r = await refundCancellation(deps, claim, now, o);
  if (!r.ok) {
    if (!r.pendingRefundId)
      await db.update(reservations)
        .set({ cancelledAt: null, lastSyncError: `CANCEL_REFUND_FAILED: ${r.error}`, updatedAt: now.getTime() })
        .where(and(eq(reservations.id, reservationId), eq(reservations.status, "confirmed"), eq(reservations.updatedAt, claim.updatedAt)));
    if (r.error === "PAYMENTS_UNAVAILABLE") return { ok: false, error: "PAYMENTS_UNAVAILABLE" };
    const ref = r.pendingRefundId ?? `cancel-refund-failed:${now.getTime()}`;
    await notifyStaff(deps, reservationId, "staff_payment_alert", now, {}, ref);
    return { ok: false, error: "REFUND_FAILED" };
  }

  // refundOnce already added the refund to refundedAmount.
  // nextSyncAt = now: from this moment the retry job is the safety net for the channel cancel.
  const key = cancelKey(reservationId);
  const refundSettled = or(
    notExists(db.select({ one: sql`1` }).from(payments).where(eq(payments.idempotencyKey, key))),
    exists(db.select({ one: sql`1` }).from(payments).where(and(eq(payments.idempotencyKey, key), eq(payments.status, "succeeded")))),
  );
  const cancelled = await transition(db, reservationId, "confirmed", "cancelled", {
    holdExpiresAt: null,
    syncState: "pending", syncAttempts: 0, nextSyncAt: now.getTime(), lastSyncError: null,
  }, now, refundSettled);
  if (!cancelled) return settledElsewhere(db, reservationId);

  if (claim.holdExpiresAt != null) {
    const items = nightsFrom(await holdItemsFor(db, claim), o.releaseFrom);
    if (items.length) await releaseInventory(db, items);
  }
  await cancelWithChannel(deps, reservationId, now);
  const mail = { refundAmount: r.amount, ...frontDeskField(r.frontDesk) };
  if (o.notifyGuest !== false) await notifyGuest(deps, reservationId, "cancelled", now, mail);
  await notifyStaff(deps, reservationId, "cancelled", now, mail);
  if (r.frontDesk > 0) await notifyStaff(deps, reservationId, "staff_payment_alert", now, mail, "front-desk-refund");
  return { ok: true, refunded: r.amount, ...frontDeskField(r.frontDesk), alreadyCancelled: false };
}

/** The hold items limited to nights on or after `from` (all of them when `from` is unset); empty items dropped. */
function nightsFrom(items: HoldItem[], from?: ISODate): HoldItem[] {
  if (!from) return items;
  return items.map((i) => ({ ...i, nights: i.nights.filter((d) => d >= from) })).filter((i) => i.nights.length > 0);
}

/**
 * What cancelling now would refund, as `cancelConfirmed` will compute it: the existing intent's split,
 * else `override` (the whole refund) if given, else the policy at the claim time (or `now` if unclaimed).
 */
export async function plannedCancelRefund(db: Db, res: Reservation, now: Date, override?: number): Promise<CancelRefundPlan> {
  return cancelRefundPlan(db, res, new Date(res.cancelledAt ?? now.getTime()), override);
}

/** A cancelled booking's result: what was refunded online and what the desk owes, as fixed by its cancellation. */
export function alreadyCancelled(res: Reservation): CancelOutcome {
  return { ok: true, refunded: res.refundedAmount, ...frontDeskField(res.frontDeskRefundDue), alreadyCancelled: true };
}

type CancellationRefund = (RefundOutcome & { ok: false }) | { ok: true; amount: number; frontDesk: number };

/**
 * Run (or finish, or join) the cancellation's refund. `amount` is what went back online, `frontDesk` what the
 * desk owes. Nothing to refund online → `{ ok: true, amount: 0 }` without touching the gateway.
 */
async function refundCancellation(deps: Deps, claim: Reservation, now: Date, o: CancelCoreOptions): Promise<CancellationRefund> {
  const { db } = deps;
  const intent = await cancelIntent(db, claim.id);
  const plan = await cancelRefundPlan(db, claim, new Date(claim.cancelledAt!), o.refundOverride);
  const amount = plan.online;
  // Fixed alongside the intent: stored before refundOnce creates it, never rewritten once it exists.
  // updatedAt (the claim's lease) is left alone.
  if (!intent && plan.frontDesk !== claim.frontDeskRefundDue)
    await db.update(reservations).set({ frontDeskRefundDue: plan.frontDesk })
      .where(and(eq(reservations.id, claim.id), eq(reservations.status, "confirmed")));
  if (amount <= 0) return { ok: true, amount: 0, frontDesk: plan.frontDesk };
  if (o.gatewayAvailable === false) return { ok: false, error: "PAYMENTS_UNAVAILABLE" };
  const chargeId = intent?.refundOf ?? await payingChargeId(db, claim.id);
  const charge = (await refundableCharges(db, claim.id)).find((c) => c.id === chargeId);
  if (!charge) return { ok: false, error: "NO_PAYING_CHARGE" };
  if (!intent && charge.remaining < amount) return { ok: false, error: `REFUNDABLE_${charge.remaining}_LT_${amount}` };
  const r = await refundOnce(deps, cancelKey(claim.id), charge, amount, o.reason, now, { countsAsBookingRefund: true });
  return r.ok ? { ...r, frontDesk: plan.frontDesk } : r;
}

/**
 * One conditional UPDATE: own the cancellation of a confirmed booking. `cancelledAt` keeps the time
 * of the first request (the policy is applied at that time); `updatedAt` is the lease. `takeOverAt`
 * (settled refund only, see CancelCoreOptions) skips the lease check.
 */
async function claimCancellation(db: Db, reservationId: string, now: Date, takeOverAt?: number): Promise<Reservation | undefined> {
  const [res] = await db.update(reservations)
    .set({ cancelledAt: sql`coalesce(${reservations.cancelledAt}, ${takeOverAt ?? now.getTime()})`, updatedAt: now.getTime() })
    .where(and(
      eq(reservations.id, reservationId), eq(reservations.status, "confirmed"),
      takeOverAt === undefined
        ? or(isNull(reservations.cancelledAt), lte(reservations.updatedAt, now.getTime() - CANCEL_LEASE_MS))
        : undefined,
    ))
    .returning();
  return res;
}

/** Another request owns (or just finished) this cancellation: report what it did, if it is done. */
async function settledElsewhere(db: Db, reservationId: string): Promise<CancelOutcome> {
  const [cur] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  return cur.status === "cancelled" ? alreadyCancelled(cur) : { ok: false, error: "NOT_CANCELLABLE" };
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
