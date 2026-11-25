import { and, eq, gte, inArray, like, lte, sql } from "drizzle-orm";
import { addDaysISO, todayInTaipei, type ISODate } from "@/lib/domain/dates";
import { formatTwd } from "@/lib/email/templates";
import { guests, notifications, paymentEvents, payments, reservationRooms, reservations } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { MONEY_KINDS, netDelta } from "./money-metrics";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const SYNC_STALE_MS = 15 * MIN;
export const REFUND_STALE_MS = 10 * MIN;
export const RECENT_MS = 7 * DAY;
/** Money the desk owes a guest should be handed back within a day. */
export const DESK_REFUND_STALE_MS = DAY;

export type ReservationRow = {
  id: string;
  code: string;
  status: string;
  guestName: string;
  checkIn: ISODate;
  checkOut: ISODate;
  adults: number;
  children: number;
  totalAmount: number;
};

export type AlertKind =
  | "sync_failed" | "sync_pending_stale" | "refund_pending" | "stray_refund_failed" | "email_failed" | "payment_alert"
  | "desk_refund_due";

export type Alert = { kind: AlertKind; reservationId?: string; code?: string; detail: string; since: number };

export type Kpi = { revenue: number; nights: number; cancellations: number };

export type Dashboard = {
  arrivalsToday: ReservationRow[];
  departuresToday: ReservationRow[];
  inHouse: ReservationRow[];
  pendingPayment: number;
  alerts: Alert[];
  kpis: { today: Kpi; month: Kpi };
};

/** Where an alert leads: refund trouble to the refunds page, otherwise the reservation (or refunds when none is known). */
export function alertHref(a: Alert): string {
  if (a.kind === "refund_pending" || !a.reservationId) return "/admin/refunds";
  return `/admin/reservations/${a.reservationId}`;
}

/** Most urgent first. */
const SEVERITY: AlertKind[] = [
  "stray_refund_failed", "payment_alert", "refund_pending", "desk_refund_due", "sync_failed", "sync_pending_stale", "email_failed",
];

const ROW = {
  id: reservations.id, code: reservations.code, status: reservations.status,
  checkIn: reservations.checkIn, checkOut: reservations.checkOut, adults: reservations.adults,
  children: reservations.children, totalAmount: reservations.totalAmount,
  firstName: guests.firstName, lastName: guests.lastName,
};

/** Whole days from `a` to `b` (both `YYYY-MM-DD`). */
const daysBetween = (a: ISODate, b: ISODate) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/** Nights of [checkIn, checkOut) that fall inside [from, to). */
function nightsWithin(checkIn: ISODate, checkOut: ISODate, from: ISODate, to: ISODate): number {
  const start = checkIn > from ? checkIn : from;
  const end = checkOut < to ? checkOut : to;
  return Math.max(0, daysBetween(start, end));
}

export async function getDashboard(db: Db, propertyId: string, now: Date): Promise<Dashboard> {
  const today = todayInTaipei(now);
  const monthStart = `${today.slice(0, 8)}01`;
  const nextMonthStart = `${addDaysISO(monthStart, 32).slice(0, 8)}01`;
  const nowMs = now.getTime();

  const rows = async (...where: Parameters<typeof and>) =>
    (await db.select(ROW).from(reservations).innerJoin(guests, eq(guests.id, reservations.guestId))
      .where(and(eq(reservations.propertyId, propertyId), ...where)).orderBy(reservations.checkIn, reservations.code))
      .map(({ firstName, lastName, ...r }): ReservationRow => ({ ...r, guestName: `${firstName} ${lastName}` }));
  const confirmed = eq(reservations.status, "confirmed");

  const [arrivalsToday, departuresToday, inHouse, pending] = await Promise.all([
    rows(confirmed, eq(reservations.checkIn, today)),
    rows(confirmed, eq(reservations.checkOut, today)),
    rows(confirmed, sql`${reservations.checkIn} < ${today}`, sql`${reservations.checkOut} > ${today}`),
    db.select({ n: sql<number>`count(*)` }).from(reservations)
      .where(and(eq(reservations.propertyId, propertyId), eq(reservations.status, "pending_payment"))),
  ]);

  return {
    arrivalsToday, departuresToday, inHouse,
    pendingPayment: Number(pending[0]?.n ?? 0),
    alerts: await loadAlerts(db, propertyId, nowMs),
    kpis: await loadKpis(db, propertyId, today, monthStart, nextMonthStart),
  };
}

async function loadAlerts(db: Db, propertyId: string, nowMs: number): Promise<Alert[]> {
  const own = eq(reservations.propertyId, propertyId);
  const recent = nowMs - RECENT_MS;
  // How long the desk has owed it: since its desk-due last rose from 0.
  const owedSince = reservations.deskDueSince;
  const [failed, stale, strays, refunds, emails, events, deskDue] = await Promise.all([
    db.select({ id: reservations.id, code: reservations.code, err: reservations.lastSyncError, at: reservations.updatedAt })
      .from(reservations).where(and(own, eq(reservations.syncState, "failed"))),
    db.select({ id: reservations.id, code: reservations.code, at: reservations.nextSyncAt })
      .from(reservations).where(and(own, eq(reservations.syncState, "pending"), lte(reservations.nextSyncAt, nowMs - SYNC_STALE_MS))),
    db.select({ id: reservations.id, code: reservations.code, err: reservations.lastSyncError, at: reservations.updatedAt })
      .from(reservations).where(and(own, like(reservations.lastSyncError, "STRAY_REFUND_FAILED%"))),
    db.select({ id: reservations.id, code: reservations.code, amount: payments.amount, at: payments.createdAt })
      .from(payments).innerJoin(reservations, eq(reservations.id, payments.reservationId))
      .where(and(own, eq(payments.kind, "refund"), eq(payments.status, "pending"), lte(payments.createdAt, nowMs - REFUND_STALE_MS))),
    db.select({ id: reservations.id, code: reservations.code, kind: notifications.kind, at: notifications.at })
      .from(notifications).innerJoin(reservations, eq(reservations.id, notifications.reservationId))
      .where(and(eq(notifications.propertyId, propertyId), eq(notifications.status, "failed"), gte(notifications.at, recent))),
    db.select({ verdict: paymentEvents.verdict, code: paymentEvents.reservationCode, ref: paymentEvents.providerRef, at: paymentEvents.at })
      .from(paymentEvents)
      .where(and(eq(paymentEvents.propertyId, propertyId), inArray(paymentEvents.verdict, ["amount_mismatch", "stray_charge"]), gte(paymentEvents.at, recent))),
    db.select({ id: reservations.id, code: reservations.code, amount: reservations.frontDeskRefundDue, at: owedSince })
      .from(reservations)
      .where(and(own, sql`${reservations.frontDeskRefundDue} > 0`, lte(owedSince, nowMs - DESK_REFUND_STALE_MS))),
  ]);

  // A payment event carries the reservation code, not its id.
  const codes = [...new Set(events.map((e) => e.code).filter((c): c is string => !!c))];
  const byCode = new Map<string, string>();
  if (codes.length) {
    const found = await db.select({ id: reservations.id, code: reservations.code }).from(reservations)
      .where(and(own, inArray(reservations.code, codes)));
    for (const r of found) byCode.set(r.code, r.id);
  }

  const alerts: Alert[] = [
    ...failed.map((r): Alert => ({ kind: "sync_failed", reservationId: r.id, code: r.code, detail: r.err ?? "同步失敗", since: r.at })),
    ...stale.map((r): Alert => ({ kind: "sync_pending_stale", reservationId: r.id, code: r.code, detail: "同步逾時未完成", since: r.at ?? 0 })),
    ...strays.map((r): Alert => ({ kind: "stray_refund_failed", reservationId: r.id, code: r.code, detail: r.err ?? "", since: r.at })),
    ...refunds.map((r): Alert => ({ kind: "refund_pending", reservationId: r.id, code: r.code, detail: `退款 NT$${r.amount} 處理中逾 10 分鐘`, since: r.at })),
    ...deskDue.map((r): Alert => ({
      kind: "desk_refund_due", reservationId: r.id, code: r.code, detail: `櫃檯尚未退還 ${formatTwd(r.amount)}，已超過 1 天`, since: Number(r.at),
    })),
    ...emails.map((r): Alert => ({ kind: "email_failed", reservationId: r.id, code: r.code, detail: `通知信寄送失敗（${r.kind}）`, since: r.at })),
    ...events.map((e): Alert => ({
      kind: "payment_alert",
      ...(e.code && byCode.has(e.code) ? { reservationId: byCode.get(e.code), code: e.code } : e.code ? { code: e.code } : {}),
      detail: `${e.verdict === "amount_mismatch" ? "金額不符" : "無對應訂單的收款"}${e.ref ? `（${e.ref}）` : ""}`,
      since: e.at,
    })),
  ];
  return alerts.sort((a, b) => SEVERITY.indexOf(a.kind) - SEVERITY.indexOf(b.kind) || a.since - b.since);
}

async function loadKpis(db: Db, propertyId: string, today: ISODate, monthStart: ISODate, nextMonthStart: ISODate) {
  const own = eq(reservations.propertyId, propertyId);
  // Taipei is UTC+8 with no DST, so the month's first instant is its first midnight minus 8h.
  const monthStartMs = Date.parse(monthStart) - 8 * 60 * MIN;

  const money = await db.select({ kind: payments.kind, amount: payments.amount, at: payments.createdAt })
    .from(payments).innerJoin(reservations, eq(reservations.id, payments.reservationId))
    .where(and(own, eq(reservations.channel, "direct"), eq(payments.status, "succeeded"),
      inArray(payments.kind, [...MONEY_KINDS]), gte(payments.createdAt, monthStartMs)));

  const stays = await db.select({ id: reservations.id, checkIn: reservations.checkIn, checkOut: reservations.checkOut })
    .from(reservations)
    .where(and(own, eq(reservations.status, "confirmed"), sql`${reservations.checkIn} < ${nextMonthStart}`, sql`${reservations.checkOut} > ${monthStart}`));
  const roomCount = new Map<string, number>();
  if (stays.length) {
    const rooms = await db.select({ rid: reservationRooms.reservationId, n: sql<number>`count(*)` }).from(reservationRooms)
      .where(inArray(reservationRooms.reservationId, stays.map((s) => s.id))).groupBy(reservationRooms.reservationId);
    for (const r of rooms) roomCount.set(r.rid, Number(r.n));
  }

  const cancelled = await db.select({ at: reservations.cancelledAt }).from(reservations)
    .where(and(own, eq(reservations.status, "cancelled"), gte(reservations.cancelledAt, monthStartMs)));

  const tomorrow = addDaysISO(today, 1);
  const kpi = (from: ISODate, to: ISODate): Kpi => {
    const inRange = (ms: number) => { const d = todayInTaipei(new Date(ms)); return d >= from && d < to; };
    return {
      revenue: money.filter((m) => inRange(m.at)).reduce((s, m) => s + netDelta(m.kind, m.amount), 0),
      nights: stays.reduce((s, r) => s + nightsWithin(r.checkIn, r.checkOut, from, to) * (roomCount.get(r.id) ?? 1), 0),
      cancellations: cancelled.filter((c) => c.at != null && inRange(c.at)).length,
    };
  };
  return { today: kpi(today, tomorrow), month: kpi(monthStart, nextMonthStart) };
}
