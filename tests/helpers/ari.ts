import { addDays, format, parse } from "date-fns";
import { and, eq } from "drizzle-orm";
import { ariDaily, inventoryDaily, ratePlans, unitTypes } from "@/lib/db/schema";
import type { TestDb } from "./test-db";

export async function idsFor(db: TestDb, unitSlug: string, rateSlug = "direct-flex") {
  const [u] = await db.select().from(unitTypes).where(eq(unitTypes.slug, unitSlug));
  const [r] = await db.select().from(ratePlans).where(eq(ratePlans.slug, rateSlug));
  return { propertyId: u.propertyId, unitTypeId: u.id, ratePlanId: r.id };
}

type Fill = Partial<typeof ariDaily.$inferInsert> & { available?: number };

/** `days` consecutive days of inventory (per room type) and rates (per room type × plan). */
export async function fillAri(db: TestDb, propertyId: string, from: string, days: number, over: Fill = {}) {
  const { available = 3, ...rate } = over;
  const plans = await db.select().from(ratePlans).where(eq(ratePlans.propertyId, propertyId));
  const types = await db.select().from(unitTypes).where(eq(unitTypes.propertyId, propertyId));
  const start = parse(from, "yyyy-MM-dd", new Date(2000, 0, 1));
  for (const u of types)
    for (let i = 0; i < days; i++) {
      const date = format(addDays(start, i), "yyyy-MM-dd");
      await db.insert(inventoryDaily).values({ propertyId, unitTypeId: u.id, date, available, source: "siteminder", syncedAt: 0 });
      for (const rp of plans)
        await db.insert(ariDaily).values({ propertyId, unitTypeId: u.id, ratePlanId: rp.id, date, price: 2000, minStay: 1, source: "siteminder", syncedAt: 0, ...rate });
    }
}

/** `available` updates the room type's inventory; other fields update the plan's rate row. */
export async function setAri(db: TestDb, unitTypeId: string, ratePlanId: string, date: string, set: Fill) {
  const { available, ...rate } = set;
  if (available !== undefined)
    await db.update(inventoryDaily).set({ available }).where(and(eq(inventoryDaily.unitTypeId, unitTypeId), eq(inventoryDaily.date, date)));
  if (Object.keys(rate).length)
    await db.update(ariDaily).set(rate).where(and(eq(ariDaily.unitTypeId, unitTypeId), eq(ariDaily.ratePlanId, ratePlanId), eq(ariDaily.date, date)));
}
