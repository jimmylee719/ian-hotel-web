import { eq } from "drizzle-orm";
import type { AriUpdate } from "@/lib/channel/types";
import { ariDaily, ratePlans, unitTypes } from "./schema";
import type { Db } from "./types";

const FIELDS = ["available", "price", "minStay", "closedToArrival", "closedToDeparture", "stopSell"] as const;

/** Upsert SiteMinder ARI into the local cache; only fields present in an update are overwritten. */
export async function applyAriUpdates(db: Db, propertyId: string, updates: AriUpdate[], now: Date) {
  const [types, plans] = await Promise.all([
    db.select({ id: unitTypes.id, code: unitTypes.smRoomCode }).from(unitTypes).where(eq(unitTypes.propertyId, propertyId)),
    db.select({ id: ratePlans.id, code: ratePlans.smRatePlanCode }).from(ratePlans).where(eq(ratePlans.propertyId, propertyId)),
  ]);
  const room = new Map(types.filter((t) => t.code).map((t) => [t.code!, t.id]));
  const plan = new Map(plans.filter((p) => p.code).map((p) => [p.code!, p.id]));

  const unknown = new Set<string>();
  let applied = 0;
  for (const u of updates) {
    const unitTypeId = room.get(u.smRoomCode);
    const ratePlanId = plan.get(u.smRatePlanCode);
    if (!unitTypeId) unknown.add(u.smRoomCode);
    if (!ratePlanId) unknown.add(u.smRatePlanCode);
    if (!unitTypeId || !ratePlanId) continue;

    const set: Partial<typeof ariDaily.$inferInsert> = { source: "siteminder", syncedAt: now.getTime() };
    for (const f of FIELDS) if (u[f] !== undefined) (set as Record<string, unknown>)[f] = u[f];

    await db
      .insert(ariDaily)
      .values({ propertyId, unitTypeId, ratePlanId, date: u.date, ...set, source: "siteminder", syncedAt: now.getTime() })
      .onConflictDoUpdate({ target: [ariDaily.unitTypeId, ariDaily.ratePlanId, ariDaily.date], set });
    applied++;
  }
  return { applied, unknownCodes: [...unknown] };
}

