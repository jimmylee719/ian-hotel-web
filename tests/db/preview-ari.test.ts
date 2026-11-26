import { expect, test } from "vitest";
import { ariDaily, inventoryDaily, unitTypes } from "@/lib/db/schema";
import { previewAriSql } from "@/lib/db/preview-ari";
import { seedNk } from "@/lib/db/seed-nk";
import { searchAvailability } from "@/lib/db/ari-repo";
import { createTestDb, rawSqlite } from "@/tests/helpers/test-db";

test("the preview ARI SQL fills every active room type for each night with seed-local's prices, idempotently", async () => {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  const lines = previewAriSql("2026-11-26", 181, 1_700_000_000_000);
  expect(lines).toHaveLength(362);
  const run = () => rawSqlite(db).exec(lines.join("\n"));
  run();
  const types = await db.select().from(unitTypes);
  const inv = await db.select().from(inventoryDaily);
  const ari = await db.select().from(ariDaily);
  expect(inv).toHaveLength(types.length * 181);
  expect(ari).toHaveLength(types.length * 181);
  expect(new Set(inv.map((r) => r.date)).size).toBe(181);
  expect(inv.every((r) => r.available === 3 && r.propertyId === propertyId)).toBe(true);
  const first = types.find((t) => t.sortOrder === 0)!;
  const price = (date: string) => ari.find((r) => r.unitTypeId === first.id && r.date === date)!.price;
  expect(price("2026-11-26")).toBe(2000); // Thursday
  expect(price("2026-11-27")).toBe(2400); // Friday night +400
  expect(price("2026-11-28")).toBe(2400); // Saturday night +400
  expect(price("2026-11-29")).toBe(2000); // Sunday
  expect(Math.max(...ari.map((r) => r.price))).toBe(2000 + 7 * 150 + 400);
  expect(ari.every((r) => r.minStay === 1 && !r.stopSell && !r.closedToArrival && !r.closedToDeparture)).toBe(true);

  // A re-run adds nothing and never resets a night a hold has taken a room from.
  rawSqlite(db).exec(`UPDATE inventory_daily SET available = 1 WHERE date = '2026-11-26'`);
  run();
  expect(await db.select().from(inventoryDaily)).toHaveLength(inv.length);
  expect((await db.select().from(inventoryDaily)).filter((r) => r.date === "2026-11-26").every((r) => r.available === 1)).toBe(true);

  // With it, search finds rooms.
  const found = await searchAvailability(db, { propertyId, checkIn: "2026-12-01", checkOut: "2026-12-03", adults: 2, children: 0, rooms: 1, today: "2026-11-26" });
  expect(found.ok && found.offers.length).toBeGreaterThan(0);
});

test("rejects malformed input instead of writing SQL with it", () => {
  expect(() => previewAriSql("2026-11-26'; DROP TABLE x; --", 1, 1)).toThrow();
  expect(() => previewAriSql("2026-11-26", 0, 1)).toThrow();
  expect(() => previewAriSql("2026-11-26", 1, Number.NaN)).toThrow();
});
