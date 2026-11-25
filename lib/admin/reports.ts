import { and, count, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { bookingTerms } from "@/lib/booking/terms";
import { addons, inventoryDaily, payments, reservationRooms, reservations, unitTypes } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { addDaysISO, daysBefore, todayInTaipei, type ISODate } from "@/lib/domain/dates";
import { countsAsReceived, DESK_METHODS, moneyByReservation, moneyMovedAt, summarizeMoney } from "./money-metrics";
import { listReservations, type ReservationListRow } from "./reservations";

export const MAX_REPORT_DAYS = 366;
export const REPORT_KINDS = ["revenue", "occupancy", "bookings", "cancellations"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export type Range = { from: ISODate; to: ISODate };
export type RangeError = "INVALID_RANGE" | "RANGE_TOO_LONG";

const DAY = 86_400_000;
const isRealDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const daysInclusive = (r: Range) => Math.round((Date.parse(r.to) - Date.parse(r.from)) / DAY) + 1;
/** Taipei is UTC+8 with no DST: a calendar day starts at its UTC midnight minus 8h. */
const dayStart = (d: ISODate) => Date.parse(d) - 8 * 3_600_000;
const taipeiDate = (ms: number) => todayInTaipei(new Date(ms));
const inRangeMs = (r: Range) => [dayStart(r.from), dayStart(addDaysISO(r.to, 1))] as const;
/** The dates from `from` up to, not including, `end`. */
function* eachDay(from: ISODate, end: ISODate): Generator<ISODate> {
  for (let t = Date.parse(from); t < Date.parse(end); t += DAY) yield new Date(t).toISOString().slice(0, 10);
}
const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;

/** `from` ≤ `to`, both real dates, at most 366 days (inclusive). Every report, JSON or CSV, is gated by this. */
export function validateRange(from: string, to: string): { ok: true } | { ok: false; error: RangeError } {
  if (!isRealDate(from) || !isRealDate(to) || from > to) return { ok: false, error: "INVALID_RANGE" };
  return daysInclusive({ from, to }) > MAX_REPORT_DAYS ? { ok: false, error: "RANGE_TOO_LONG" } : { ok: true };
}

// ---------------------------------------------------------------- revenue

export type RevenueFigures = { onlineCharges: number; onlineRefunds: number; deskPayments: number; deskRefunds: number; net: number };
export type RevenueRow = RevenueFigures & { period: string };
export type RevenueReport = { rows: RevenueRow[]; total: RevenueFigures };

type MoneyRow = { kind: string; method: string; amount: number };

/** One bucket's figures. `net` is the money module's `received`; the four parts are the same rows split by where the money moved. */
function figures(rows: MoneyRow[]): RevenueFigures {
  const sum = (f: (r: MoneyRow) => boolean) => rows.filter(f).reduce((s, r) => s + r.amount, 0);
  const desk = (r: MoneyRow) => DESK_METHODS.includes(r.method);
  return {
    onlineCharges: sum((r) => r.kind === "charge"),
    onlineRefunds: sum((r) => r.kind === "refund" && !desk(r)),
    deskPayments: sum((r) => r.kind === "front_desk"),
    deskRefunds: sum((r) => r.kind === "refund" && desk(r)),
    net: summarizeMoney(rows).received,
  };
}

/**
 * Money that moved in the range, by Taipei day or month it MOVED (moneyMovedAt: a refund's settledAt, else createdAt). Same rows as the
 * dashboard's revenue KPI: succeeded charges, desk payments and refunds of this property's direct bookings
 * (countsAsReceived), so a month's total here equals the dashboard's month figure.
 */
export async function revenueReport(db: Db, propertyId: string, o: Range & { groupBy: "day" | "month" }): Promise<RevenueReport> {
  const [start, end] = inRangeMs(o);
  const rows = await db.select({ kind: payments.kind, method: payments.method, amount: payments.amount, at: moneyMovedAt })
    .from(payments).innerJoin(reservations, eq(reservations.id, payments.reservationId))
    .where(and(eq(reservations.propertyId, propertyId), eq(reservations.channel, "direct"), countsAsReceived,
      gte(moneyMovedAt, start), lt(moneyMovedAt, end)));
  const buckets = new Map<string, MoneyRow[]>();
  for (const r of rows) {
    const d = taipeiDate(r.at);
    const key = o.groupBy === "month" ? d.slice(0, 7) : d;
    buckets.set(key, [...(buckets.get(key) ?? []), r]);
  }
  return {
    rows: [...buckets].sort(([a], [b]) => (a < b ? -1 : 1)).map(([period, rs]) => ({ period, ...figures(rs) })),
    total: figures(rows),
  };
}

// -------------------------------------------------------------- occupancy

export type OccupancyRow = {
  date: ISODate; unitTypeId: string; unitTypeName: string;
  /** Room-nights sold. */
  sold: number;
  /** Rooms still sellable from the inventory cache; null when it has no row for that day. */
  available: number | null;
  /** sold / (sold + available); null (shown as "—") without an inventory row. */
  rate: number | null;
};
export type OccupancyReport = { rows: OccupancyRow[] };

/**
 * Room-nights sold per unit type per night. Counts confirmed bookings, plus the nights a cancelled booking had
 * already stayed: the cancel gave back only nights on or after its Taipei cancel date (`releaseFrom`), so the
 * nights before it stay sold (a cancel before check-in releases them all). One room row = one room.
 */
export async function occupancyReport(db: Db, propertyId: string, o: Range): Promise<OccupancyReport> {
  const end = addDaysISO(o.to, 1); // exclusive
  const [types, stays, inv] = await Promise.all([
    db.select({ id: unitTypes.id, name: unitTypes.name }).from(unitTypes).where(eq(unitTypes.propertyId, propertyId)).orderBy(unitTypes.sortOrder, unitTypes.slug),
    db.select({
      unitTypeId: reservationRooms.unitTypeId, checkIn: reservations.checkIn, checkOut: reservations.checkOut,
      status: reservations.status, cancelledAt: reservations.cancelledAt,
    }).from(reservationRooms).innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
      .where(and(eq(reservations.propertyId, propertyId), inArray(reservations.status, ["confirmed", "cancelled"]),
        lte(reservations.checkIn, o.to), sql`${reservations.checkOut} > ${o.from}`)),
    db.select({ unitTypeId: inventoryDaily.unitTypeId, date: inventoryDaily.date, available: inventoryDaily.available }).from(inventoryDaily)
      .where(and(eq(inventoryDaily.propertyId, propertyId), gte(inventoryDaily.date, o.from), lte(inventoryDaily.date, o.to))),
  ]);

  const sold = new Map<string, number>();
  for (const s of stays) {
    const cancelDate = s.status === "cancelled" ? (s.cancelledAt == null ? s.checkIn : taipeiDate(s.cancelledAt)) : null;
    const first = s.checkIn > o.from ? s.checkIn : o.from;
    const last = s.checkOut < end ? s.checkOut : end;
    for (const d of eachDay(first, last)) {
      if (cancelDate !== null && d >= cancelDate) continue;
      const k = `${s.unitTypeId}|${d}`;
      sold.set(k, (sold.get(k) ?? 0) + 1);
    }
  }
  const available = new Map(inv.map((i) => [`${i.unitTypeId}|${i.date}`, i.available]));

  const rows: OccupancyRow[] = [];
  for (const date of eachDay(o.from, end)) {
    for (const t of types) {
      const k = `${t.id}|${date}`;
      const s = sold.get(k) ?? 0;
      const a = available.get(k) ?? null;
      rows.push({ date, unitTypeId: t.id, unitTypeName: t.name["zh-TW"], sold: s, available: a, rate: a === null || s + a === 0 ? null : s / (s + a) });
    }
  }
  return { rows };
}

// --------------------------------------------------------------- bookings

export type BookingReportRow = ReservationListRow & {
  /** Booking time, Taipei `YYYY-MM-DD HH:mm`. */
  bookedAt: string;
  /** The plan name as booked (bookingTerms), not the rate plan's current name. */
  ratePlan: string;
  promoCode: string;
  discount: number;
  /** `名稱 NT$金額` per line, joined with ；. */
  addons: string;
  addonTotal: number;
};
export type BookingsReport = { rows: BookingReportRow[]; columns: { key: string; label: string }[] };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const BOOKING_COLUMNS = [
  { key: "code", label: "訂單編號" }, { key: "status", label: "狀態" }, { key: "bookedAt", label: "訂購時間" },
  { key: "guestName", label: "旅客" }, { key: "roomName", label: "房型" }, { key: "ratePlan", label: "房價方案" },
  { key: "checkIn", label: "入住" }, { key: "checkOut", label: "退房" }, { key: "nights", label: "晚數" },
  { key: "total", label: "總額" }, { key: "paid", label: "已收（淨額）" }, { key: "refunded", label: "已退款" }, { key: "balanceDue", label: "待收" },
  { key: "promoCode", label: "折扣碼" }, { key: "discount", label: "折扣金額" }, { key: "addons", label: "加購" }, { key: "addonTotal", label: "加購小計" },
];

const taipeiMinute = (ms: number) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", dateStyle: "short", timeStyle: "short" }).format(ms);

/**
 * One row per booking with a check-in in the range: the reservation list's columns (the same rows and money
 * figures), plus the promo code and discount and add-on lines from the booking's quote, and the plan name as booked.
 */
export async function bookingsReport(db: Db, propertyId: string, o: Range): Promise<BookingsReport> {
  const list: ReservationListRow[] = [];
  // Small pages keep every `inArray` under D1's bound-parameter limit.
  for (let page = 1; ; page++) {
    const r = await listReservations(db, propertyId, { from: o.from, to: o.to, dateField: "checkIn", sort: "checkIn", page, pageSize: 50 });
    list.push(...r.rows);
    if (page >= r.pageCount) break;
  }
  const addonNames = new Map((await db.select({ id: addons.id, name: addons.name }).from(addons).where(eq(addons.propertyId, propertyId))).map((a) => [a.id, a.name["zh-TW"]]));
  const extra = new Map<string, Pick<BookingReportRow, "ratePlan" | "promoCode" | "discount" | "addons" | "addonTotal">>();
  for (const ids of chunks(list.map((r) => r.id), 50)) {
    const found = await db.select({ id: reservations.id, quote: reservations.quote, promoCode: reservations.promoCode, cancelPolicy: reservations.cancelPolicy, ratePlanName: reservations.ratePlanName })
      .from(reservations).where(inArray(reservations.id, ids));
    for (const f of found) {
      const q = obj(f.quote);
      const lines = (Array.isArray(q.addonLines) ? q.addonLines : []).map(obj);
      extra.set(f.id, {
        ratePlan: bookingTerms(f).ratePlanName["zh-TW"],
        promoCode: f.promoCode ?? (typeof q.promoCode === "string" ? q.promoCode : ""),
        discount: num(q.discount),
        addons: lines.map((l) => `${addonNames.get(String(l.addonId)) ?? `add-on ${String(l.addonId)}`} ${twd(num(l.amount))}`).join("；"),
        addonTotal: lines.reduce((s, l) => s + num(l.amount), 0),
      });
    }
  }
  const blank = { ratePlan: "", promoCode: "", discount: 0, addons: "", addonTotal: 0 };
  return { rows: list.map((r) => ({ ...r, bookedAt: taipeiMinute(r.createdAt), ...(extra.get(r.id) ?? blank) })), columns: BOOKING_COLUMNS };
}

// ----------------------------------------------------------- cancellation

export type CancellationReport = {
  /** Bookings cancelled in the range (Taipei date of `cancelledAt`). */
  cancellations: number;
  /** Everything refunded (online and paid out at the desk) on those bookings. */
  refundTotal: number;
  /** Of the bookings made in the range that reached confirmation (confirmed or cancelled), how many were cancelled (any time). */
  rate: number | null;
  rateBase: number;
  buckets: { label: string; count: number }[];
};

const BUCKETS: { label: string; match: (days: number) => boolean }[] = [
  { label: "入住後", match: (d) => d < 0 },
  { label: "入住當天", match: (d) => d === 0 },
  { label: "前 1 天", match: (d) => d === 1 },
  { label: "前 2–6 天", match: (d) => d >= 2 && d <= 6 },
  { label: "前 7–13 天", match: (d) => d >= 7 && d <= 13 },
  { label: "前 14 天以上", match: (d) => d >= 14 },
];

/** Cancellations in the range, how long before check-in they came (Taipei days), refunds paid, and the cancellation rate. */
export async function cancellationReport(db: Db, propertyId: string, o: Range): Promise<CancellationReport> {
  const [start, end] = inRangeMs(o);
  const cancelled = await db.select({ id: reservations.id, checkIn: reservations.checkIn, at: reservations.cancelledAt }).from(reservations)
    .where(and(eq(reservations.propertyId, propertyId), eq(reservations.status, "cancelled"), gte(reservations.cancelledAt, start), lt(reservations.cancelledAt, end)));

  const counts = BUCKETS.map(() => 0);
  for (const c of cancelled) {
    const days = daysBefore(c.checkIn, new Date(c.at!));
    counts[BUCKETS.findIndex((b) => b.match(days))]++;
  }
  let refundTotal = 0;
  for (const ids of chunks(cancelled.map((c) => c.id), 50))
    for (const m of (await moneyByReservation(db, ids)).values()) refundTotal += m.refunded;

  const cohort = await db.select({ status: reservations.status, n: count() }).from(reservations)
    .where(and(eq(reservations.propertyId, propertyId), inArray(reservations.status, ["confirmed", "cancelled"]), gte(reservations.createdAt, start), lt(reservations.createdAt, end)))
    .groupBy(reservations.status);
  const n = (s: string) => Number(cohort.find((c) => c.status === s)?.n ?? 0);
  const rateBase = n("confirmed") + n("cancelled");

  return {
    cancellations: cancelled.length, refundTotal, rateBase, rate: rateBase ? n("cancelled") / rateBase : null,
    buckets: BUCKETS.map((b, i) => ({ label: b.label, count: counts[i] })),
  };
}

// ------------------------------------------------------------- dispatcher

export type ReportOutput = { data: unknown; csv: { rows: Record<string, unknown>[]; columns: { key: string; label: string }[] } };

const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 1000) / 10}%`);

/** Any report as JSON data plus the rows and columns of its CSV export. */
export async function runReport(db: Db, propertyId: string, kind: ReportKind, range: Range, groupBy: "day" | "month"): Promise<ReportOutput> {
  switch (kind) {
    case "revenue": {
      const r = await revenueReport(db, propertyId, { ...range, groupBy });
      return {
        data: r,
        csv: {
          rows: [...r.rows, { period: "合計", ...r.total }],
          columns: [
            { key: "period", label: groupBy === "month" ? "月份" : "日期" }, { key: "onlineCharges", label: "線上收款" },
            { key: "onlineRefunds", label: "線上退款" }, { key: "deskPayments", label: "櫃檯收款" },
            { key: "deskRefunds", label: "櫃檯退款" }, { key: "net", label: "淨額" },
          ],
        },
      };
    }
    case "occupancy": {
      const r = await occupancyReport(db, propertyId, range);
      return {
        data: r,
        csv: {
          rows: r.rows.map((x) => ({ ...x, rateLabel: pct(x.rate) })),
          columns: [
            { key: "date", label: "日期" }, { key: "unitTypeName", label: "房型" }, { key: "sold", label: "已售間夜" },
            { key: "available", label: "可售" }, { key: "rateLabel", label: "住房率" },
          ],
        },
      };
    }
    case "bookings": {
      const r = await bookingsReport(db, propertyId, range);
      return { data: r, csv: { rows: r.rows, columns: r.columns } };
    }
    case "cancellations": {
      const r = await cancellationReport(db, propertyId, range);
      return {
        data: r,
        csv: {
          rows: [
            { item: "取消數", value: r.cancellations }, { item: "取消率", value: pct(r.rate) }, { item: "取消率分母（期間內成立的訂單）", value: r.rateBase },
            { item: "退款總額", value: r.refundTotal }, ...r.buckets.map((b) => ({ item: `取消時距入住：${b.label}`, value: b.count })),
          ],
          columns: [{ key: "item", label: "項目" }, { key: "value", label: "數值" }],
        },
      };
    }
  }
}
