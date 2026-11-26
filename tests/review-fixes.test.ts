import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { applyAriUpdates } from "@/lib/db/ari-sync";
import { searchAvailability } from "@/lib/db/ari-repo";
import { holdInventory } from "@/lib/db/inventory-hold";
import { ratePlans, unitTypes } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import { evaluateOffer, type AriNight } from "@/lib/domain/availability";
import { createTestDb } from "@/tests/helpers/test-db";
import { fillAri, idsFor } from "@/tests/helpers/ari";

const n = (date: string, o: Partial<AriNight> = {}): AriNight => ({ date, available: 3, price: 2000, minStay: 1, closedToArrival: false, closedToDeparture: false, stopSell: false, ...o });

test("[review#1] a night priced 0 is not sellable", () => {
  expect(evaluateOffer({ unitTypeId: "u", ratePlanId: "r" }, ["2026-12-01"], "2026-12-02", [n("2026-12-01", { price: 0 })], 1)).toBeNull();
});

test("[review#1] availability-only SiteMinder update for a new date does not create a free offer", async () => {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  await db.update(unitTypes).set({ smRoomCode: "MIX" }).where(eq(unitTypes.slug, "mixed-cube"));
  await db.update(ratePlans).set({ smRatePlanCode: "DIRECT" }).where(eq(ratePlans.slug, "direct-flex"));
  await applyAriUpdates(db, propertyId, [{ smRoomCode: "MIX", smRatePlanCode: "DIRECT", date: "2026-12-01", available: 4 }], new Date());
  const r = await searchAvailability(db, { propertyId, checkIn: "2026-12-01", checkOut: "2026-12-02", adults: 2, today: "2026-11-24" });
  expect(r).toEqual({ ok: true, offers: [] });
});

test("[review#2] two rate plans share one room type's inventory", async () => {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  const [flex] = await db.select().from(ratePlans);
  await db.insert(ratePlans).values({ ...flex, id: "plan-b", slug: "direct-breakfast", smRatePlanCode: "DIRECTBREAKFAST" });
  await fillAri(db, propertyId, "2026-12-01", 1, { available: 1 });
  const a = await idsFor(db, "mixed-cube", "direct-flex");
  const b = await idsFor(db, "mixed-cube", "direct-breakfast");
  const nights = ["2026-12-01"];
  expect(await holdInventory(db, [{ ...a, nights, rooms: 1 }])).toEqual({ ok: true });
  expect(await holdInventory(db, [{ ...b, nights, rooms: 1 }])).toEqual({ ok: false, error: "SOLD_OUT" });
});

test("[review#3] one invalid SiteMinder row is rejected without aborting the rest", async () => {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  await db.update(unitTypes).set({ smRoomCode: "MIX" }).where(eq(unitTypes.slug, "mixed-cube"));
  await db.update(ratePlans).set({ smRatePlanCode: "DIRECT" }).where(eq(ratePlans.slug, "direct-flex"));
  const r = await applyAriUpdates(db, propertyId, [
    { smRoomCode: "MIX", smRatePlanCode: "DIRECT", date: "2026-12-01", available: -1, price: 2000 },
    { smRoomCode: "MIX", smRatePlanCode: "DIRECT", date: "2026-12-02", available: 2, price: 2000 },
  ], new Date());
  expect(r).toMatchObject({ applied: 1, rejected: [{ date: "2026-12-01", reason: "INVALID_VALUE" }] });
});

test("[review#4] a check-in date in the past is rejected", async () => {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  await fillAri(db, propertyId, "2026-11-20", 5);
  expect(await searchAvailability(db, { propertyId, checkIn: "2026-11-21", checkOut: "2026-11-22", adults: 2, today: "2026-11-24" }))
    .toEqual({ ok: false, error: "CHECKIN_IN_PAST" });
});
