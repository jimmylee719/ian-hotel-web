import { and, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { guests, payments, ratePlans, reservationRooms, reservations, unitTypes } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { countsAsReceived, displayMoney, moneyByReservation, receivedSum } from "./money-metrics";
import { paginate, type Page } from "./paginate";
import { containsText } from "./search";
import { nightsBetween, type ResStatus } from "./reservations";

export type GuestListRow = {
  id: string;
  name: string;
  email: string;
  phone: string;
  country: string;
  /** All reservations, whatever their status. */
  reservationCount: number;
  /** Confirmed reservations: stays booked and kept. */
  stays: number;
  /** Net money received (charges and front-desk payments, minus refunds) across all their reservations. */
  totalSpent: number;
};

export async function listGuests(
  db: Db, propertyId: string, f: { q?: string; page: number; pageSize: number },
): Promise<Page<GuestListRow>> {
  const conds: (SQL | undefined)[] = [eq(guests.propertyId, propertyId)];
  const q = f.q?.trim();
  if (q) {
    conds.push(or(
      containsText(guests.firstName, q), containsText(guests.lastName, q),
      containsText(sql`${guests.firstName} || ' ' || ${guests.lastName}`, q),
      containsText(guests.email, q), containsText(guests.phone, q),
    ));
  }
  const where = and(...conds);

  return paginate<GuestListRow>({
    total: async () => Number((await db.select({ n: count() }).from(guests).where(where))[0]?.n ?? 0),
    rows: async (limit, offset) => {
      const page = await db.select().from(guests).where(where).orderBy(desc(guests.createdAt), guests.id).limit(limit).offset(offset);
      const ids = page.map((g) => g.id);
      const [counts, money] = await Promise.all([
        db.select({
          gid: reservations.guestId, n: count(), stays: sql<number>`sum(${reservations.status} = 'confirmed')`,
        }).from(reservations).where(inArray(reservations.guestId, ids)).groupBy(reservations.guestId),
        db.select({
          gid: reservations.guestId,
          received: receivedSum,
        }).from(payments).innerJoin(reservations, eq(reservations.id, payments.reservationId))
          .where(and(inArray(reservations.guestId, ids), countsAsReceived))
          .groupBy(reservations.guestId),
      ]);
      const c = new Map(counts.map((x) => [x.gid, x]));
      const m = new Map(money.map((x) => [x.gid, Number(x.received)]));
      return page.map((g): GuestListRow => ({
        id: g.id, name: `${g.firstName} ${g.lastName}`, email: g.email, phone: g.phone, country: g.country,
        reservationCount: Number(c.get(g.id)?.n ?? 0), stays: Number(c.get(g.id)?.stays ?? 0), totalSpent: m.get(g.id) ?? 0,
      }));
    },
  }, { page: f.page, pageSize: f.pageSize });
}

export type GuestHistoryRow = {
  id: string; code: string; status: ResStatus; checkIn: string; checkOut: string; nights: number;
  roomName: string; total: number; paid: number; refunded: number; balanceDue: number | null;
};

export type GuestDetail = Omit<GuestListRow, "reservationCount"> & {
  locale: string;
  createdAt: number;
  /** Newest first. */
  reservations: GuestHistoryRow[];
};

export async function getGuest(db: Db, propertyId: string, id: string): Promise<GuestDetail | null> {
  const [g] = await db.select().from(guests).where(and(eq(guests.id, id), eq(guests.propertyId, propertyId)));
  if (!g) return null;
  const rs = await db.select().from(reservations)
    .where(and(eq(reservations.guestId, id), eq(reservations.propertyId, propertyId)))
    .orderBy(desc(reservations.createdAt), reservations.code);
  const ids = rs.map((r) => r.id);
  const [money, rooms] = await Promise.all([
    moneyByReservation(db, ids),
    ids.length
      ? db.select({ rid: reservationRooms.reservationId, name: unitTypes.name }).from(reservationRooms)
          .innerJoin(unitTypes, eq(unitTypes.id, reservationRooms.unitTypeId))
          .innerJoin(ratePlans, eq(ratePlans.id, reservationRooms.ratePlanId))
          .where(inArray(reservationRooms.reservationId, ids)).orderBy(reservationRooms.id)
      : Promise.resolve([]),
  ]);
  const names = new Map<string, string[]>();
  for (const r of rooms) names.set(r.rid, [...(names.get(r.rid) ?? []), r.name["zh-TW"]]);

  const history = rs.map((r): GuestHistoryRow => {
    const m = money.get(r.id)!;
    return {
      id: r.id, code: r.code, status: r.status, checkIn: r.checkIn, checkOut: r.checkOut, nights: nightsBetween(r.checkIn, r.checkOut),
      roomName: [...new Set(names.get(r.id) ?? [])].join("、"), total: r.totalAmount,
      ...displayMoney(r.status, r.totalAmount, m),
    };
  });
  return {
    id: g.id, name: `${g.firstName} ${g.lastName}`, email: g.email, phone: g.phone, country: g.country, locale: g.locale, createdAt: g.createdAt,
    stays: rs.filter((r) => r.status === "confirmed").length,
    totalSpent: [...money.values()].reduce((s, m) => s + m.received, 0),
    reservations: history,
  };
}
