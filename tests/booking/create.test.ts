import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { createReservation, type CreateInput } from "@/lib/booking/create";
import { holdInventory, releaseInventory } from "@/lib/db/inventory-hold";
import { addons, inventoryDaily, payments, promoCodes, reservationRooms, reservations } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import { MockSinoPacGateway } from "@/lib/payments/mock-sinopac";
import { fillAri, idsFor } from "@/tests/helpers/ari";
import { createTestDb } from "@/tests/helpers/test-db";

const NOW = new Date("2026-11-24T02:00:00Z");
const BASE = "https://hotel.test";

async function setup(available = 3) {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  await fillAri(db, propertyId, "2026-12-01", 5, { available });
  const ids = await idsFor(db, "mixed-cube");
  const gateway = new MockSinoPacGateway({ secret: "s", baseUrl: BASE });
  const deps = { db, gateway, baseUrl: BASE };
  const avail = async (date: string) =>
    (await db.select().from(inventoryDaily)
      .where(and(eq(inventoryDaily.unitTypeId, ids.unitTypeId), eq(inventoryDaily.date, date))))[0].available;
  return { db, propertyId, ids, deps, avail };
}

const input = (over: Partial<CreateInput> = {}): CreateInput => ({
  propertySlug: "nk-hostel",
  checkIn: "2026-12-01",
  checkOut: "2026-12-03",
  adults: 2,
  children: 0,
  rooms: 1,
  unitTypeSlug: "mixed-cube",
  ratePlanSlug: "direct-flex",
  addons: [],
  guest: { firstName: "Mei", lastName: "Lin", email: " Mei@Example.COM ", phone: "+886912345678", country: "TW" },
  locale: "en",
  idempotencyKey: "key-0001-abcdef",
  acceptTerms: true,
  ...over,
});

test("creates a pending reservation, holds inventory and starts the charge", async () => {
  const { db, deps, avail } = await setup();
  const r = await createReservation(deps, input(), NOW);
  if (!r.ok) throw new Error(JSON.stringify(r));
  expect(r.code).toMatch(/^NK-[2-9A-HJ-NP-Z]{6}$/);
  expect(r.start.kind).toBe("redirect");
  if (r.start.kind === "redirect") {
    const u = new URL(r.start.url);
    expect(u.searchParams.get("notifyUrl")).toBe(`${BASE}/api/payments/notify`);
    expect(u.searchParams.get("returnUrl")).toBe(`${BASE}/en/book/return/${r.code}`);
    expect(u.searchParams.get("amount")).toBe("4000");
  }

  const [res] = await db.select().from(reservations).where(eq(reservations.code, r.code));
  expect(res.status).toBe("pending_payment");
  expect(res.totalAmount).toBe(4000);
  expect((res.quote as { total: number }).total).toBe(4000);
  expect(res.holdExpiresAt).toBe(NOW.getTime() + 20 * 60_000);
  expect(res.syncState).toBe("not_required");
  expect(res.guestEmailLower).toBe("mei@example.com");
  expect(res.idempotencyKey).toBe("key-0001-abcdef");

  const rooms = await db.select().from(reservationRooms).where(eq(reservationRooms.reservationId, res.id));
  expect(rooms).toHaveLength(1);
  expect(rooms[0].nightlyPrices).toEqual([2000, 2000]);

  const pays = await db.select().from(payments).where(eq(payments.reservationId, res.id));
  expect(pays).toMatchObject([{ kind: "charge", status: "pending", amount: 4000, method: "sinopac_online" }]);

  expect(await avail("2026-12-01")).toBe(2);
  expect(await avail("2026-12-02")).toBe(2);
  expect(await avail("2026-12-03")).toBe(3);
});

test("the same idempotency key returns the same reservation and holds once", async () => {
  const { db, deps, avail } = await setup();
  const a = await createReservation(deps, input(), NOW);
  const b = await createReservation(deps, input(), NOW);
  if (!a.ok || !b.ok) throw new Error(JSON.stringify([a, b]));
  expect(b.code).toBe(a.code);
  expect(await avail("2026-12-01")).toBe(2);
  expect(await db.select().from(reservations)).toHaveLength(1);
  expect(await db.select().from(payments)).toHaveLength(1);
});

test("a replay of a reservation that is no longer pending is refused", async () => {
  const { db, deps } = await setup();
  const a = await createReservation(deps, input(), NOW);
  if (!a.ok) throw new Error(JSON.stringify(a));
  await db.update(reservations).set({ status: "expired" }).where(eq(reservations.code, a.code));
  expect(await createReservation(deps, input(), NOW))
    .toEqual({ ok: false, error: "INVALID_INPUT", detail: "ALREADY_PROCESSED" });
});

test("a promo code discounts the rooms; an expired one is refused without touching inventory", async () => {
  const { db, propertyId, deps, avail } = await setup();
  await db.insert(promoCodes).values([
    { id: crypto.randomUUID(), propertyId, code: "WELCOME10", kind: "percent", value: 10, active: true },
    { id: crypto.randomUUID(), propertyId, code: "OLD", kind: "percent", value: 10, validTo: "2026-11-30", active: true },
  ]);
  const ok = await createReservation(deps, input({ promoCode: "WELCOME10" }), NOW);
  if (!ok.ok) throw new Error(JSON.stringify(ok));
  const [res] = await db.select().from(reservations).where(eq(reservations.code, ok.code));
  expect(res.totalAmount).toBe(4000 * 0.9);
  expect(res.promoCode).toBe("WELCOME10");

  const before = await avail("2026-12-01");
  expect(await createReservation(deps, input({ promoCode: "OLD", idempotencyKey: "key-0002-abcdef" }), NOW))
    .toMatchObject({ ok: false, error: "PROMO_INVALID" });
  expect(await avail("2026-12-01")).toBe(before);
});

test("inactive, used-up, not-yet-valid and unknown promo codes are refused", async () => {
  const { db, propertyId, deps } = await setup();
  await db.insert(promoCodes).values([
    { id: crypto.randomUUID(), propertyId, code: "OFF", kind: "fixed", value: 100, active: false },
    { id: crypto.randomUUID(), propertyId, code: "FULL", kind: "fixed", value: 100, maxUses: 2, usedCount: 2, active: true },
    { id: crypto.randomUUID(), propertyId, code: "LATER", kind: "fixed", value: 100, validFrom: "2026-12-02", active: true },
  ]);
  for (const [i, code] of ["OFF", "FULL", "LATER", "NOPE"].entries())
    expect(await createReservation(deps, input({ promoCode: code, idempotencyKey: `key-promo-${i}-xx` }), NOW))
      .toMatchObject({ ok: false, error: "PROMO_INVALID" });
  expect(await db.select().from(reservations)).toHaveLength(0);
});

test("add-ons are priced from the database", async () => {
  const { db, propertyId, deps } = await setup();
  await db.insert(addons).values({
    id: crypto.randomUUID(), propertyId, slug: "breakfast", name: { "zh-TW": "早餐", en: "Breakfast", ja: "Breakfast", ko: "Breakfast" },
    price: 250, unit: "per_person_night", active: true,
  });
  const r = await createReservation(deps, input({ addons: [{ slug: "breakfast", qty: 1 }] }), NOW);
  if (!r.ok) throw new Error(JSON.stringify(r));
  const [res] = await db.select().from(reservations).where(eq(reservations.code, r.code));
  expect(res.totalAmount).toBe(4000 + 250 * 2 * 2);
  expect(await createReservation(deps, input({ addons: [{ slug: "spa", qty: 1 }], idempotencyKey: "key-addon-xx-1" }), NOW))
    .toMatchObject({ ok: false, error: "INVALID_INPUT" });
});

test("more rooms than adults is invalid input", async () => {
  const { deps } = await setup();
  expect(await createReservation(deps, input({ rooms: 3, adults: 1 }), NOW)).toMatchObject({ ok: false, error: "INVALID_INPUT" });
  expect(await createReservation(deps, input({ children: 7 }), NOW)).toMatchObject({ ok: false, error: "INVALID_INPUT" });
  expect(await createReservation(deps, { ...input(), acceptTerms: false } as unknown as CreateInput, NOW))
    .toMatchObject({ ok: false, error: "INVALID_INPUT" });
});

test("an unknown room type is not available", async () => {
  const { deps } = await setup();
  expect(await createReservation(deps, input({ unitTypeSlug: "penthouse" }), NOW)).toMatchObject({ ok: false, error: "NOT_AVAILABLE" });
});

test("with one room left, the second booking fails", async () => {
  const { deps, avail } = await setup(1);
  const a = await createReservation(deps, input(), NOW);
  expect(a.ok).toBe(true);
  const b = await createReservation(deps, input({ idempotencyKey: "key-0002-abcdef" }), NOW);
  expect(b.ok).toBe(false);
  if (!b.ok) expect(["NOT_AVAILABLE", "SOLD_OUT"]).toContain(b.error);
  expect(await avail("2026-12-01")).toBe(0);
});

test("holdInventory and releaseInventory reject non-positive rooms and duplicate nights", async () => {
  const { db, ids } = await setup();
  const item = { unitTypeId: ids.unitTypeId, ratePlanId: ids.ratePlanId, nights: ["2026-12-01"], rooms: 0 };
  await expect(holdInventory(db, [item])).rejects.toThrow("INVALID_HOLD");
  await expect(holdInventory(db, [{ ...item, rooms: 1.5 }])).rejects.toThrow("INVALID_HOLD");
  await expect(holdInventory(db, [{ ...item, rooms: 1, nights: ["2026-12-01", "2026-12-01"] }])).rejects.toThrow("INVALID_HOLD");
  await expect(releaseInventory(db, [item])).rejects.toThrow("INVALID_HOLD");
  await expect(releaseInventory(db, [{ ...item, rooms: 1, nights: ["2026-12-01", "2026-12-01"] }])).rejects.toThrow("INVALID_HOLD");
});
