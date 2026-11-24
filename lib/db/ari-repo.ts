import { and, eq, inArray } from "drizzle-orm";
import { evaluateOffer, type Offer } from "@/lib/domain/availability";
import { parseStay } from "@/lib/domain/dates";
import { ariDaily, ratePlans, unitTypes } from "./schema";
import type { Db } from "./types";

export type SearchQuery = { propertyId: string; checkIn: string; checkOut: string; adults: number; rooms?: number };
export type RichOffer = Offer & { unitType: typeof unitTypes.$inferSelect; ratePlan: typeof ratePlans.$inferSelect };
export type SearchResult = { ok: true; offers: RichOffer[] } | { ok: false; error: string };

export async function searchAvailability(db: Db, q: SearchQuery): Promise<SearchResult> {
  const stay = parseStay(q.checkIn, q.checkOut);
  if (!stay.ok) return stay;
  const rooms = q.rooms ?? 1;
  const perRoom = Math.ceil(q.adults / rooms);

  const [types, plans, rows] = await Promise.all([
    db.select().from(unitTypes).where(and(eq(unitTypes.propertyId, q.propertyId), eq(unitTypes.active, true))),
    db.select().from(ratePlans).where(and(eq(ratePlans.propertyId, q.propertyId), eq(ratePlans.active, true))),
    db.select().from(ariDaily).where(and(eq(ariDaily.propertyId, q.propertyId), inArray(ariDaily.date, [...stay.nights, q.checkOut]))),
  ]);

  const groups = new Map<string, (typeof rows)[number][]>();
  for (const r of rows) {
    const k = `${r.unitTypeId}|${r.ratePlanId}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  const offers: RichOffer[] = [];
  for (const unitType of types) {
    if (unitType.maxOccupancy < perRoom) continue;
    for (const ratePlan of plans) {
      const g = groups.get(`${unitType.id}|${ratePlan.id}`) ?? [];
      const o = evaluateOffer({ unitTypeId: unitType.id, ratePlanId: ratePlan.id }, stay.nights, q.checkOut, g, rooms);
      if (o) offers.push({ ...o, unitType, ratePlan });
    }
  }
  offers.sort((a, b) => a.unitType.sortOrder - b.unitType.sortOrder || a.roomSubtotal - b.roomSubtotal);
  return { ok: true, offers };
}
