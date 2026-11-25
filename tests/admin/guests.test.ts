import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getGuest, listGuests } from "@/lib/admin/guests";
import { guests, payments, properties, ratePlans, reservationRooms, reservations, unitTypes } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import type { Db } from "@/lib/db/types";
import { createTestDb } from "../helpers/test-db";

async function setup() {
  const tdb = createTestDb();
  const db = tdb as unknown as Db;
  const { propertyId } = await seedNk(tdb);
  const [{ id: unitTypeId }] = await db.select({ id: unitTypes.id }).from(unitTypes).where(eq(unitTypes.slug, "mixed-cube"));
  const [{ id: ratePlanId }] = await db.select({ id: ratePlans.id }).from(ratePlans).limit(1);
  await db.insert(properties).values({
    id: "prop-other", slug: "other", type: "hotel", name: { "zh-TW": "他館", en: "O", ja: "O", ko: "O" },
    timezone: "Asia/Taipei", currency: "TWD", address: { "zh-TW": "a", en: "a", ja: "a", ko: "a" }, phone: "1", email: "o@x.com", createdAt: 0,
  });
  const guest = (id: string, first: string, last: string, email: string, pid = propertyId, phone = "0912") =>
    db.insert(guests).values({ id, propertyId: pid, firstName: first, lastName: last, email, phone, country: "TW", locale: "en", createdAt: 0 });
  let n = 0;
  const res = async (id: string, guestId: string, o: Partial<typeof reservations.$inferInsert> = {}, pid = propertyId) => {
    n++;
    await db.insert(reservations).values({
      id, propertyId: pid, code: `C-${id}`, guestId, status: "confirmed", channel: "direct", checkIn: `2026-12-0${n}`, checkOut: `2026-12-0${n + 1}`,
      adults: 2, children: 0, locale: "en", quote: {}, totalAmount: 4000, syncState: "synced", guestEmailLower: "x", createdAt: n, updatedAt: n, ...o,
    });
    await db.insert(reservationRooms).values({ id: `${id}-r`, reservationId: id, unitTypeId, ratePlanId, nightlyPrices: [2000] });
  };
  const pay = (id: string, reservationId: string, kind: "charge" | "refund", amount: number) =>
    db.insert(payments).values({ id, reservationId, kind, method: "edc", amount, status: "succeeded", createdAt: 1 });
  return { db, propertyId, guest, res, pay };
}

describe("listGuests", () => {
  it("searches name, email and phone case-insensitively, within the property", async () => {
    const { db, propertyId, guest } = await setup();
    await guest("g1", "Amy", "Chen", "Amy.Chen@Example.com", propertyId, "0933-111");
    await guest("g2", "Bob", "Lin", "bob@x.com");
    await guest("g3", "Amy", "Chen", "amy@other.com", "prop-other");
    const ids = async (q?: string) => (await listGuests(db, propertyId, { q, page: 1, pageSize: 20 })).rows.map((r) => r.id).sort();
    expect(await ids()).toEqual(["g1", "g2"]);
    expect(await ids("chen")).toEqual(["g1"]);
    expect(await ids("AMY.CHEN@")).toEqual(["g1"]);
    expect(await ids("0933")).toEqual(["g1"]);
    expect(await ids("amy chen")).toEqual(["g1"]);
    expect(await ids("%")).toEqual([]);
  });

  it("counts stays and sums net spend", async () => {
    const { db, propertyId, guest, res, pay } = await setup();
    await guest("g1", "Amy", "Chen", "a@x.com");
    await res("r1", "g1");
    await res("r2", "g1");
    await res("r3", "g1", { status: "cancelled" });
    await pay("p1", "r1", "charge", 4000);
    await pay("p2", "r2", "charge", 3000);
    await pay("p3", "r3", "charge", 1000);
    await pay("p4", "r3", "refund", 1000);
    const [row] = (await listGuests(db, propertyId, { page: 1, pageSize: 20 })).rows;
    expect(row).toMatchObject({ id: "g1", name: "Amy Chen", email: "a@x.com", reservationCount: 3, stays: 2, totalSpent: 7000 });
  });
});

describe("getGuest", () => {
  it("returns the history with money, and null for another property", async () => {
    const { db, propertyId, guest, res, pay } = await setup();
    await guest("g1", "Amy", "Chen", "a@x.com");
    await guest("g9", "Zed", "Q", "z@x.com", "prop-other");
    await res("r1", "g1");
    await res("r2", "g1", { status: "cancelled" });
    await pay("p1", "r1", "charge", 4000);
    const g = (await getGuest(db, propertyId, "g1"))!;
    expect(g).toMatchObject({ id: "g1", name: "Amy Chen", email: "a@x.com", phone: "0912", country: "TW", stays: 1, totalSpent: 4000 });
    expect(g.reservations.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(g.reservations.find((r) => r.id === "r1")).toMatchObject({ code: "C-r1", paid: 4000, balanceDue: 0, roomName: "男.女混合雙人旅艙" });
    expect(await getGuest(db, propertyId, "g9")).toBeNull();
    expect(await getGuest(db, propertyId, "nope")).toBeNull();
  });
});
