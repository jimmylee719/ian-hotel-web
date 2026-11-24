import { describe, expect, test } from "vitest";
import { searchAvailability } from "@/lib/db/ari-repo";
import { seedNk } from "@/lib/db/seed-nk";
import { createTestDb } from "@/tests/helpers/test-db";
import { fillAri, idsFor, setAri } from "@/tests/helpers/ari";

async function setup() {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  await fillAri(db, propertyId, "2026-12-01", 5);
  return { db, propertyId };
}

describe("searchAvailability", () => {
  test("checkout not after checkin is a validation error, not an empty result", async () => {
    const { db, propertyId } = await setup();
    expect(await searchAvailability(db, { propertyId, checkIn: "2026-12-02", checkOut: "2026-12-02", adults: 2 }))
      .toEqual({ ok: false, error: "CHECKOUT_NOT_AFTER_CHECKIN" });
  });
  test("five adults only fit the room for six", async () => {
    const { db, propertyId } = await setup();
    const r = await searchAvailability(db, { propertyId, checkIn: "2026-12-01", checkOut: "2026-12-03", adults: 5 });
    expect(r.ok && r.offers.map((o) => o.unitType.slug)).toEqual(["buddy-room-six"]);
  });
  test("offers come back in room-type display order", async () => {
    const { db, propertyId } = await setup();
    const r = await searchAvailability(db, { propertyId, checkIn: "2026-12-01", checkOut: "2026-12-03", adults: 2 });
    expect(r.ok && r.offers.map((o) => o.unitType.slug)).toEqual([
      "mixed-cube", "female-cube", "buddy-room", "buddy-room-six", "mini-room", "classic-room", "deluxe-room", "connecting-room",
    ]);
    expect(r.ok && r.offers[0].roomSubtotal).toBe(4000);
  });
  test("a sold-out night removes that room type", async () => {
    const { db, propertyId } = await setup();
    const { unitTypeId, ratePlanId } = await idsFor(db, "mixed-cube");
    await setAri(db, unitTypeId, ratePlanId, "2026-12-02", { available: 0 });
    const r = await searchAvailability(db, { propertyId, checkIn: "2026-12-01", checkOut: "2026-12-03", adults: 2 });
    expect(r.ok && r.offers.some((o) => o.unitType.slug === "mixed-cube")).toBe(false);
  });
  test("dates with no ARI rows yield no offers", async () => {
    const { db, propertyId } = await setup();
    const r = await searchAvailability(db, { propertyId, checkIn: "2027-03-01", checkOut: "2027-03-02", adults: 2 });
    expect(r).toEqual({ ok: true, offers: [] });
  });
});
