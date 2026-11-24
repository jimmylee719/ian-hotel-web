import { describe, expect, test } from "vitest";
import { createTestDb, rawSqlite } from "@/tests/helpers/test-db";
import { seedNk } from "@/lib/db/seed-nk";
import { guests, notifications, payments, properties, reservations } from "@/lib/db/schema";

async function setup() {
  const db = createTestDb();
  await seedNk(db);
  const [property] = await db.select().from(properties);
  await db.insert(guests).values({
    id: "g1", propertyId: property.id, firstName: "A", lastName: "B", email: "A@Example.com",
    phone: "0900", country: "TW", locale: "zh-TW", createdAt: 1,
  });
  const base = {
    propertyId: property.id, guestId: "g1", status: "pending_payment" as const, channel: "direct" as const,
    checkIn: "2026-12-01", checkOut: "2026-12-02", adults: 2, locale: "zh-TW", quote: {}, totalAmount: 1000,
    syncState: "pending" as const, guestEmailLower: "a@example.com", createdAt: 1, updatedAt: 1,
  };
  return { db, base };
}

describe("plan 2 schema additions", () => {
  test("idempotencyKey is unique", async () => {
    const { db, base } = await setup();
    await db.insert(reservations).values({ ...base, id: "r1", code: "C1", idempotencyKey: "k" });
    await expect(
      db.insert(reservations).values({ ...base, id: "r2", code: "C2", idempotencyKey: "k" }),
    ).rejects.toThrow(/UNIQUE/i);
  });

  test("status accepts expired and lifecycle defaults apply", async () => {
    const { db, base } = await setup();
    await db.insert(reservations).values({ ...base, id: "r1", code: "C1", idempotencyKey: "k1", status: "expired" });
    const [row] = await db.select().from(reservations);
    expect(row.status).toBe("expired");
    expect(row.syncAttempts).toBe(0);
    expect(row.refundedAmount).toBe(0);
    expect(row.holdExpiresAt).toBeNull();
    expect(row.nextSyncAt).toBeNull();
  });

  test("notifications are unique per (reservationId, kind, to)", async () => {
    const { db, base } = await setup();
    await db.insert(reservations).values({ ...base, id: "r1", code: "C1", idempotencyKey: "k1" });
    const n = { reservationId: "r1", kind: "booking_confirmed" as const, to: "a@example.com", status: "sent" as const, at: 1 };
    await db.insert(notifications).values({ ...n, id: "n1" });
    await expect(db.insert(notifications).values({ ...n, id: "n2" })).rejects.toThrow(/UNIQUE/i);
    await db.insert(notifications).values({ ...n, id: "n3", kind: "cancelled" });
  });

  test("payments allow multiple null providerRef but reject duplicate non-null", async () => {
    const { db, base } = await setup();
    await db.insert(reservations).values({ ...base, id: "r1", code: "C1", idempotencyKey: "k1" });
    const p = { reservationId: "r1", kind: "charge" as const, method: "sinopac_online" as const, amount: 1, status: "pending" as const, createdAt: 1 };
    await db.insert(payments).values({ ...p, id: "p1" });
    await db.insert(payments).values({ ...p, id: "p2" });
    await db.insert(payments).values({ ...p, id: "p3", providerRef: "ref" });
    await expect(db.insert(payments).values({ ...p, id: "p4", providerRef: "ref" })).rejects.toThrow(/UNIQUE/i);
  });

  test("paymentEvents table stores callbacks", async () => {
    const { db } = await setup();
    rawSqlite(db)
      .prepare("INSERT INTO payment_events (id, provider, raw_body, verdict, at) VALUES ('e1','sinopac','{}','accepted',1)")
      .run();
    expect(rawSqlite(db).prepare("SELECT count(*) c FROM payment_events").get()).toEqual({ c: 1 });
  });
});
