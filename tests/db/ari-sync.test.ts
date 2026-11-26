import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { applyAriUpdates } from "@/lib/db/ari-sync";
import { ariDaily, inventoryDaily, ratePlans, unitTypes } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import { createTestDb } from "@/tests/helpers/test-db";

async function setup() {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  await db.update(unitTypes).set({ smRoomCode: "MIX" }).where(eq(unitTypes.slug, "mixed-cube"));
  await db.update(ratePlans).set({ smRatePlanCode: "DIRECT" }).where(eq(ratePlans.slug, "direct-flex"));
  return { db, propertyId };
}

test("known codes are applied as SiteMinder rows; unknown codes are reported", async () => {
  const { db, propertyId } = await setup();
  const now = new Date("2026-11-24T00:00:00Z");
  const r = await applyAriUpdates(db, propertyId, [
    { smRoomCode: "MIX", smRatePlanCode: "DIRECT", date: "2026-12-01", available: 4, price: 2100 },
    { smRoomCode: "MIX", smRatePlanCode: "DIRECT", date: "2026-12-02", available: 2, price: 2300 },
    { smRoomCode: "XX", smRatePlanCode: "DIRECT", date: "2026-12-01", available: 1 },
  ], now);
  expect(r).toEqual({ applied: 2, unknownCodes: ["XX"], rejected: [] });
  const rows = await db.select().from(ariDaily);
  expect(rows).toHaveLength(2);
  expect(rows.every((x) => x.source === "siteminder" && x.syncedAt === now.getTime())).toBe(true);
  expect((await db.select().from(inventoryDaily)).map((x) => x.available).sort()).toEqual([2, 4]);
});

test("a price-only update keeps the existing availability", async () => {
  const { db, propertyId } = await setup();
  await applyAriUpdates(db, propertyId, [{ smRoomCode: "MIX", smRatePlanCode: "DIRECT", date: "2026-12-01", available: 4, price: 2100 }], new Date());
  await applyAriUpdates(db, propertyId, [{ smRoomCode: "MIX", smRatePlanCode: "DIRECT", date: "2026-12-01", price: 2500 }], new Date());
  expect((await db.select().from(ariDaily))[0].price).toBe(2500);
  expect((await db.select().from(inventoryDaily))[0].available).toBe(4);
});

test("availability needs no rate plan; restrictions without a price make an unsellable (price 0) row; older updates are ignored", async () => {
  const { db, propertyId } = await setup();
  const r = await applyAriUpdates(db, propertyId, [
    { smRoomCode: "MIX", date: "2026-12-01", available: 4 },
    { smRoomCode: "MIX", smRatePlanCode: "DIRECT", date: "2026-12-01", stopSell: true, maxStay: 3 },
    { smRoomCode: "MIX", date: "2026-12-02", stopSell: true },
  ], new Date(), { sourceTs: 2000 });
  expect(r).toEqual({ applied: 2, unknownCodes: [], rejected: [{ smRoomCode: "MIX", date: "2026-12-02", reason: "NO_RATE_PLAN" }] });
  expect((await db.select().from(inventoryDaily))[0]).toMatchObject({ available: 4, sourceTs: 2000 });
  expect((await db.select().from(ariDaily))[0]).toMatchObject({ price: 0, stopSell: true, maxStay: 3, restrictionsSourceTs: 2000 });
  await applyAriUpdates(db, propertyId, [
    { smRoomCode: "MIX", date: "2026-12-01", available: 9 },
    { smRoomCode: "MIX", smRatePlanCode: "DIRECT", date: "2026-12-01", stopSell: false, price: 1500 },
  ], new Date(), { sourceTs: 1000 });
  expect((await db.select().from(inventoryDaily))[0].available).toBe(4);
  expect((await db.select().from(ariDaily))[0]).toMatchObject({ stopSell: true, price: 1500, priceSourceTs: 1000 });
});
