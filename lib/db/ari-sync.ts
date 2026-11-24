import { and, eq } from "drizzle-orm";
import type { AriUpdate } from "@/lib/channel/types";
import { runAtomic } from "./atomic";
import { ariDaily, inventoryDaily, ratePlans, unitTypes } from "./schema";
import type { Db } from "./types";

const RATE_FIELDS = ["price", "minStay", "closedToArrival", "closedToDeparture", "stopSell"] as const;
/** Statements per D1 batch; a full-year push is split into several atomic chunks. */
const CHUNK = 100;

export type Rejected = { smRoomCode: string; smRatePlanCode: string; date: string; reason: "INVALID_VALUE" };

const nonNegInt = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 0);
const posInt = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) > 0);
const isValid = (u: AriUpdate) =>
  /^\d{4}-\d{2}-\d{2}$/.test(u.date) && nonNegInt(u.available) && posInt(u.price) && posInt(u.minStay);

/**
 * Apply SiteMinder ARI to the local cache. Only fields present in an update are overwritten.
 * Availability goes to the per-room-type inventory; rates/restrictions to the per-plan table.
 * A rate row is only created when a price is known, so availability alone never makes a free room.
 * Invalid rows are rejected individually; the rest are written in atomic chunks.
 */
export async function applyAriUpdates(db: Db, propertyId: string, updates: AriUpdate[], now: Date) {
  const [types, plans] = await Promise.all([
    db.select({ id: unitTypes.id, code: unitTypes.smRoomCode }).from(unitTypes).where(eq(unitTypes.propertyId, propertyId)),
    db.select({ id: ratePlans.id, code: ratePlans.smRatePlanCode }).from(ratePlans).where(eq(ratePlans.propertyId, propertyId)),
  ]);
  const room = new Map(types.filter((t) => t.code).map((t) => [t.code!, t.id]));
  const plan = new Map(plans.filter((p) => p.code).map((p) => [p.code!, p.id]));
  const stamp = { source: "siteminder" as const, syncedAt: now.getTime() };

  const unknown = new Set<string>();
  const rejected: Rejected[] = [];
  const stmts: { run: () => unknown }[] = [];
  let applied = 0;

  for (const u of updates) {
    const unitTypeId = room.get(u.smRoomCode);
    const ratePlanId = plan.get(u.smRatePlanCode);
    if (!unitTypeId) unknown.add(u.smRoomCode);
    if (!ratePlanId) unknown.add(u.smRatePlanCode);
    if (!unitTypeId || !ratePlanId) continue;
    if (!isValid(u)) {
      rejected.push({ smRoomCode: u.smRoomCode, smRatePlanCode: u.smRatePlanCode, date: u.date, reason: "INVALID_VALUE" });
      continue;
    }

    if (u.available !== undefined)
      stmts.push(db.insert(inventoryDaily)
        .values({ propertyId, unitTypeId, date: u.date, available: u.available, ...stamp })
        .onConflictDoUpdate({ target: [inventoryDaily.unitTypeId, inventoryDaily.date], set: { available: u.available, ...stamp } }));

    const set: Partial<typeof ariDaily.$inferInsert> = { ...stamp };
    for (const f of RATE_FIELDS) if (u[f] !== undefined) (set as Record<string, unknown>)[f] = u[f];
    if (u.price !== undefined)
      stmts.push(db.insert(ariDaily)
        .values({ propertyId, unitTypeId, ratePlanId, date: u.date, ...set, price: u.price, ...stamp })
        .onConflictDoUpdate({ target: [ariDaily.unitTypeId, ariDaily.ratePlanId, ariDaily.date], set }));
    else if (Object.keys(set).length > 2)
      stmts.push(db.update(ariDaily).set(set)
        .where(and(eq(ariDaily.unitTypeId, unitTypeId), eq(ariDaily.ratePlanId, ratePlanId), eq(ariDaily.date, u.date))));
    applied++;
  }

  for (let i = 0; i < stmts.length; i += CHUNK) await runAtomic(db, stmts.slice(i, i + CHUNK));
  return { applied, unknownCodes: [...unknown], rejected };
}
