import { and, eq, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { holdItemsFor, MAX_SYNC_ATTEMPTS, refundOnce, SYNC_LEASE_MS, SYNC_RETRY_MS } from "@/lib/booking/confirm";
import { notifyGuest, notifyStaff, refundableCharges, type Deps } from "@/lib/booking/notify";
import { payingChargeId } from "@/lib/booking/payment-notice";
import { toChannelReservation } from "@/lib/booking/to-channel";
import type { Reservation } from "@/lib/booking/state";
import type { PushResult } from "@/lib/channel/types";
import { searchAvailability, type RichOffer } from "@/lib/db/ari-repo";
import { runAtomic } from "@/lib/db/atomic";
import { holdStatements, isCheckViolation, releaseStatements, type HoldItem } from "@/lib/db/inventory-hold";
import {
  addons as addonsTable, auditLog, payments, promoCodes, ratePlans, reservationRooms, reservations, unitTypes,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { parseStay, todayInTaipei, type ISODate } from "@/lib/domain/dates";
import { quote, type AddonLine, type Promo, type Quote } from "@/lib/domain/quote";
import type { ModificationMoney } from "@/lib/email/templates";
import type { StaffContext } from "./auth";
import { deskOpenSql } from "./front-desk";
import { moneyOf, unsettledModifyRefund } from "./money-metrics";
import { can } from "./permissions";

/** The stay a staff modification moves a booking to. Room type and rate plan default to the booking's own. */
export type ModificationChange = {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  unitTypeSlug?: string;
  ratePlanSlug?: string;
};

const optionalString = (v: unknown) => v === undefined || typeof v === "string";

/** The change part of a modify request body, or null when its shape is wrong (the values are checked later). */
export function parseModificationChange(b: Record<string, unknown> | null): ModificationChange | null {
  if (!b || typeof b.checkIn !== "string" || typeof b.checkOut !== "string" || typeof b.adults !== "number"
    || typeof b.children !== "number" || !optionalString(b.unitTypeSlug) || !optionalString(b.ratePlanSlug))
    return null;
  return {
    checkIn: b.checkIn, checkOut: b.checkOut, adults: b.adults, children: b.children,
    ...(b.unitTypeSlug ? { unitTypeSlug: b.unitTypeSlug as string } : {}),
    ...(b.ratePlanSlug ? { ratePlanSlug: b.ratePlanSlug as string } : {}),
  };
}

export type PreviewError = "NOT_FOUND" | "FORBIDDEN" | "NOT_MODIFIABLE" | "NOT_AVAILABLE" | "INVALID_INPUT";
/** Why a booking is NOT_MODIFIABLE, when it is not just its state: OTA bookings change through the OTA / SiteMinder. */
export type ModifyErrorDetail = "OTA_BOOKING";
type Fail<E> = { ok: false; error: E; detail?: ModifyErrorDetail };

export type ModificationPreview =
  | {
      ok: true;
      newQuote: Quote;
      /** New total minus old total, both from quote(). */
      difference: number;
      /** What goes back online: the overpayment (received beyond the new total), up to the online net. */
      refundIfLower: number;
      /** What the front desk owes the guest after the change: the overpayment the online refund cannot cover. */
      frontDeskRefundIfLower: number;
      /** A higher price: the balance due after the change (collected at the front desk); else 0. */
      balanceIfHigher: number;
      /** The balance due after the change, whichever way the price moved (0 when overpaid). */
      balanceDue: number;
      /** The booking's version this preview was computed on; pass it to applyModification as expectedUpdatedAt. */
      updatedAt: number;
    }
  | Fail<PreviewError>;

export type ApplyError = PreviewError | "PRICE_CHANGED" | "CONFLICT" | "REASON_REQUIRED" | "PAYMENTS_UNAVAILABLE";

export type ApplyResult =
  | {
      ok: true;
      /** This modification's number (the booking's modCount after it). */
      modCount: number;
      difference: number;
      /** Refunded online. 0 when the refund failed (see refundFailed). */
      refunded: number;
      /** The booking's frontDeskRefundDue after this modification: what the desk owes the guest now. */
      frontDeskRefundDue: number;
      balanceDue: number;
      /** The online refund did not go through: staff were alerted; it waits on the refund reconciliation page. */
      refundFailed?: true;
    }
  | Fail<ApplyError>;

/** The refund row of a booking's n-th modification. */
export const modifyKey = (reservationId: string, n: number) => `modify:${reservationId}:${n}`;

const MAX_ADULTS = 12;
const MAX_CHILDREN = 6;

type Plan = {
  res: Reservation;
  rooms: number;
  oldItem: HoldItem;
  offer: RichOffer;
  nights: ISODate[];
  newQuote: Quote;
  difference: number;
  refundOnline: number;
  /** The booking's frontDeskRefundDue after the change (SET, not added to). */
  frontDeskRefund: number;
  /** After the change, ≥ 0. */
  balanceDue: number;
  /** The charge an online refund goes back against, and its method (set when refundOnline > 0). */
  chargeId?: string;
  chargeMethod?: string;
};

/**
 * What modifying the booking to `change` would cost, without changing anything. Needs `reservations.modify`
 * at the booking's property (another property's booking is NOT_FOUND). Only a booking that is confirmed, not
 * yet past check-in day (Taipei), not being cancelled and with no other modification's refund unsettled can be
 * modified; otherwise NOT_MODIFIABLE. A channel sync still pending does not block (see modifiableSql). OTA bookings are
 * NOT_MODIFIABLE (detail OTA_BOOKING): they are changed through the OTA / SiteMinder.
 * Money (one model, against the money module's `received`, net of refunds):
 * - overpaid = max(0, received − newTotal): only money actually paid beyond the new price goes back;
 * - online refund = min(overpaid, online net, the paying charge's remaining);
 * - frontDeskRefundDue is SET to overpaid − online refund: what the desk owes the guest right now. On a live
 *   booking nothing else is ever owed back (desk payments cannot overpay; a cancel's desk share is fixed only
 *   as it cancels), so a later raise that uses up the overpayment brings it back to 0;
 * - when received ≤ newTotal (e.g. a deposit) a lower price refunds nothing: the balance due just shrinks.
 * The new stay is priced from current rates as a new booking would be (the booking's own rooms count as
 * available on the nights it already holds); its add-ons are kept at their booked prices and re-counted for the
 * new nights and guests; its promo code still applies, whatever its usage count.
 */
export async function previewModification(
  db: Db, ctx: StaffContext, reservationId: string, change: ModificationChange, now: Date,
): Promise<ModificationPreview> {
  const p = await plan(db, ctx, reservationId, change, now);
  if (!p.ok) return p;
  const { newQuote, difference, refundOnline, frontDeskRefund, balanceDue: due, res } = p.plan;
  return {
    ok: true, newQuote, difference, refundIfLower: refundOnline, frontDeskRefundIfLower: frontDeskRefund,
    balanceIfHigher: difference > 0 ? due : 0, balanceDue: due, updatedAt: res.updatedAt,
  };
}

/**
 * Modify the booking (see previewModification for who and when). The preview is computed again; a difference
 * other than `expectedDifference` is PRICE_CHANGED and nothing changes. Then ONE batch, every statement
 * guarded by "still modifiable and unchanged since this preview (updatedAt)": hold the new nights the old stay
 * did not have and release the old nights the new stay drops (per room type; a room-type change takes and gives
 * back every night), replace the booking's rooms, update the booking (stay, guests, quote, total, modCount+1,
 * any front-desk refund due, channel sync pending), record the refund intent and the audit row. A night without a
 * room fails the CHECK and rolls everything back (NOT_AVAILABLE); a booking changed meanwhile is CONFLICT.
 * After the commit: a lower price refunds min(−difference, online net) under `modify:<id>:<n>` (a failure leaves the
 * new stay, records the error and alerts staff), the channel is sent a modify (retried by the sync job), and
 * the guest is emailed once for this modification.
 */
export async function applyModification(
  deps: Deps, ctx: StaffContext, reservationId: string, change: ModificationChange,
  opts: {
    expectedDifference: number; reason: string; paymentsUnavailable?: boolean;
    /** The preview's `updatedAt`: if the booking changed since (e.g. a desk payment), CONFLICT. */
    expectedUpdatedAt?: number;
  }, now: Date,
): Promise<ApplyResult> {
  const { db } = deps;
  if (!can(ctx.staff, "reservations.modify")) return { ok: false, error: "FORBIDDEN" };
  const reason = opts.reason.trim();
  if (!reason) return { ok: false, error: "REASON_REQUIRED" };
  const p = await plan(db, ctx, reservationId, change, now);
  if (!p.ok) return p;
  const pl = p.plan;
  const { res } = pl;
  if (opts.expectedUpdatedAt !== undefined && res.updatedAt !== opts.expectedUpdatedAt) return { ok: false, error: "CONFLICT" };
  if (pl.difference !== opts.expectedDifference) return { ok: false, error: "PRICE_CHANGED" };
  if (opts.paymentsUnavailable && pl.refundOnline > 0) return { ok: false, error: "PAYMENTS_UNAVAILABLE" };

  const n = res.modCount + 1;
  const at = now.getTime();
  const guard = modifiableSql(res, todayInTaipei(now));
  const { hold, release } = inventoryChange(pl, res.holdExpiresAt != null);
  const holdStmts = await holdStatements(db, hold, guard);
  if (!holdStmts) return { ok: false, error: "NOT_AVAILABLE" };

  const auditId = crypto.randomUUID();
  const refundId = crypto.randomUUID();
  const key = modifyKey(res.id, n);
  const before = { checkIn: res.checkIn, checkOut: res.checkOut, adults: res.adults, children: res.children,
    unitTypeId: pl.oldItem.unitTypeId, ratePlanId: pl.oldItem.ratePlanId, total: res.totalAmount };
  const after = { checkIn: change.checkIn, checkOut: change.checkOut, adults: change.adults, children: change.children,
    unitTypeId: pl.offer.unitTypeId, ratePlanId: pl.offer.ratePlanId, total: pl.newQuote.total, difference: pl.difference,
    refundOnline: pl.refundOnline, frontDeskRefundDue: pl.frontDeskRefund, reason, modCount: n };
  try {
    // Every statement is guarded by the same condition and the booking row is updated after the others, so they
    // all see the booking as this preview read it: either all of them apply or none does.
    await runAtomic(db, [
      ...holdStmts,
      ...releaseStatements(db, release, guard),
      db.delete(reservationRooms).where(and(eq(reservationRooms.reservationId, res.id), guard)),
      ...Array.from({ length: pl.rooms }, () =>
        db.insert(reservationRooms).select(sql`select ${crypto.randomUUID()}, ${res.id}, ${pl.offer.unitTypeId},
          ${pl.offer.ratePlanId}, ${JSON.stringify(pl.offer.nightlyPrices)} where ${guard}`)),
      db.insert(auditLog).select(sql`select ${auditId}, ${ctx.email}, 'reservation.modify', 'reservation', ${res.id},
        ${JSON.stringify(before)}, ${JSON.stringify(after)}, ${at} where ${guard}`),
      db.update(reservations).set({
        // The booked terms follow the plan: a different plan brings its own (as of now), the same plan keeps them.
        ...(pl.offer.ratePlanId !== pl.oldItem.ratePlanId ? { cancelPolicy: pl.offer.ratePlan.cancelPolicy, ratePlanName: pl.offer.ratePlan.name } : {}),
        checkIn: change.checkIn, checkOut: change.checkOut, adults: change.adults, children: change.children,
        quote: pl.newQuote, totalAmount: pl.newQuote.total, modCount: n,
        frontDeskRefundDue: pl.frontDeskRefund,
        deskDueSince: pl.frontDeskRefund > 0 ? sql`coalesce(${reservations.deskDueSince}, ${at})` : null,
        holdExpiresAt: res.holdExpiresAt ?? at,
        // From now on the retry job is the safety net for the channel modify. nextSyncAt = now, unless a push of
        // an earlier change holds its lease (or waits for its retry slot): then this change goes out with the next
        // push instead, never as a second push at the same time. That push's result no longer applies (its
        // syncAttempts / modCount guard fails), so the booking stays pending until the latest stay is pushed.
        syncState: "pending", syncAttempts: 0,
        nextSyncAt: sql`max(coalesce(${reservations.nextSyncAt}, ${at}), ${at})`, lastSyncError: null, updatedAt: at,
      }).where(and(eq(reservations.id, res.id), guard)),
      // The refund intent is recorded with the change, as `failed` (= not yet done; retrying is safe): refundOnce
      // below takes it from there, and if this request dies first it waits on the reconciliation page. It goes
      // last (it would make `guard` false) and commits exactly when the audit row did.
      ...(pl.refundOnline > 0
        ? [db.insert(payments).select(sql`select ${refundId}, ${res.id}, 'refund', ${pl.chargeMethod!}, ${pl.refundOnline},
            'failed', null, null, null, ${pl.chargeId!}, ${key}, ${at}, null, null
            where exists (select 1 from ${auditLog} where ${auditLog.id} = ${auditId})`)]
        : []),
    ]);
  } catch (e) {
    if (isCheckViolation(e)) return { ok: false, error: "NOT_AVAILABLE" };
    throw e;
  }
  const [won] = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.id, auditId));
  if (!won) {
    const why = await blocker(db, res.id, now);
    return { ok: false, error: why ?? "CONFLICT" };
  }

  let refunded = 0;
  let refundFailed = false;
  if (pl.refundOnline > 0) {
    const charge = (await refundableCharges(db, res.id)).find((c) => c.id === pl.chargeId);
    const r = charge
      ? await refundOnce(deps, key, charge, pl.refundOnline, "STAFF_MODIFIED", now)
      : { ok: false as const, error: "NO_PAYING_CHARGE", refundId };
    if (r.ok) refunded = r.amount;
    else {
      refundFailed = true;
      await db.update(reservations).set({ lastSyncError: `${MODIFY_REFUND_FAILED}: ${r.error}`, updatedAt: now.getTime() })
        .where(eq(reservations.id, res.id));
      await notifyStaff(deps, res.id, "staff_payment_alert", now, {}, r.refundId ?? refundId);
    }
  }
  await modifyWithChannel(deps, res.id, now);
  const money: ModificationMoney = {
    difference: pl.difference, refunded: pl.refundOnline, frontDeskRefundDue: pl.frontDeskRefund, balanceDue: pl.balanceDue,
  };
  await notifyGuest(deps, res.id, "booking_modified", now, { modification: money }, String(n));
  return {
    ok: true, modCount: n, difference: pl.difference, refunded, frontDeskRefundDue: pl.frontDeskRefund,
    balanceDue: pl.balanceDue, ...(refundFailed ? { refundFailed: true as const } : {}),
  };
}

/** lastSyncError prefix of a modification refund that did not go through; a later channel success keeps it. */
const MODIFY_REFUND_FAILED = "MODIFY_REFUND_FAILED";

/**
 * Tell the channel a confirmed booking was modified. Lease-guarded like cancelWithChannel, so the modify request
 * and the retry job never call it at the same time. Success → synced; a retryable failure retries in 5 minutes;
 * a non-retryable one, or one after MAX_SYNC_ATTEMPTS retries, → failed and staff are alerted. The booking is
 * never cancelled automatically.
 */
export async function modifyWithChannel(deps: Deps, reservationId: string, now: Date): Promise<void> {
  const { db } = deps;
  const [res] = await db.update(reservations)
    .set({ nextSyncAt: now.getTime() + SYNC_LEASE_MS })
    .where(and(
      eq(reservations.id, reservationId), eq(reservations.status, "confirmed"), eq(reservations.syncState, "pending"),
      or(isNull(reservations.nextSyncAt), lte(reservations.nextSyncAt, now.getTime())),
    ))
    .returning();
  if (!res) return;

  let r: PushResult;
  try {
    r = res.smConfirmation
      ? await deps.channel.modifyReservation(await toChannelReservation(db, reservationId), res.smConfirmation)
      : { ok: false, retryable: false, error: "NO_SM_CONFIRMATION" };
  } catch (e) {
    r = { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
  }
  const mine = and(
    eq(reservations.id, reservationId), eq(reservations.status, "confirmed"), eq(reservations.syncState, "pending"),
    eq(reservations.syncAttempts, res.syncAttempts), eq(reservations.modCount, res.modCount),
  );
  if (r.ok) {
    const keepRefundError = sql`case when ${reservations.lastSyncError} like ${`${MODIFY_REFUND_FAILED}%`} then ${reservations.lastSyncError} else null end`;
    await db.update(reservations)
      .set({ syncState: "synced", smConfirmation: r.smConfirmation, nextSyncAt: null, lastSyncError: keepRefundError, updatedAt: now.getTime() })
      .where(mine);
    return;
  }
  const attempts = res.syncAttempts + 1;
  if (r.retryable && res.syncAttempts < MAX_SYNC_ATTEMPTS) {
    await db.update(reservations)
      .set({ syncAttempts: attempts, nextSyncAt: now.getTime() + SYNC_RETRY_MS, lastSyncError: r.error, updatedAt: now.getTime() })
      .where(mine);
    return;
  }
  const failed = await db.update(reservations)
    .set({ syncState: "failed", syncAttempts: attempts, nextSyncAt: null, lastSyncError: r.error, updatedAt: now.getTime() })
    .where(mine).returning({ id: reservations.id });
  if (failed.length) await notifyStaff(deps, reservationId, "staff_sync_failed", now, {}, `modify:${res.modCount}`);
}

/**
 * SQL: the booking may be modified (see previewModification) and is unchanged since `res` was read
 * (updatedAt). Checked inside every statement of the modification's batch. A pending channel sync does not
 * block: the sync always pushes the booking as it is then, so a further change just updates what gets pushed
 * (with no channel configured the sync stays pending until one is). Only an unsettled modification refund does.
 */
function modifiableSql(res: Reservation, today: ISODate): SQL {
  return sql`${deskOpenSql(res.id)} and exists (select 1 from ${reservations} where ${reservations.id} = ${res.id}
    and ${reservations.updatedAt} = ${res.updatedAt} and ${reservations.checkIn} >= ${today})
    and not exists (${unsettledModifyRefund(res.id)})`;
}

/** Why the booking cannot be modified now, or null if it can. */
async function blocker(db: Db, reservationId: string, now: Date): Promise<"NOT_FOUND" | "NOT_MODIFIABLE" | null> {
  const [row] = await db.select({
    open: sql<number>`${deskOpenSql(reservationId)}`,
    inFlight: sql<number>`exists (${unsettledModifyRefund(reservationId)})`,
    checkIn: reservations.checkIn,
  }).from(reservations).where(eq(reservations.id, reservationId));
  if (!row) return "NOT_FOUND";
  if (!Number(row.open) || Number(row.inFlight) || todayInTaipei(now) > row.checkIn)
    return "NOT_MODIFIABLE";
  return null;
}

/**
 * The holds and releases a modification needs. Inventory is per room type: on the same type only the nights
 * that differ move; a room-type change takes every new night and gives back every old one. `oldHeld` false
 * (the booking holds no inventory) gives nothing back.
 */
function inventoryChange(pl: Plan, oldHeld: boolean): { hold: HoldItem[]; release: HoldItem[] } {
  const old = pl.oldItem;
  const sameType = old.unitTypeId === pl.offer.unitTypeId && oldHeld;
  const oldNights = oldHeld ? new Set(old.nights) : new Set<string>();
  const newNights = new Set(pl.nights);
  const hold: HoldItem[] = [{
    unitTypeId: pl.offer.unitTypeId, ratePlanId: pl.offer.ratePlanId, rooms: pl.rooms,
    nights: sameType ? pl.nights.filter((d) => !oldNights.has(d)) : pl.nights,
  }];
  const release: HoldItem[] = oldHeld
    ? [{ ...old, nights: sameType ? old.nights.filter((d) => !newNights.has(d)) : old.nights }]
    : [];
  return { hold: hold.filter((i) => i.nights.length), release: release.filter((i) => i.nights.length) };
}

const isCount = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

async function plan(
  db: Db, ctx: StaffContext, reservationId: string, change: ModificationChange, now: Date,
): Promise<{ ok: true; plan: Plan } | Fail<PreviewError>> {
  if (!can(ctx.staff, "reservations.modify")) return { ok: false, error: "FORBIDDEN" };
  const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  if (!res || !can(ctx.staff, "reservations.modify", res.propertyId)) return { ok: false, error: "NOT_FOUND" };
  if (res.channel === "siteminder_ota") return { ok: false, error: "NOT_MODIFIABLE", detail: "OTA_BOOKING" };
  if (await blocker(db, res.id, now)) return { ok: false, error: "NOT_MODIFIABLE" };

  // The booking's rooms: one room type and rate plan (all bookings are made that way).
  const [oldItem, ...more] = await holdItemsFor(db, res);
  if (!oldItem || more.length) return { ok: false, error: "NOT_MODIFIABLE" };
  const rooms = oldItem.rooms;

  if (!isCount(change.adults, 1, MAX_ADULTS) || !isCount(change.children, 0, MAX_CHILDREN) || change.adults < rooms)
    return { ok: false, error: "INVALID_INPUT" };
  const stay = parseStay(change.checkIn, change.checkOut);
  if (!stay.ok) return { ok: false, error: "INVALID_INPUT" };

  const [current] = await db.select({ unit: unitTypes.slug, plan: ratePlans.slug }).from(unitTypes)
    .innerJoin(ratePlans, eq(ratePlans.id, oldItem.ratePlanId)).where(eq(unitTypes.id, oldItem.unitTypeId));
  const unitTypeSlug = change.unitTypeSlug ?? current.unit;
  const ratePlanSlug = change.ratePlanSlug ?? current.plan;

  const search = await searchAvailability(db, {
    propertyId: res.propertyId, checkIn: change.checkIn, checkOut: change.checkOut, adults: change.adults,
    children: change.children, rooms, today: todayInTaipei(now),
    ...(res.holdExpiresAt != null ? { credit: { unitTypeId: oldItem.unitTypeId, nights: oldItem.nights, rooms } } : {}),
  });
  if (!search.ok) return { ok: false, error: "INVALID_INPUT" };
  const offer = search.offers.find((o) => o.unitType.slug === unitTypeSlug && o.ratePlan.slug === ratePlanSlug);
  if (!offer) return { ok: false, error: "NOT_AVAILABLE" };

  const oldQuote = res.quote as Quote;
  const newQuote = quote({
    offer, nights: stay.nights.length, adults: change.adults, rooms,
    addons: await keptAddons(db, oldQuote, res.adults), promo: await keptPromo(db, res),
    paymentMode: offer.ratePlan.paymentMode, depositPct: offer.ratePlan.depositPct,
  });
  const difference = newQuote.total - oldQuote.total;

  const money = await moneyOf(db, res.id);
  const overpaid = Math.max(0, money.received - newQuote.total);
  let refundOnline = 0;
  let charge: Awaited<ReturnType<typeof refundableCharges>>[number] | undefined;
  if (overpaid > 0 && money.onlineNet > 0) {
    const chargeId = await payingChargeId(db, res.id);
    charge = (await refundableCharges(db, res.id)).find((c) => c.id === chargeId);
    // The online net, and never more than the paying charge still holds.
    refundOnline = Math.min(overpaid, money.onlineNet, charge?.remaining ?? 0);
  }
  const frontDeskRefund = overpaid - refundOnline;
  const due = Math.max(0, newQuote.total - money.received);
  return {
    ok: true,
    plan: {
      res, rooms, oldItem, offer, nights: stay.nights, newQuote, difference, refundOnline, frontDeskRefund,
      balanceDue: due,
      ...(charge && refundOnline > 0 ? { chargeId: charge.id, chargeMethod: charge.method } : {}),
    },
  };
}

/**
 * The booking's add-ons at the prices it was booked at, as quote() lines for the new stay. A line's amount is
 * unitPrice × qty × (1, nights, or adults × nights by its unit), so dividing by the old multiplier gives back
 * unitPrice × qty. An add-on whose row is gone keeps its amount (as per stay).
 */
async function keptAddons(db: Db, old: Quote, oldAdults: number): Promise<AddonLine[]> {
  const ids = old.addonLines.map((l) => l.addonId);
  const rows = ids.length
    ? await db.select({ id: addonsTable.id, unit: addonsTable.unit }).from(addonsTable).where(inArray(addonsTable.id, ids))
    : [];
  return old.addonLines.map((l) => {
    const unit = rows.find((r) => r.id === l.addonId)?.unit ?? "per_stay";
    const mult = unit === "per_stay" ? 1 : unit === "per_night" ? old.nights : oldAdults * old.nights;
    return { addonId: l.addonId, unit, unitPrice: mult > 0 ? l.amount / mult : 0, qty: 1 };
  });
}

/** The booking's promo code, applied again as it is now defined; its usage count is not checked. */
async function keptPromo(db: Db, res: Reservation): Promise<Promo | undefined> {
  const code = (res.quote as Quote).promoCode ?? res.promoCode;
  if (!code) return undefined;
  const [p] = await db.select().from(promoCodes).where(and(eq(promoCodes.propertyId, res.propertyId), eq(promoCodes.code, code)));
  return p ? { code: p.code, kind: p.kind, value: p.value } : undefined;
}

export type ModifyFormOptions = {
  unitTypes: { slug: string; name: string }[];
  ratePlans: { slug: string; name: string }[];
  current: { unitTypeSlug: string; ratePlanSlug: string };
};

/** For the detail page's 修改訂單 dialog: the property's active room types and rate plans (zh-TW) and the booking's own. */
export async function modifyFormOptions(db: Db, propertyId: string, reservationId: string): Promise<ModifyFormOptions | null> {
  const [cur] = await db.select({ unit: unitTypes.slug, plan: ratePlans.slug }).from(reservationRooms)
    .innerJoin(unitTypes, eq(unitTypes.id, reservationRooms.unitTypeId))
    .innerJoin(ratePlans, eq(ratePlans.id, reservationRooms.ratePlanId))
    .where(eq(reservationRooms.reservationId, reservationId)).limit(1);
  if (!cur) return null;
  const [types, plans] = await Promise.all([
    db.select({ slug: unitTypes.slug, name: unitTypes.name }).from(unitTypes)
      .where(and(eq(unitTypes.propertyId, propertyId), eq(unitTypes.active, true))).orderBy(unitTypes.sortOrder),
    db.select({ slug: ratePlans.slug, name: ratePlans.name }).from(ratePlans)
      .where(and(eq(ratePlans.propertyId, propertyId), eq(ratePlans.active, true))),
  ]);
  return {
    unitTypes: types.map((t) => ({ slug: t.slug, name: t.name["zh-TW"] })),
    ratePlans: plans.map((p) => ({ slug: p.slug, name: p.name["zh-TW"] })),
    current: { unitTypeSlug: cur.unit, ratePlanSlug: cur.plan },
  };
}
