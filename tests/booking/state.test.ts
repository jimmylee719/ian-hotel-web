import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { canTransition, transition } from "@/lib/booking/state";
import { guests, reservations } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import { createTestDb } from "@/tests/helpers/test-db";

test("allowed and forbidden transitions", () => {
  expect(canTransition("confirmed", "pending_payment")).toBe(false);
  expect(canTransition("pending_payment", "paid_pending_confirm")).toBe(true);
  expect(canTransition("pending_payment", "expired")).toBe(true);
  expect(canTransition("expired", "paid_pending_confirm")).toBe(true);
  expect(canTransition("expired", "confirm_failed_refunded")).toBe(true);
  expect(canTransition("paid_pending_confirm", "confirmed")).toBe(true);
  expect(canTransition("paid_pending_confirm", "confirm_failed_refunded")).toBe(true);
  expect(canTransition("confirmed", "cancelled")).toBe(true);
  expect(canTransition("pending_payment", "confirmed")).toBe(false);
  expect(canTransition("cancelled", "confirmed")).toBe(false);
});

async function setupReservation() {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  const guestId = crypto.randomUUID();
  await db.insert(guests).values({
    id: guestId, propertyId, firstName: "A", lastName: "B", email: "a@b.test", phone: "1", country: "TW", locale: "en", createdAt: 0,
  });
  const id = crypto.randomUUID();
  await db.insert(reservations).values({
    id, propertyId, code: "NK-ABCDEF", guestId, status: "pending_payment", channel: "direct",
    checkIn: "2026-12-01", checkOut: "2026-12-02", adults: 1, locale: "en", quote: {}, totalAmount: 2000,
    syncState: "not_required", guestEmailLower: "a@b.test", createdAt: 0, updatedAt: 0,
  });
  return { db, id };
}

test("only one of two concurrent transitions from the same state wins", async () => {
  const { db, id } = await setupReservation();
  const now = new Date("2026-11-24T02:00:00Z");
  const results = await Promise.all([
    transition(db, id, "pending_payment", "paid_pending_confirm", {}, now),
    transition(db, id, "pending_payment", "paid_pending_confirm", {}, now),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const [r] = await db.select().from(reservations).where(eq(reservations.id, id));
  expect(r.status).toBe("paid_pending_confirm");
  expect(r.updatedAt).toBe(now.getTime());
});

test("a disallowed transition is refused without touching the row", async () => {
  const { db, id } = await setupReservation();
  expect(await transition(db, id, "pending_payment", "confirmed", {}, new Date())).toBe(false);
  const [r] = await db.select().from(reservations).where(eq(reservations.id, id));
  expect(r.status).toBe("pending_payment");
});

test("the patch is applied with the transition", async () => {
  const { db, id } = await setupReservation();
  expect(await transition(db, id, "pending_payment", "expired", { holdExpiresAt: null }, new Date(5))).toBe(true);
  const [r] = await db.select().from(reservations).where(eq(reservations.id, id));
  expect(r.status).toBe("expired");
  expect(r.holdExpiresAt).toBeNull();
});
