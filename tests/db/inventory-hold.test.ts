import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { holdInventory, releaseInventory } from "@/lib/db/inventory-hold";
import { inventoryDaily } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import { createTestDb } from "@/tests/helpers/test-db";
import { fillAri, idsFor, setAri } from "@/tests/helpers/ari";

async function setup(available: number) {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  await fillAri(db, propertyId, "2026-12-01", 3, { available });
  const ids = await idsFor(db, "mixed-cube");
  const avail = async (date: string) =>
    (await db.select().from(inventoryDaily).where(and(eq(inventoryDaily.unitTypeId, ids.unitTypeId), eq(inventoryDaily.date, date))))[0].available;
  return { db, ids, avail };
}

test("only one of two holds on the last room succeeds", async () => {
  const { db, ids, avail } = await setup(1);
  const item = [{ unitTypeId: ids.unitTypeId, ratePlanId: ids.ratePlanId, nights: ["2026-12-01"], rooms: 1 }];
  expect(await holdInventory(db, item)).toEqual({ ok: true });
  expect(await holdInventory(db, item)).toEqual({ ok: false, error: "SOLD_OUT" });
  expect(await avail("2026-12-01")).toBe(0);
});

test("a sold-out second night rolls back the first night", async () => {
  const { db, ids, avail } = await setup(2);
  await setAri(db, ids.unitTypeId, ids.ratePlanId, "2026-12-02", { available: 0 });
  const r = await holdInventory(db, [{ unitTypeId: ids.unitTypeId, ratePlanId: ids.ratePlanId, nights: ["2026-12-01", "2026-12-02"], rooms: 1 }]);
  expect(r).toEqual({ ok: false, error: "SOLD_OUT" });
  expect(await avail("2026-12-01")).toBe(2);
});

test("a night with no ARI row cannot be held", async () => {
  const { db, ids, avail } = await setup(2);
  const r = await holdInventory(db, [{ unitTypeId: ids.unitTypeId, ratePlanId: ids.ratePlanId, nights: ["2026-12-03", "2026-12-04"], rooms: 1 }]);
  expect(r).toEqual({ ok: false, error: "SOLD_OUT" });
  expect(await avail("2026-12-03")).toBe(2);
});

test("a stop-sell night cannot be held", async () => {
  const { db, ids } = await setup(2);
  await setAri(db, ids.unitTypeId, ids.ratePlanId, "2026-12-01", { stopSell: true });
  expect(await holdInventory(db, [{ unitTypeId: ids.unitTypeId, ratePlanId: ids.ratePlanId, nights: ["2026-12-01"], rooms: 1 }]))
    .toEqual({ ok: false, error: "SOLD_OUT" });
});

test("release gives the rooms back", async () => {
  const { db, ids, avail } = await setup(2);
  const item = [{ unitTypeId: ids.unitTypeId, ratePlanId: ids.ratePlanId, nights: ["2026-12-01"], rooms: 2 }];
  await holdInventory(db, item);
  await releaseInventory(db, item);
  expect(await avail("2026-12-01")).toBe(2);
});
