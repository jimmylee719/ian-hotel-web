import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { applyAriUpdates } from "@/lib/db/ari-sync";
import { ariDaily, ratePlans, unitTypes } from "@/lib/db/schema";
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
  expect(r).toEqual({ applied: 2, unknownCodes: ["XX"] });
  const rows = await db.select().from(ariDaily);
  expect(rows).toHaveLength(2);
  expect(rows.every((x) => x.source === "siteminder" && x.syncedAt === now.getTime())).toBe(true);
});

test("a price-only update keeps the existing availability", async () => {
  const { db, propertyId } = await setup();
  await applyAriUpdates(db, propertyId, [{ smRoomCode: "MIX", smRatePlanCode: "DIRECT", date: "2026-12-01", available: 4, price: 2100 }], new Date());
  await applyAriUpdates(db, propertyId, [{ smRoomCode: "MIX", smRatePlanCode: "DIRECT", date: "2026-12-01", price: 2500 }], new Date());
  const [row] = await db.select().from(ariDaily);
  expect(row).toMatchObject({ available: 4, price: 2500 });
});
