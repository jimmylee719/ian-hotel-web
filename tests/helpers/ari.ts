import { addDays, format, parse } from "date-fns";
import { and, eq } from "drizzle-orm";
import { ariDaily, ratePlans, unitTypes } from "@/lib/db/schema";
import type { TestDb } from "./test-db";

export async function idsFor(db: TestDb, unitSlug: string, rateSlug = "direct-flex") {
  const [u] = await db.select().from(unitTypes).where(eq(unitTypes.slug, unitSlug));
  const [r] = await db.select().from(ratePlans).where(eq(ratePlans.slug, rateSlug));
  return { propertyId: u.propertyId, unitTypeId: u.id, ratePlanId: r.id };
}

/** Insert `days` consecutive ARI rows for every room type of the property. */
export async function fillAri(db: TestDb, propertyId: string, from: string, days: number, over: Partial<typeof ariDaily.$inferInsert> = {}) {
  const [rp] = await db.select().from(ratePlans).where(eq(ratePlans.propertyId, propertyId));
  const types = await db.select().from(unitTypes).where(eq(unitTypes.propertyId, propertyId));
  const start = parse(from, "yyyy-MM-dd", new Date(2000, 0, 1));
  for (const u of types)
    for (let i = 0; i < days; i++)
      await db.insert(ariDaily).values({
        propertyId, unitTypeId: u.id, ratePlanId: rp.id,
        date: format(addDays(start, i), "yyyy-MM-dd"),
        available: 3, price: 2000, minStay: 1, source: "siteminder", syncedAt: 0, ...over,
      });
}

export async function setAri(db: TestDb, unitTypeId: string, ratePlanId: string, date: string, set: Partial<typeof ariDaily.$inferInsert>) {
  await db.update(ariDaily).set(set).where(and(eq(ariDaily.unitTypeId, unitTypeId), eq(ariDaily.ratePlanId, ratePlanId), eq(ariDaily.date, date)));
}
