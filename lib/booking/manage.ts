import { bookingTerms } from "./terms";
import { and, eq, exists, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { releaseInventory, type HoldItem } from "@/lib/db/inventory-hold";
import { auditLog, payments, reservationRooms, reservations, unitTypes, type I18n } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { todayInTaipei, type ISODate } from "@/lib/domain/dates";
import { refundAmount } from "@/lib/domain/cancellation";
import type { Quote } from "@/lib/domain/quote";
import { kickChannelSync } from "./channel-sync";
import { holdItemsFor, refundOnce, type RefundOutcome } from "./confirm";
import { modifyRefundPending, moneyOf, owedBack, unsettledModifyRefund } from "@/lib/admin/money-metrics";
import { notifyGuest, notifyStaff, refundableCharges, type Deps } from "./notify";
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
  /** Every succeeded refund (cancellation, failure and staff-modification refunds alike). */
  refunded: number;
  /** The whole refund a cancel now would give (online and at the front desk). */
  refundIfCancelledNow: number;
  canCancel: boolean;
  /** A staff change of the booking is still settling its refund: no online cancel until it has (ask the hotel). */
  changePending: boolean;
};

export type CancelOutcome =
  | {
      ok: true;
      /** Refunded online, through the gateway. */
      refunded: number;
      /** Present (> 0) when part of the refund is front-desk money the desk must hand back. */
      frontDeskRefundDue?: number;
      alreadyCancelled: boolean;
      /** A staff override was more than the cancel base when the cancellation was planned; `applied` was used. */
      overrideClamped?: OverrideClamp;
    }
  | { ok: false; error: "NOT_FOUND" | "NOT_CANCELLABLE" | "REFUND_FAILED" | "MODIFICATION_REFUND_PENDING" };

/** The override asked for and the amount actually used (the cancel base at planning time). */
export type OverrideClamp = { requested: number; applied: number };

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
  const rooms = await db.select({ unitName: unitTypes.name })
    .from(reservationRooms)
    .innerJoin(unitTypes, eq(unitTypes.id, reservationRooms.unitTypeId))
    .where(eq(reservationRooms.reservationId, res.id));
  const room = rooms[0];
  const changePending = res.status === "confirmed" && await modifyRefundPending(db, res.id);
  const canCancel = res.status === "confirmed" && withinCancelWindow(res, now) && !changePending;
  const money = await moneyOf(db, res.id);
  return {
    code: res.code,
    status: res.status,
    checkIn: res.checkIn,
    checkOut: res.checkOut,
    adults: res.adults,
    children: res.children,
    rooms: rooms.length,
    roomTypeName: room.unitName,
    ratePlanName: bookingTerms(res).ratePlanName,
    quote: res.quote as Quote,
    paid: money.received,
    refunded: money.refunded,
    refundIfCancelledNow: canCancel ? refundTotal(await cancelRefundPlan(db, res, now)) : 0,
    canCancel,
    changePending,
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
  /** Set when the override exceeded the cancel base and was cut down to it. */
  overrideClamped?: OverrideClamp;
};

export const refundTotal = (p: CancelRefundPlan) => p.online + p.frontDesk;

/** Present only when there is something for the desk to hand back, so results without one are unchanged. */
const frontDeskField = (amount: number) => (amount > 0 ? { frontDeskRefundDue: amount } : {});

/**
 * What cancelling refunds. Once an attempt has created the cancellation's refund row, its amount (online) and
 * the booking's stored `cancelDeskDue` (its desk share) are fixed and every later attempt reuses them. Before that:
 * - money the guest is already owed back (`owedBack`: received beyond the total, left by a price-lowering
 *   modification for the desk to hand back) is not the cancel's to judge: it stays due at the front desk in full;
 * - the cancel's own refund is `override` if given, else the rate plan's policy applied at `at`, both on the
 *   rest (`cancelBase`: received minus that owed money); its online part is capped at the online net, the rest
 *   is due at the front desk too.
 * - An override is clamped to that base HERE, against the money as it is now: the caller checked it earlier,
 *   and a modification refunding in between (before the claim) would otherwise make the cancel hand back more
 *   than was paid, as an unpayable desk-due. `overrideClamped` then says what was asked and what was used.
 * The preview and the actual cancel share this.
 */
async function cancelRefundPlan(db: Db, res: Reservation, at: Date, override?: number): Promise<CancelRefundPlan> {
  const intent = await cancelIntent(db, res.id);
  if (intent) return { online: intent.amount, frontDesk: res.cancelDeskDue };
  const money = await moneyOf(db, res.id);
  const owed = owedBack(res.totalAmount, money);
  const base = money.received - owed;
  let own: number;
  let overrideClamped: OverrideClamp | undefined;
  if (override === undefined) {
    own = refundAmount(bookingTerms(res).cancelPolicy, base, res.checkIn, at);
  } else {
    own = Math.max(0, Math.min(override, base));
    if (own !== override) overrideClamped = { requested: override, applied: own };
  }
  const online = Math.max(0, Math.min(own, money.onlineNet));
  return { online, frontDesk: owed + own - online, ...(overrideClamped ? { overrideClamped } : {}) };
}

/** What a cancel's policy (or a staff override) is applied to: received, minus money already owed back. */
export async function cancelBase(db: Db, res: Pick<Reservation, "id" | "totalAmount">): Promise<number> {
  const money = await moneyOf(db, res.id);
  return money.received - owedBack(res.totalAmount, money);
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
  // Staff cancels audit the desk's share themselves; a guest's is audited here, under a system actor.
  if (r.ok && !r.alreadyCancelled && r.frontDeskRefundDue)
    await deps.db.insert(auditLog).values({
      id: crypto.randomUUID(), staffEmail: GUEST_ACTOR, action: "cancel.front_desk_refund_due",
      entity: "reservation", entityId: res.id, before: null,
      after: { refunded: r.refunded, frontDeskRefundDue: r.frontDeskRefundDue }, at: now.getTime(),
    });
  return r.ok || r.error !== "PAYMENTS_UNAVAILABLE" ? r : { ok: false, error: "REFUND_FAILED" };
}

/** The audit log's actor for writes a guest triggered. */
export const GUEST_ACTOR = "system:guest";

export type CancelCoreOptions = {
  /** Why, as told to the payment gateway with the refund. */
  reason: string;
  /**
   * The cancel's own refund (online and front desk, at most `cancelBase`), used ONLY if this call creates the
   * cancellation's refund intent; an existing intent's split wins. Money already owed back is added in full.
   */
  refundOverride?: number;
  /** Give back only the nights on or after this date (a stay already under way); default every night. */
  releaseFrom?: ISODate;
  /**
   * Email the guest (default true). Staff are always emailed. A `false` is also stored on the refund intent this
   * call creates, so a later completion by refund reconciliation (finishFlow) keeps it.
   */
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

/** The claim was refused because a staff modification's refund has not settled (see unsettledModifyRefund). */
async function refusedForModifyRefund(db: Db, reservationId: string): Promise<CancelOutcome | null> {
  const [cur] = await db.select({ status: reservations.status }).from(reservations).where(eq(reservations.id, reservationId));
  return cur?.status === "confirmed" && await modifyRefundPending(db, reservationId)
    ? { ok: false, error: "MODIFICATION_REFUND_PENDING" } : null;
}

/**
 * The cancellation core shared by the guest cancel, the staff cancel and refund reconciliation.
 * The caller has checked who may cancel and when; this only requires the booking to be `confirmed`.
 * 1. Claim it: stamp `cancelledAt` (status stays `confirmed`) unless another request holds a fresh claim.
 *    The policy is applied at the first request's time.
 * 2. Plan the refund on the total received (cancelRefundPlan): the online part goes back against the paying
 *    charge through ONE intent row keyed `cancel:<id>` (refundOnce), the rest is stored as the booking's
 *    `cancelDeskDue` just before that row is created. Both are then fixed: every later attempt reuses
 *    them, so retries never refund twice or change the split.
 *    - Outcome unknown (row pending: another attempt in flight, or it died) → staff alert, REFUND_FAILED,
 *      the claim is kept so that a slow first attempt can still finish.
 *    - Definitive failure → the claim is dropped, staff alert, REFUND_FAILED; a later cancel retries the row.
 * 3. `confirmed` → `cancelled`, allowed only when the refund row succeeded (or there is none: nothing to
 *    refund); the channel cancel is queued (syncState pending).
 * 4. Give the rooms back, 5. hand the cancel to the channel (channel-sync: sent once the push has succeeded, nothing
 *    for a booking never pushed; the retry job retries), 6. email guest and staff, and alert
 *    staff to any front-desk refund due.
 */
export async function cancelConfirmed(deps: Deps, reservationId: string, now: Date, o: CancelCoreOptions): Promise<CoreCancelOutcome> {
  const { db } = deps;
  const claim = await claimCancellation(db, reservationId, now, o.takeOverAt);
  if (!claim) return (await refusedForModifyRefund(db, reservationId)) ?? settledElsewhere(db, reservationId);

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
  // Only now does the desk owe the cancellation's share: a cancel that failed and dropped its claim changed nothing.
  // The share is the one STORED with the intent (cancelDeskDue, read by this same UPDATE), not this attempt's
  // `r.frontDesk`: an attempt that stalled past its lease may have planned a share a takeover attempt has since
  // replaced. (SET expressions see the row as it was before the UPDATE, so cancelDeskDue is read before it is zeroed.)
  // Desk-due can't move while the claim is held, so the row's frontDeskRefundDue tells whether it was already owed.
  const cancelled = await transition(db, reservationId, "confirmed", "cancelled", {
    holdExpiresAt: null, frontDeskRefundDue: sql`${reservations.cancelDeskDue}`, cancelDeskDue: 0,
    deskDueSince: sql`case when ${reservations.cancelDeskDue} > 0
      then (case when ${reservations.frontDeskRefundDue} > 0 then coalesce(${reservations.deskDueSince}, ${now.getTime()}) else ${now.getTime()} end)
      else null end`,
    syncState: "pending", syncAttempts: 0, nextSyncAt: now.getTime(), lastSyncError: null,
  }, now, refundSettled);
  if (!cancelled) return settledElsewhere(db, reservationId);
  const [{ frontDesk }] = await db.select({ frontDesk: reservations.frontDeskRefundDue }).from(reservations)
    .where(eq(reservations.id, reservationId));

  if (claim.holdExpiresAt != null) {
    const items = nightsFrom(await holdItemsFor(db, claim), o.releaseFrom);
    if (items.length) await releaseInventory(db, items);
  }
  await kickChannelSync(deps, reservationId, now);
  const mail = { refundAmount: r.amount, ...frontDeskField(frontDesk) };
  const clamp = r.overrideClamped ? { overrideClamped: r.overrideClamped } : {};
  if (o.notifyGuest !== false) await notifyGuest(deps, reservationId, "cancelled", now, mail);
  await notifyStaff(deps, reservationId, "cancelled", now, mail);
  if (frontDesk > 0) await notifyStaff(deps, reservationId, "staff_payment_alert", now, mail, "front-desk-refund");
  return { ok: true, refunded: r.amount, ...frontDeskField(frontDesk), alreadyCancelled: false, ...clamp };
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

type CancellationRefund =
  | (RefundOutcome & { ok: false })
  | { ok: true; amount: number; frontDesk: number; overrideClamped?: OverrideClamp };

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
  // updatedAt (the claim's lease) is left alone, and must still be this claim's: an attempt that stalled past
  // its lease must not overwrite the share a takeover attempt has since fixed with its own intent.
  if (!intent && plan.frontDesk !== claim.cancelDeskDue)
    await db.update(reservations).set({ cancelDeskDue: plan.frontDesk })
      .where(and(eq(reservations.id, claim.id), eq(reservations.status, "confirmed"), eq(reservations.updatedAt, claim.updatedAt)));
  const clamp = plan.overrideClamped ? { overrideClamped: plan.overrideClamped } : {};
  if (amount <= 0) return { ok: true, amount: 0, frontDesk: plan.frontDesk, ...clamp };
  if (o.gatewayAvailable === false) return { ok: false, error: "PAYMENTS_UNAVAILABLE" };
  const chargeId = intent?.refundOf ?? await payingChargeId(db, claim.id);
  const charge = (await refundableCharges(db, claim.id)).find((c) => c.id === chargeId);
  if (!charge) return { ok: false, error: "NO_PAYING_CHARGE" };
  if (!intent && charge.remaining < amount) return { ok: false, error: `REFUNDABLE_${charge.remaining}_LT_${amount}` };
  const r = await refundOnce(deps, cancelKey(claim.id), charge, amount, o.reason, now, {
    countsAsBookingRefund: true, notifyGuest: o.notifyGuest,
  });
  return r.ok ? { ...r, frontDesk: plan.frontDesk, ...clamp } : r;
}

/**
 * One conditional UPDATE: own the cancellation of a confirmed booking. `cancelledAt` keeps the time
 * of the first request (the policy is applied at that time); `updatedAt` is the lease. `takeOverAt`
 * (settled refund only, see CancelCoreOptions) skips the lease check. Without it, a booking with an unsettled
 * staff-modification refund is refused in the same statement: the modification batch requires
 * `cancelledAt is null` in turn, so a cancel and a modification refund never overlap.
 */
async function claimCancellation(db: Db, reservationId: string, now: Date, takeOverAt?: number): Promise<Reservation | undefined> {
  const [res] = await db.update(reservations)
    .set({ cancelledAt: sql`coalesce(${reservations.cancelledAt}, ${takeOverAt ?? now.getTime()})`, updatedAt: now.getTime() })
    .where(and(
      eq(reservations.id, reservationId), eq(reservations.status, "confirmed"),
      takeOverAt === undefined
        ? and(
          or(isNull(reservations.cancelledAt), lte(reservations.updatedAt, now.getTime() - CANCEL_LEASE_MS)),
          sql`not exists (${unsettledModifyRefund(reservationId)})`,
        )
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
