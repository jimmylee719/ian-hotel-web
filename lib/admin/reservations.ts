import { bookingTerms } from "@/lib/booking/terms";
import { and, count, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { addDaysISO, type ISODate } from "@/lib/domain/dates";
import { runAtomic } from "@/lib/db/atomic";
import {
  auditLog, guests, notifications, paymentEvents, payments, reservationNotes, reservationRooms, reservations,
  unitTypes,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { auditStatement } from "./audit";
import { AdminAuthError, type StaffContext } from "./auth";
import { displayMoney, type DisplayMoney, moneyByReservation } from "./money-metrics";
import { paginate, type Page } from "./paginate";
import { can } from "./permissions";
import { containsText } from "./search";

export type ResStatus = typeof reservations.$inferSelect["status"];

export type ReservationFilter = {
  q?: string;
  status?: ResStatus[];
  syncState?: string[];
  /** Inclusive `YYYY-MM-DD` bounds on `dateField` (Taipei calendar days for createdAt). */
  from?: ISODate;
  to?: ISODate;
  dateField?: "checkIn" | "createdAt";
  page: number;
  pageSize: number;
  /** Default `-createdAt` (newest first). */
  sort?: "checkIn" | "-createdAt";
};

export type ReservationListRow = {
  id: string;
  code: string;
  status: ResStatus;
  syncState: string;
  checkIn: ISODate;
  checkOut: ISODate;
  nights: number;
  roomName: string;
  guestName: string;
  total: number;
  /** Net received (charges and front-desk payments minus refunds). */
  paid: number;
  refunded: number;
  /** Null for closed bookings. */
  balanceDue: number | null;
  createdAt: number;
};

const DAY = 86_400_000;
/** Taipei is UTC+8 with no DST: a calendar day starts at its UTC midnight minus 8h. */
const taipeiDayStart = (d: ISODate) => Date.parse(d) - 8 * 3_600_000;

export const nightsBetween = (checkIn: ISODate, checkOut: ISODate) => Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / DAY);

const nameOf = (g: { firstName: string; lastName: string }) => `${g.firstName} ${g.lastName}`;

/** Room type names (zh-TW) per reservation, in booking order, joined with 、. */
async function roomNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return new Map();
  const rows = await db.select({ rid: reservationRooms.reservationId, name: unitTypes.name })
    .from(reservationRooms).innerJoin(unitTypes, eq(unitTypes.id, reservationRooms.unitTypeId))
    .where(inArray(reservationRooms.reservationId, ids)).orderBy(reservationRooms.id);
  for (const r of rows) out.set(r.rid, [...(out.get(r.rid) ?? []), r.name["zh-TW"]]);
  return new Map([...out].map(([id, names]) => [id, [...new Set(names)].join("、")]));
}

export async function listReservations(db: Db, propertyId: string, f: ReservationFilter): Promise<Page<ReservationListRow>> {
  const conds: (SQL | undefined)[] = [eq(reservations.propertyId, propertyId)];
  const q = f.q?.trim();
  if (q) {
    conds.push(or(
      containsText(reservations.code, q), containsText(guests.firstName, q), containsText(guests.lastName, q),
      containsText(sql`${guests.firstName} || ' ' || ${guests.lastName}`, q),
      containsText(reservations.guestEmailLower, q), containsText(guests.phone, q),
    ));
  }
  if (f.status?.length) conds.push(inArray(reservations.status, f.status));
  if (f.syncState?.length) conds.push(inArray(reservations.syncState, f.syncState as (typeof reservations.$inferSelect)["syncState"][]));
  if (f.dateField === "createdAt") {
    if (f.from) conds.push(gte(reservations.createdAt, taipeiDayStart(f.from)));
    if (f.to) conds.push(lt(reservations.createdAt, taipeiDayStart(addDaysISO(f.to, 1))));
  } else {
    if (f.from) conds.push(gte(reservations.checkIn, f.from));
    if (f.to) conds.push(lte(reservations.checkIn, f.to));
  }
  const where = and(...conds);
  const order = f.sort === "checkIn" ? [reservations.checkIn, reservations.code] : [desc(reservations.createdAt), reservations.code];

  return paginate<ReservationListRow>({
    total: async () => Number((await db.select({ n: count() }).from(reservations).innerJoin(guests, eq(guests.id, reservations.guestId)).where(where))[0]?.n ?? 0),
    rows: async (limit, offset) => {
      const base = await db.select({
        id: reservations.id, code: reservations.code, status: reservations.status, syncState: reservations.syncState,
        checkIn: reservations.checkIn, checkOut: reservations.checkOut, total: reservations.totalAmount,
        createdAt: reservations.createdAt, firstName: guests.firstName, lastName: guests.lastName,
      }).from(reservations).innerJoin(guests, eq(guests.id, reservations.guestId))
        .where(where).orderBy(...order).limit(limit).offset(offset);
      const ids = base.map((r) => r.id);
      const [rooms, money] = await Promise.all([roomNames(db, ids), moneyByReservation(db, ids)]);
      return base.map(({ firstName, lastName, ...r }): ReservationListRow => {
        const m = displayMoney(r.status, r.total, money.get(r.id)!);
        return {
          ...r, nights: nightsBetween(r.checkIn, r.checkOut), roomName: rooms.get(r.id) ?? "",
          guestName: nameOf({ firstName, lastName }), ...m,
        };
      });
    },
  }, { page: f.page, pageSize: f.pageSize });
}

export type TimelineType = "payment" | "event" | "notification" | "audit" | "note";
export type TimelineItem = { type: TimelineType; id: string; at: number; title: string; detail?: string };

export type ReservationDetail = {
  reservation: {
    id: string; code: string; status: ResStatus; syncState: string; channel: string; checkIn: ISODate; checkOut: ISODate;
    nights: number; adults: number; children: number; locale: string; totalAmount: number; refundedAmount: number;
    promoCode: string | null; smConfirmation: string | null; lastSyncError: string | null;
    createdAt: number; updatedAt: number; cancelledAt: number | null;
    /** What the front desk still owes the guest (after a price-lowering modification or a cancellation, less desk payouts). */
    frontDeskRefundDue: number;
    /** How many staff modifications the booking has had. */
    modCount: number;
    /** Channel hand-off failures in a row (0 once it succeeds). */
    syncAttempts: number;
    /** When the booking was first pushed to the channel (null = never). */
    channelPushedAt: number | null;
  };
  guest: { id: string; name: string; email: string; phone: string; country: string };
  quote: unknown;
  rooms: { unitTypeName: string; ratePlanName: string; nightlyPrices: number[] }[];
  /** `paid` is received (net); `grossReceived` is before refunds, display only. */
  money: DisplayMoney & { grossReceived: number };
  payments: {
    id: string; kind: string; method: string; status: string; amount: number; last4: string | null; authCode: string | null;
    providerRef: string | null; idempotencyKey: string | null; refundOf: string | null; createdAt: number; note: string | null;
  }[];
  /** Payment-provider callbacks. The raw body is never returned, only its length. */
  events: { id: string; provider: string; providerRef: string | null; verdict: string; bodyLength: number; at: number }[];
  notifications: { id: string; kind: string; to: string; status: string; at: number }[];
  audit: { id: string; staffEmail: string; action: string; entity: string; entityId: string; before: unknown; after: unknown; at: number }[];
  notes: { id: string; staffEmail: string; body: string; createdAt: number }[];
  /** Everything above on one clock, oldest first. */
  timeline: TimelineItem[];
};

export async function getReservationDetail(db: Db, propertyId: string, id: string): Promise<ReservationDetail | null> {
  const [row] = await db.select({ r: reservations, g: guests }).from(reservations)
    .innerJoin(guests, eq(guests.id, reservations.guestId))
    .where(and(eq(reservations.id, id), eq(reservations.propertyId, propertyId)));
  if (!row) return null;
  const { r, g } = row;

  const [rooms, pays, events, notifs, notes] = await Promise.all([
    db.select({ unit: unitTypes.name, nightlyPrices: reservationRooms.nightlyPrices })
      .from(reservationRooms)
      .innerJoin(unitTypes, eq(unitTypes.id, reservationRooms.unitTypeId))
      .where(eq(reservationRooms.reservationId, id)).orderBy(reservationRooms.id),
    db.select().from(payments).where(eq(payments.reservationId, id)).orderBy(payments.createdAt, payments.id),
    db.select({
      id: paymentEvents.id, provider: paymentEvents.provider, providerRef: paymentEvents.providerRef,
      verdict: paymentEvents.verdict, bodyLength: sql<number>`length(${paymentEvents.rawBody})`, at: paymentEvents.at,
    }).from(paymentEvents)
      .where(and(eq(paymentEvents.propertyId, propertyId), eq(paymentEvents.reservationCode, r.code))).orderBy(paymentEvents.at, paymentEvents.id),
    db.select().from(notifications).where(eq(notifications.reservationId, id)).orderBy(notifications.at, notifications.id),
    db.select().from(reservationNotes).where(eq(reservationNotes.reservationId, id)).orderBy(reservationNotes.createdAt, reservationNotes.id),
  ]);

  const auditScope: SQL[] = [and(eq(auditLog.entity, "reservation"), eq(auditLog.entityId, id))!];
  if (pays.length) auditScope.push(and(eq(auditLog.entity, "payment"), inArray(auditLog.entityId, pays.map((p) => p.id)))!);
  if (notifs.length) auditScope.push(and(eq(auditLog.entity, "notification"), inArray(auditLog.entityId, notifs.map((n) => n.id)))!);
  if (notes.length) auditScope.push(and(eq(auditLog.entity, "reservation_note"), inArray(auditLog.entityId, notes.map((n) => n.id)))!);
  const audit = await db.select().from(auditLog).where(or(...auditScope)).orderBy(auditLog.at, auditLog.id);

  const metrics = (await moneyByReservation(db, [id])).get(id)!;
  const eventRows = events.map((e) => ({ ...e, bodyLength: Number(e.bodyLength) }));

  const timeline: TimelineItem[] = [
    ...pays.map((p): TimelineItem => ({
      type: "payment", id: p.id, at: p.createdAt, title: `${p.kind} ${p.status}`,
      detail: `${p.method} NT$${p.amount}${p.last4 ? ` ****${p.last4}` : ""}`,
    })),
    ...eventRows.map((e): TimelineItem => ({
      type: "event", id: e.id, at: e.at, title: `收款回呼 ${e.verdict}`, detail: `${e.provider} · 原文 ${e.bodyLength} 字元（不顯示）`,
    })),
    ...notifs.map((n): TimelineItem => ({ type: "notification", id: n.id, at: n.at, title: `通知信 ${n.kind} ${n.status}`, detail: n.to })),
    // A note's own audit row is the same fact as the note, so only the note is on the timeline.
    ...audit.filter((a) => a.entity !== "reservation_note").map((a): TimelineItem => ({
      type: "audit", id: a.id, at: a.at, title: a.action, detail: a.staffEmail,
    })),
    ...notes.map((n): TimelineItem => ({ type: "note", id: n.id, at: n.createdAt, title: "內部備註", detail: `${n.staffEmail}：${n.body}` })),
  ].sort((a, b) => a.at - b.at || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));

  return {
    reservation: {
      id: r.id, code: r.code, status: r.status, syncState: r.syncState, channel: r.channel, checkIn: r.checkIn, checkOut: r.checkOut,
      nights: nightsBetween(r.checkIn, r.checkOut), adults: r.adults, children: r.children, locale: r.locale,
      totalAmount: r.totalAmount, refundedAmount: r.refundedAmount, promoCode: r.promoCode, smConfirmation: r.smConfirmation,
      lastSyncError: r.lastSyncError, createdAt: r.createdAt, updatedAt: r.updatedAt, cancelledAt: r.cancelledAt,
      frontDeskRefundDue: r.frontDeskRefundDue, modCount: r.modCount, syncAttempts: r.syncAttempts, channelPushedAt: r.channelPushedAt,
    },
    guest: { id: g.id, name: nameOf(g), email: g.email, phone: g.phone, country: g.country },
    quote: r.quote,
    rooms: rooms.map((x) => ({ unitTypeName: x.unit["zh-TW"], ratePlanName: bookingTerms(r).ratePlanName["zh-TW"], nightlyPrices: x.nightlyPrices })),
    money: { ...displayMoney(r.status, r.totalAmount, metrics), grossReceived: metrics.grossReceived },
    payments: pays.map((p) => ({
      id: p.id, kind: p.kind, method: p.method, status: p.status, amount: p.amount, last4: p.last4, authCode: p.authCode,
      providerRef: p.providerRef, idempotencyKey: p.idempotencyKey, refundOf: p.refundOf, createdAt: p.createdAt, note: p.note,
    })),
    events: eventRows,
    notifications: notifs.map((n) => ({ id: n.id, kind: n.kind, to: n.to, status: n.status, at: n.at })),
    audit: audit.map((a) => ({ id: a.id, staffEmail: a.staffEmail, action: a.action, entity: a.entity, entityId: a.entityId, before: a.before, after: a.after, at: a.at })),
    notes: notes.map((n) => ({ id: n.id, staffEmail: n.staffEmail, body: n.body, createdAt: n.createdAt })),
    timeline,
  };
}

export const NOTE_MAX = 2000;
export type NoteErrorCode = "NOT_FOUND" | "NOTE_EMPTY" | "NOTE_TOO_LONG";
export class NoteError extends Error {
  constructor(readonly code: NoteErrorCode) {
    super(`reservation note rejected: ${code}`);
    this.name = "NoteError";
  }
}

/**
 * Append an internal note (1 to 2000 characters once trimmed). Needs `reservations.view` at the reservation's
 * property. The note and its audit row commit together. Notes are never edited or deleted.
 */
export async function addReservationNote(
  db: Db, ctx: StaffContext, reservationId: string, body: string, now: Date,
): Promise<typeof reservationNotes.$inferSelect> {
  if (!can(ctx.staff, "reservations.view")) throw new AdminAuthError(403, "FORBIDDEN");
  const [r] = await db.select({ propertyId: reservations.propertyId }).from(reservations).where(eq(reservations.id, reservationId));
  if (!r) throw new NoteError("NOT_FOUND");
  if (!can(ctx.staff, "reservations.view", r.propertyId)) throw new AdminAuthError(403, "FORBIDDEN");

  const text = body.trim();
  const length = Array.from(text).length;
  if (length < 1) throw new NoteError("NOTE_EMPTY");
  if (length > NOTE_MAX) throw new NoteError("NOTE_TOO_LONG");

  const note = {
    id: crypto.randomUUID(), reservationId, propertyId: r.propertyId, staffEmail: ctx.email, body: text, createdAt: now.getTime(),
  };
  await runAtomic(db, [
    db.insert(reservationNotes).values(note),
    auditStatement(db, ctx, { action: "reservation.note", entity: "reservation_note", entityId: note.id, after: { reservationId, body: text } }, now),
  ]);
  return note;
}
