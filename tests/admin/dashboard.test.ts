import { describe, expect, it } from "vitest";
import { alertHref, getDashboard } from "@/lib/admin/dashboard";
import { guests, notifications, paymentEvents, payments, properties, ratePlans, reservationRooms, reservations, unitTypes } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import type { Db } from "@/lib/db/types";
import { createTestDb } from "../helpers/test-db";

const NOW = new Date("2026-11-24T02:00:00Z"); // 2026-11-24 10:00 in Taipei
const min = (n: number) => NOW.getTime() - n * 60_000;
const day = (n: number) => NOW.getTime() - n * 86_400_000;

async function setup() {
  const tdb = createTestDb();
  const db = tdb as unknown as Db;
  const { propertyId } = await seedNk(tdb);
  const [{ id: unitTypeId }] = await db.select({ id: unitTypes.id }).from(unitTypes).limit(1);
  const [{ id: ratePlanId }] = await db.select({ id: ratePlans.id }).from(ratePlans).limit(1);
  const otherId = "prop-other";
  await db.insert(properties).values({
    id: otherId, slug: "other", type: "hotel", name: { "zh-TW": "他館", en: "Other", ja: "Other", ko: "Other" },
    timezone: "Asia/Taipei", currency: "TWD", address: { "zh-TW": "a", en: "a", ja: "a", ko: "a" }, phone: "1", email: "o@x.com", createdAt: 0,
  });

  let n = 0;
  const guestFor = async (pid: string) => {
    const id = `g${++n}`;
    await db.insert(guests).values({ id, propertyId: pid, firstName: "Mei", lastName: `L${n}`, email: `g${n}@x.com`, phone: "1", country: "TW", locale: "en", createdAt: 0 });
    return id;
  };
  const res = async (
    id: string, checkIn: string, checkOut: string,
    over: Partial<typeof reservations.$inferInsert> = {}, rooms = 1, pid = propertyId,
  ) => {
    await db.insert(reservations).values({
      id, propertyId: pid, code: `C-${id}`, guestId: await guestFor(pid), status: "confirmed", channel: "direct",
      checkIn, checkOut, adults: 2, children: 0, locale: "en", quote: {}, totalAmount: 4000, syncState: "synced",
      guestEmailLower: `${id}@x.com`, createdAt: 0, updatedAt: NOW.getTime(), ...over,
    });
    for (let i = 0; i < rooms; i++) await db.insert(reservationRooms).values({ id: `${id}-r${i}`, reservationId: id, unitTypeId, ratePlanId, nightlyPrices: [2000] });
  };
  const pay = (id: string, reservationId: string, kind: "charge" | "refund" | "front_desk", amount: number, createdAt: number, status: "succeeded" | "pending" | "failed" = "succeeded") =>
    db.insert(payments).values({ id, reservationId, kind, method: "edc", amount, status, createdAt });
  return { db, propertyId, otherId, res, pay };
}

describe("getDashboard", () => {
  it("lists today's arrivals, departures and in-house guests (confirmed only, Taipei dates)", async () => {
    const { db, propertyId, res } = await setup();
    await res("arr", "2026-11-24", "2026-11-26");
    await res("dep", "2026-11-22", "2026-11-24");
    await res("inh", "2026-11-23", "2026-11-26");
    await res("future", "2026-12-10", "2026-12-12");
    await res("unpaid", "2026-11-24", "2026-11-25", { status: "pending_payment" });
    await res("cancelled", "2026-11-24", "2026-11-25", { status: "cancelled" });
    const d = await getDashboard(db, propertyId, NOW);
    expect(d.arrivalsToday.map((r) => r.id)).toEqual(["arr"]);
    expect(d.departuresToday.map((r) => r.id)).toEqual(["dep"]);
    expect(d.inHouse.map((r) => r.id)).toEqual(["inh"]);
    expect(d.arrivalsToday[0]).toMatchObject({ code: "C-arr", guestName: "Mei L1", checkIn: "2026-11-24", checkOut: "2026-11-26", totalAmount: 4000 });
    expect(d.pendingPayment).toBe(1);
  });

  it("uses the Taipei date even when UTC is still the previous day", async () => {
    const { db, propertyId, res } = await setup();
    await res("arr", "2026-11-24", "2026-11-25");
    const lateUtc = new Date("2026-11-23T20:00:00Z"); // 11-24 04:00 Taipei
    expect((await getDashboard(db, propertyId, lateUtc)).arrivalsToday.map((r) => r.id)).toEqual(["arr"]);
  });

  it("raises one alert per problem, with links, severity order, and 7-day windows", async () => {
    const { db, propertyId, res, pay } = await setup();
    await res("arr", "2026-11-24", "2026-11-26");
    await res("dep", "2026-11-22", "2026-11-24");
    await res("failed", "2026-12-10", "2026-12-12", { syncState: "failed", lastSyncError: "SM 500" });
    await res("stale", "2026-12-10", "2026-12-12", { syncState: "pending", nextSyncAt: min(20) });
    await res("fresh", "2026-12-10", "2026-12-12", { syncState: "pending", nextSyncAt: min(5) });
    await res("stray", "2026-12-10", "2026-12-12", { lastSyncError: "STRAY_REFUND_FAILED: gateway down" });
    await pay("rf-old", "arr", "refund", 500, min(11), "pending");
    await pay("rf-new", "dep", "refund", 500, min(5), "pending");
    await db.insert(notifications).values({ id: "n1", propertyId, reservationId: "arr", kind: "booking_confirmed", to: "a@x.com", status: "failed", at: min(30) });
    await db.insert(notifications).values({ id: "n2", propertyId, reservationId: "arr", kind: "cancelled", to: "a@x.com", status: "sent", at: min(30) });
    const ev = (id: string, verdict: "amount_mismatch" | "stray_charge" | "accepted", at: number, code: string | null) =>
      db.insert(paymentEvents).values({ id, propertyId, provider: "sinopac", providerRef: id, reservationCode: code, rawBody: "{}", verdict, at });
    await ev("e1", "amount_mismatch", min(60), "C-arr");
    await ev("e2", "stray_charge", min(90), null);
    await ev("e3", "stray_charge", day(8), null);
    await ev("e4", "accepted", min(60), "C-arr");

    const { alerts } = await getDashboard(db, propertyId, NOW);
    const kinds = alerts.map((a) => a.kind);
    expect([...kinds].sort()).toEqual(["email_failed", "payment_alert", "payment_alert", "refund_pending", "stray_refund_failed", "sync_failed", "sync_pending_stale"]);

    const ordered = alerts;
    const order = ["stray_refund_failed", "payment_alert", "refund_pending", "sync_failed", "sync_pending_stale", "email_failed"];
    const idx = ordered.map((a) => order.indexOf(a.kind));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));

    const by = (k: string) => ordered.filter((a) => a.kind === k);
    expect(by("sync_failed")[0]).toMatchObject({ reservationId: "failed" });
    expect(by("sync_pending_stale")[0]).toMatchObject({ reservationId: "stale" });
    expect(by("refund_pending")[0]).toMatchObject({ reservationId: "arr" });
    expect(by("stray_refund_failed")[0]).toMatchObject({ reservationId: "stray" });
    expect(by("email_failed")[0]).toMatchObject({ reservationId: "arr" });
    const pa = by("payment_alert");
    expect(pa.find((a) => a.code === "C-arr")?.reservationId).toBe("arr"); // resolved from the reservation code
    expect(pa.find((a) => a.code === undefined)?.reservationId).toBeUndefined();
    expect(by("refund_pending")[0].since).toBe(min(11));
    expect(alertHref(by("sync_failed")[0])).toBe("/admin/reservations/failed");
    expect(alertHref(by("refund_pending")[0])).toBe("/admin/refunds");
    expect(alertHref(pa.find((a) => a.code === undefined)!)).toBe("/admin/refunds");
  });

  it("keeps other properties out of every list, alert and number", async () => {
    const { db, propertyId, otherId, res, pay } = await setup();
    await res("x-arr", "2026-11-24", "2026-11-26", { syncState: "failed", cancelledAt: NOW.getTime() }, 1, otherId);
    await res("x-pend", "2026-11-24", "2026-11-26", { status: "pending_payment" }, 1, otherId);
    await pay("x-c", "x-arr", "charge", 9999, min(10));
    await pay("x-r", "x-arr", "refund", 100, min(30), "pending");
    await db.insert(notifications).values({ id: "xn", propertyId: otherId, reservationId: "x-arr", kind: "cancelled", to: "a@x.com", status: "failed", at: min(5) });
    await db.insert(paymentEvents).values({ id: "xe", propertyId: otherId, provider: "p", rawBody: "{}", verdict: "stray_charge", at: min(5) });
    const d = await getDashboard(db, propertyId, NOW);
    expect(d.arrivalsToday).toEqual([]);
    expect(d.inHouse).toEqual([]);
    expect(d.pendingPayment).toBe(0);
    expect(d.alerts).toEqual([]);
    expect(d.kpis.today).toEqual({ revenue: 0, nights: 0, cancellations: 0 });
    expect(d.kpis.month).toEqual({ revenue: 0, nights: 0, cancellations: 0 });
    const other = await getDashboard(db, otherId, NOW);
    expect(other.arrivalsToday.map((r) => r.id)).toEqual(["x-arr"]);
    expect(other.kpis.today.revenue).toBe(9999);
  });

  it("alerts on a failed cancel / modify refund only while it is still the booking's open intent", async () => {
    const { db, propertyId, res } = await setup();
    const refund = (id: string, reservationId: string, key: string, status: "failed" | "succeeded" | "pending", createdAt = min(30)) =>
      db.insert(payments).values({ id, reservationId, kind: "refund", method: "sinopac_online", amount: 700, status, idempotencyKey: key, createdAt });
    // A cancellation in limbo: claimed (cancelledAt), still confirmed, its refund failed → alert.
    await res("cx", "2026-12-10", "2026-12-12", { cancelledAt: min(40) });
    await refund("r-cx", "cx", "cancel:cx", "failed");
    // A cancel that failed outright and dropped its claim (guest told, staff emailed then): no standing alert.
    await res("cy", "2026-12-10", "2026-12-12");
    await refund("r-cy", "cy", "cancel:cy", "failed");
    // A cancellation that was settled since: no alert.
    await res("cz", "2026-12-10", "2026-12-12", { status: "cancelled", cancelledAt: min(40) });
    await refund("r-cz", "cz", "cancel:cz", "succeeded");
    // A failed modification refund still blocks the confirmed booking → alert; a settled one does not.
    await res("mx", "2026-12-10", "2026-12-12");
    await refund("r-mx", "mx", "modify:mx:1", "failed", min(50));
    await refund("r-mx2", "mx", "modify:mx:2", "succeeded");
    // A failed stray-charge refund is the stray_refund_failed alert's, not this one's.
    await res("st", "2026-12-10", "2026-12-12");
    await refund("r-st", "st", "stray:REF-1", "failed");
    const { alerts } = await getDashboard(db, propertyId, NOW);
    const failed = alerts.filter((a) => a.kind === "refund_failed");
    expect(failed.map((a) => a.reservationId).sort()).toEqual(["cx", "mx"]);
    expect(failed.find((a) => a.reservationId === "mx")).toMatchObject({ code: "C-mx", since: min(50), detail: expect.stringContaining("700") });
    expect(alertHref(failed[0])).toBe("/admin/refunds");
    // Ranked with the other refund trouble, ahead of channel and email alerts.
    const kinds = alerts.map((a) => a.kind);
    expect(kinds.indexOf("refund_failed")).toBeLessThan(kinds.indexOf("email_failed") === -1 ? Infinity : kinds.indexOf("email_failed"));
  });

  it("computes revenue as charges and front-desk payments minus refunds, by Taipei day and month", async () => {
    const { db, propertyId, res, pay } = await setup();
    await res("arr", "2026-11-24", "2026-11-26");
    await res("dep", "2026-11-22", "2026-11-24");
    await res("inh", "2026-11-23", "2026-11-26", {}, 2);
    await res("future", "2026-12-10", "2026-12-12");
    await res("c1", "2026-12-20", "2026-12-21", { status: "cancelled", cancelledAt: min(30) });
    await res("c2", "2026-12-20", "2026-12-21", { status: "cancelled", cancelledAt: Date.parse("2026-11-05T05:00:00Z") });
    await res("c3", "2026-12-20", "2026-12-21", { status: "cancelled", cancelledAt: Date.parse("2026-10-30T05:00:00Z") });
    await pay("p1", "arr", "charge", 5000, min(60));
    await pay("p2", "arr", "front_desk", 1000, min(60));
    await pay("p3", "arr", "refund", 500, min(60));
    await pay("p4", "dep", "charge", 3000, Date.parse("2026-11-02T05:00:00Z"));
    await pay("p5", "dep", "charge", 200, Date.parse("2026-10-31T16:30:00Z")); // 11-01 00:30 Taipei: in November
    await pay("p6", "dep", "charge", 700, Date.parse("2026-11-30T17:00:00Z")); // 12-01 Taipei: December
    await pay("p7", "dep", "charge", 8000, min(60), "failed");
    await pay("p8", "dep", "charge", 8000, min(60), "pending");
    await pay("p9", "dep", "refund", 8000, min(60), "pending");
    const { kpis } = await getDashboard(db, propertyId, NOW);
    expect(kpis.today.revenue).toBe(5500);
    expect(kpis.month.revenue).toBe(5500 + 3000 + 200);
    // room-nights: today = rooms staying tonight (arr 1 + inh 2); month = nights inside November (2 + 2 + 3*2)
    expect(kpis.today.nights).toBe(3);
    expect(kpis.month.nights).toBe(10);
    expect(kpis.today.cancellations).toBe(1);
    expect(kpis.month.cancellations).toBe(2);
  });
});
