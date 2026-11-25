import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { getDashboard } from "@/lib/admin/dashboard";
import {
  bookingsReport, cancellationReport, MAX_REPORT_DAYS, occupancyReport, revenueReport, validateRange,
} from "@/lib/admin/reports";
import { addons, guests, inventoryDaily, payments, properties, ratePlans, reservationRooms, reservations, staff, unitTypes } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import type { Db } from "@/lib/db/types";
import { createTestDb } from "../helpers/test-db";

const NOW = new Date("2026-11-24T02:00:00Z"); // 2026-11-24 10:00 Taipei
const at = (iso: string) => Date.parse(iso);

async function setup() {
  const tdb = createTestDb();
  const db = tdb as unknown as Db;
  const { propertyId } = await seedNk(tdb);
  const types = await db.select().from(unitTypes).where(eq(unitTypes.propertyId, propertyId)).orderBy(unitTypes.sortOrder);
  const unitTypeId = types[0].id;
  const [{ id: ratePlanId }] = await db.select({ id: ratePlans.id }).from(ratePlans).limit(1);
  const otherId = "prop-other";
  await db.insert(properties).values({
    id: otherId, slug: "other", type: "hotel", name: { "zh-TW": "他館", en: "Other", ja: "Other", ko: "Other" },
    timezone: "Asia/Taipei", currency: "TWD", address: { "zh-TW": "a", en: "a", ja: "a", ko: "a" }, phone: "1", email: "o@x.com", createdAt: 0,
  });
  let n = 0;
  const res = async (
    id: string, checkIn: string, checkOut: string, over: Partial<typeof reservations.$inferInsert> = {}, rooms = 1, pid = propertyId, ut = unitTypeId,
  ) => {
    const gid = `g${++n}`;
    await db.insert(guests).values({ id: gid, propertyId: pid, firstName: "Mei", lastName: `L${n}`, email: `g${n}@x.com`, phone: "1", country: "TW", locale: "en", createdAt: 0 });
    await db.insert(reservations).values({
      id, propertyId: pid, code: `C-${id}`, guestId: gid, status: "confirmed", channel: "direct",
      checkIn, checkOut, adults: 2, children: 0, locale: "en", quote: {}, totalAmount: 4000, syncState: "synced",
      guestEmailLower: `${id}@x.com`, createdAt: 0, updatedAt: NOW.getTime(), ...over,
    });
    for (let i = 0; i < rooms; i++) await db.insert(reservationRooms).values({ id: `${id}-r${i}`, reservationId: id, unitTypeId: ut, ratePlanId, nightlyPrices: [2000] });
  };
  let p = 0;
  const pay = (reservationId: string, kind: "charge" | "refund" | "front_desk", amount: number, createdAt: number, o: { method?: "sinopac_online" | "edc" | "cash" | "transfer"; status?: "succeeded" | "pending" | "failed"; settledAt?: number } = {}) =>
    db.insert(payments).values({
      id: `p${++p}`, reservationId, kind, method: o.method ?? (kind === "charge" ? "sinopac_online" : kind === "refund" ? "sinopac_online" : "edc"),
      amount, status: o.status ?? "succeeded", createdAt, ...(o.settledAt !== undefined ? { settledAt: o.settledAt } : {}),
    });
  const inv = (ut: string, date: string, available: number) =>
    db.insert(inventoryDaily).values({ propertyId, unitTypeId: ut, date, available, source: "local", syncedAt: 0 });
  return { tdb, db, propertyId, otherId, types, unitTypeId, ratePlanId, res, pay, inv };
}

describe("validateRange", () => {
  it("accepts from <= to up to 366 days inclusive and rejects the rest", () => {
    expect(MAX_REPORT_DAYS).toBe(366);
    expect(validateRange("2026-01-01", "2026-01-01")).toEqual({ ok: true });
    expect(validateRange("2026-01-01", "2027-01-01")).toEqual({ ok: true }); // 366 days
    expect(validateRange("2026-01-01", "2027-01-02")).toEqual({ ok: false, error: "RANGE_TOO_LONG" });
    expect(validateRange("2026-01-01", "2027-02-04")).toEqual({ ok: false, error: "RANGE_TOO_LONG" }); // 400 days
    expect(validateRange("2026-02-01", "2026-01-31")).toEqual({ ok: false, error: "INVALID_RANGE" });
    expect(validateRange("2026-02-30", "2026-03-01")).toEqual({ ok: false, error: "INVALID_RANGE" });
    expect(validateRange("nope", "2026-03-01")).toEqual({ ok: false, error: "INVALID_RANGE" });
  });
});

describe("revenueReport", () => {
  it("buckets by the payment's Taipei date, so a 23:30 UTC payment falls on the next day and month", async () => {
    const { db, propertyId, res, pay } = await setup();
    await res("a", "2026-12-10", "2026-12-12");
    await pay("a", "charge", 1000, at("2026-10-31T15:30:00Z")); // 10-31 23:30 Taipei
    await pay("a", "charge", 2000, at("2026-10-31T16:30:00Z")); // 11-01 00:30 Taipei
    await pay("a", "charge", 4000, at("2026-11-30T23:30:00Z")); // 12-01 07:30 Taipei
    const r = await revenueReport(db, propertyId, { from: "2026-10-01", to: "2026-12-31", groupBy: "month" });
    expect(r.rows.map((x) => [x.period, x.net])).toEqual([["2026-10", 1000], ["2026-11", 2000], ["2026-12", 4000]]);
    const d = await revenueReport(db, propertyId, { from: "2026-10-31", to: "2026-11-01", groupBy: "day" });
    expect(d.rows.map((x) => [x.period, x.net])).toEqual([["2026-10-31", 1000], ["2026-11-01", 2000]]);
  });

  it("splits online charges, online refunds, desk payments and desk refunds; net is the money module's received", async () => {
    const { db, propertyId, res, pay } = await setup();
    await res("a", "2026-12-10", "2026-12-12");
    const t = at("2026-11-10T04:00:00Z");
    await pay("a", "charge", 5000, t);
    await pay("a", "refund", 1200, t, { method: "sinopac_online" });
    await pay("a", "front_desk", 800, t, { method: "cash" });
    await pay("a", "refund", 300, t, { method: "cash" }); // paid out at the desk
    await pay("a", "charge", 999, t, { status: "pending" });
    await pay("a", "front_desk", 777, t, { status: "failed" }); // a voided desk payment
    const r = await revenueReport(db, propertyId, { from: "2026-11-01", to: "2026-11-30", groupBy: "month" });
    expect(r.rows).toEqual([{ period: "2026-11", onlineCharges: 5000, onlineRefunds: 1200, deskPayments: 800, deskRefunds: 300, net: 5000 - 1200 + 800 - 300 }]);
    expect(r.total).toEqual({ onlineCharges: 5000, onlineRefunds: 1200, deskPayments: 800, deskRefunds: 300, net: 4300 });
  });

  it("counts a refund on the date it succeeded (settledAt), not when it was asked for; the dashboard agrees (M-6)", async () => {
    const { db, propertyId, res, pay } = await setup();
    await res("a", "2026-12-10", "2026-12-12");
    await pay("a", "charge", 5000, at("2026-10-20T04:00:00Z"));
    // Asked for on 10-30, outcome unknown, settled by reconciliation on 11-02.
    await pay("a", "refund", 1200, at("2026-10-30T04:00:00Z"), { settledAt: at("2026-11-02T04:00:00Z") });
    // Asked for in November but settled after the range: not in November.
    await pay("a", "refund", 300, at("2026-11-20T04:00:00Z"), { settledAt: at("2026-12-01T04:00:00Z") });
    const r = await revenueReport(db, propertyId, { from: "2026-10-01", to: "2026-12-31", groupBy: "month" });
    expect(r.rows.map((x) => [x.period, x.onlineRefunds, x.net])).toEqual([["2026-10", 0, 5000], ["2026-11", 1200, -1200], ["2026-12", 300, -300]]);
    const nov = await revenueReport(db, propertyId, { from: "2026-11-01", to: "2026-11-30", groupBy: "day" });
    expect(nov.rows.map((x) => [x.period, x.net])).toEqual([["2026-11-02", -1200]]);
    expect((await getDashboard(db, propertyId, NOW)).kpis.month.revenue).toBe(-1200);
  });

  it("ignores other properties, OTA bookings and dates outside the range", async () => {
    const { db, propertyId, otherId, res, pay } = await setup();
    await res("mine", "2026-12-10", "2026-12-12");
    await res("ota", "2026-12-10", "2026-12-12", { channel: "siteminder_ota" });
    await res("theirs", "2026-12-10", "2026-12-12", {}, 1, otherId);
    const t = at("2026-11-10T04:00:00Z");
    await pay("mine", "charge", 1000, t);
    await pay("mine", "charge", 50, at("2026-12-01T04:00:00Z"));
    await pay("ota", "charge", 700, t);
    await pay("theirs", "charge", 900, t);
    const r = await revenueReport(db, propertyId, { from: "2026-11-01", to: "2026-11-30", groupBy: "day" });
    expect(r.total.net).toBe(1000);
  });

  it("the month total equals the dashboard's month revenue KPI for the same data", async () => {
    const { db, propertyId, res, pay } = await setup();
    await res("a", "2026-12-10", "2026-12-12");
    await res("b", "2026-11-20", "2026-11-22");
    await pay("a", "charge", 5000, at("2026-10-31T16:30:00Z")); // 11-01 00:30 Taipei: in November
    await pay("a", "charge", 2500, at("2026-10-31T15:30:00Z")); // 10-31 Taipei: not November
    await pay("a", "refund", 1000, at("2026-11-15T03:00:00Z"));
    await pay("b", "front_desk", 1500, at("2026-11-23T05:00:00Z"), { method: "transfer" });
    await pay("b", "refund", 200, at("2026-11-23T06:00:00Z"), { method: "cash" });
    await pay("b", "charge", 123, at("2026-11-23T06:00:00Z"), { status: "pending" });
    const kpi = (await getDashboard(db, propertyId, NOW)).kpis.month.revenue;
    const report = await revenueReport(db, propertyId, { from: "2026-11-01", to: "2026-11-30", groupBy: "month" });
    expect(kpi).toBe(5000 - 1000 + 1500 - 200);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].net).toBe(kpi);
    expect(report.total.net).toBe(kpi);
  });
});

describe("occupancyReport", () => {
  it("counts a 2-night booking once on each of its nights (and once per room)", async () => {
    const { db, propertyId, unitTypeId, res, inv } = await setup();
    await res("a", "2026-12-10", "2026-12-12");
    await res("b", "2026-12-11", "2026-12-12", {}, 2);
    await inv(unitTypeId, "2026-12-10", 3);
    await inv(unitTypeId, "2026-12-11", 1);
    const r = await occupancyReport(db, propertyId, { from: "2026-12-09", to: "2026-12-12" });
    const row = (date: string) => r.rows.find((x) => x.date === date && x.unitTypeId === unitTypeId)!;
    expect(row("2026-12-09")).toMatchObject({ sold: 0, available: null, rate: null });
    expect(row("2026-12-10")).toMatchObject({ sold: 1, available: 3, rate: 0.25 });
    expect(row("2026-12-11")).toMatchObject({ sold: 3, available: 1, rate: 0.75 });
    expect(row("2026-12-12")).toMatchObject({ sold: 0, available: null, rate: null }); // check-out day is not a night
  });

  it("counts only confirmed bookings, and a cancelled one only for the nights already stayed", async () => {
    const { db, propertyId, unitTypeId, res } = await setup();
    await res("conf", "2026-12-01", "2026-12-02");
    await res("pend", "2026-12-01", "2026-12-02", { status: "pending_payment" });
    await res("exp", "2026-12-01", "2026-12-02", { status: "expired" });
    // Staff cancel on 12-03 (Taipei) of a 12-01 → 12-05 stay: nights 12-01 and 12-02 were stayed, 12-03 on were released.
    await res("cx", "2026-12-01", "2026-12-05", { status: "cancelled", cancelledAt: at("2026-12-03T04:00:00Z") });
    // Cancelled before check-in: every night released.
    await res("early", "2026-12-01", "2026-12-03", { status: "cancelled", cancelledAt: at("2026-11-20T04:00:00Z") });
    // Cancelled on the check-in day itself (Taipei): that night is released too.
    await res("day0", "2026-12-01", "2026-12-02", { status: "cancelled", cancelledAt: at("2026-11-30T17:00:00Z") });
    const r = await occupancyReport(db, propertyId, { from: "2026-12-01", to: "2026-12-05" });
    const sold = Object.fromEntries(r.rows.filter((x) => x.unitTypeId === unitTypeId).map((x) => [x.date, x.sold]));
    expect(sold).toEqual({ "2026-12-01": 2, "2026-12-02": 1, "2026-12-03": 0, "2026-12-04": 0, "2026-12-05": 0 });
  });

  it("is per unit type, scoped to the property and clipped to the range", async () => {
    const { db, propertyId, otherId, types, res, inv } = await setup();
    await res("a", "2026-11-28", "2026-12-03", {}, 1, propertyId, types[1].id);
    await res("x", "2026-12-01", "2026-12-02", {}, 1, otherId);
    await inv(types[1].id, "2026-12-01", 4);
    const r = await occupancyReport(db, propertyId, { from: "2026-12-01", to: "2026-12-02" });
    expect(r.rows).toHaveLength(2 * types.length);
    expect(r.rows.filter((x) => x.unitTypeId === types[1].id).map((x) => [x.date, x.sold, x.rate])).toEqual([["2026-12-01", 1, 0.2], ["2026-12-02", 1, null]]);
    expect(r.rows.filter((x) => x.unitTypeId === types[0].id).every((x) => x.sold === 0)).toBe(true);
    expect(r.rows[0]).toHaveProperty("unitTypeName");
  });
});

describe("bookingsReport", () => {
  it("has a row per booking with the list's columns plus promo, add-on lines and the booked plan name", async () => {
    const { db, propertyId, otherId, ratePlanId, res, pay } = await setup();
    await db.insert(addons).values({ id: "ad1", propertyId, slug: "bf", name: { "zh-TW": "早餐", en: "Breakfast", ja: "b", ko: "b" }, price: 300, unit: "per_person_night" });
    await res("a", "2026-12-10", "2026-12-12", {
      quote: { nights: 2, roomSubtotal: 4400, addonLines: [{ addonId: "ad1", amount: 1200 }, { addonId: "gone", amount: 50 }], addonSubtotal: 1250, discount: 440, total: 5210, promoCode: "SAVE10" },
      promoCode: "SAVE10", totalAmount: 5210, createdAt: at("2026-11-01T00:00:00Z"),
      ratePlanName: { "zh-TW": "舊方案名", en: "Old", ja: "o", ko: "o" },
    });
    await res("b", "2026-12-20", "2026-12-21");
    await res("far", "2027-02-01", "2027-02-02");
    await res("theirs", "2026-12-11", "2026-12-12", {}, 1, otherId);
    await pay("a", "charge", 5210, at("2026-11-01T00:00:00Z"));
    void ratePlanId;
    const r = await bookingsReport(db, propertyId, { from: "2026-12-01", to: "2026-12-31" });
    expect(r.rows.map((x) => x.code)).toEqual(["C-a", "C-b"]);
    expect(r.rows[0]).toMatchObject({
      code: "C-a", status: "confirmed", checkIn: "2026-12-10", checkOut: "2026-12-12", nights: 2, total: 5210, paid: 5210, refunded: 0, balanceDue: 0,
      promoCode: "SAVE10", discount: 440, ratePlan: "舊方案名", addonTotal: 1250,
    });
    expect(r.rows[0].addons).toBe("早餐 NT$1,200；add-on gone NT$50");
    expect(r.rows[1]).toMatchObject({ promoCode: "", discount: 0, addons: "", addonTotal: 0 });
    expect(r.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["code", "guestName", "checkIn", "total", "paid", "promoCode", "addons", "ratePlan"]));
  });

  it("reads a malformed quote as no promo and no add-ons", async () => {
    const { db, propertyId, res } = await setup();
    await res("a", "2026-12-10", "2026-12-12", { quote: "garbage" as unknown as object });
    const r = await bookingsReport(db, propertyId, { from: "2026-12-01", to: "2026-12-31" });
    expect(r.rows[0]).toMatchObject({ promoCode: "", discount: 0, addons: "", addonTotal: 0 });
  });
});

describe("cancellationReport", () => {
  it("counts cancellations by Taipei cancel date, buckets them by days before check-in, and totals refunds", async () => {
    const { db, propertyId, res, pay } = await setup();
    const cx = (id: string, checkIn: string, cancelledAt: number, created = at("2026-11-02T00:00:00Z")) =>
      res(id, checkIn, "2026-12-30", { status: "cancelled", cancelledAt, createdAt: created });
    await cx("far", "2026-12-20", at("2026-11-05T04:00:00Z")); // 45 days
    await cx("wk", "2026-11-17", at("2026-11-08T04:00:00Z")); // 9 days
    await cx("mid", "2026-11-15", at("2026-11-10T04:00:00Z")); // 5 days
    await cx("one", "2026-11-12", at("2026-11-11T04:00:00Z")); // 1 day
    await cx("zero", "2026-11-12", at("2026-11-12T04:00:00Z")); // check-in day
    await cx("after", "2026-11-12", at("2026-11-14T04:00:00Z")); // after check-in
    await cx("outside", "2026-12-20", at("2026-12-05T04:00:00Z"));
    await cx("edge", "2026-12-20", at("2026-11-30T16:30:00Z")); // 12-01 00:30 Taipei: outside November
    await res("kept1", "2026-12-20", "2026-12-22", { createdAt: at("2026-11-03T00:00:00Z") });
    await res("kept2", "2026-12-20", "2026-12-22", { createdAt: at("2026-11-04T00:00:00Z") });
    await res("unpaid", "2026-12-20", "2026-12-22", { status: "pending_payment", createdAt: at("2026-11-04T00:00:00Z") });
    await pay("far", "charge", 4000, at("2026-11-02T00:00:00Z"));
    await pay("far", "refund", 4000, at("2026-11-05T04:00:00Z"));
    await pay("wk", "charge", 3000, at("2026-11-02T00:00:00Z"));
    await pay("wk", "refund", 1500, at("2026-11-08T04:00:00Z"));
    await pay("wk", "refund", 500, at("2026-11-08T05:00:00Z"), { method: "cash" }); // paid out at the desk
    await pay("wk", "refund", 9999, at("2026-11-08T05:00:00Z"), { status: "pending" });
    await pay("outside", "refund", 777, at("2026-12-05T05:00:00Z"));
    const r = await cancellationReport(db, propertyId, { from: "2026-11-01", to: "2026-11-30" });
    expect(r.cancellations).toBe(6);
    expect(r.refundTotal).toBe(4000 + 1500 + 500);
    expect(Object.fromEntries(r.buckets.map((b) => [b.label, b.count]))).toEqual({
      "入住後": 1, "入住當天": 1, "前 1 天": 1, "前 2–6 天": 1, "前 7–13 天": 1, "前 14 天以上": 1,
    });
    // Bookings made in November that reached confirmation: 6 cancelled (all created 11-02) + 2 kept; unpaid is not counted.
    expect(r.rateBase).toBe(8 + 2); // far..after (6) + outside + edge cancelled, created in Nov, + kept1 + kept2
    expect(r.rate).toBeCloseTo(8 / 10);
  });

  it("has a null rate when there is nothing to divide by", async () => {
    const { db, propertyId } = await setup();
    const r = await cancellationReport(db, propertyId, { from: "2026-11-01", to: "2026-11-30" });
    expect(r).toMatchObject({ cancellations: 0, refundTotal: 0, rate: null, rateBase: 0 });
    expect(r.buckets.every((b) => b.count === 0)).toBe(true);
  });
});

describe("GET /api/admin/reports/<kind>", () => {
  async function api(role: "manager" | "marketing" | "front_desk", url: string, kind = "revenue", propertyIds?: string[]) {
    const s = await setup();
    await s.res("a", "2026-12-10", "2026-12-12");
    await s.pay("a", "charge", 1000, at("2026-11-10T04:00:00Z"));
    await s.db.insert(staff).values({ id: "s1", email: "s@nk.test", name: "s", role, propertyIds: propertyIds ?? [s.propertyId], active: true });
    vi.resetModules();
    vi.doMock("@/lib/db/client", () => ({ getDb: async () => s.db }));
    vi.doMock("@/lib/runtime/env", () => ({ appEnv: async () => ({ ENVIRONMENT: "local", DEV_STAFF_EMAIL: "s@nk.test" }) }));
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
    try {
      const route = await import("@/app/api/admin/reports/[kind]/route");
      return await route.GET(new Request(`http://x/api/admin/reports/${kind}${url}`), { params: Promise.resolve({ kind }) });
    } finally {
      vi.doUnmock("@/lib/db/client");
      vi.doUnmock("@/lib/runtime/env");
      vi.doUnmock("next/headers");
    }
  }

  it("answers JSON for a manager", async () => {
    const r = await api("manager", "?from=2026-11-01&to=2026-11-30&groupBy=month&format=json");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(((await r.json()) as { rows: unknown[] }).rows).toEqual([expect.objectContaining({ period: "2026-11", net: 1000 })]);
  });

  it("answers a CSV attachment with a BOM, CRLF lines, an ASCII filename and no-store", async () => {
    const r = await api("manager", "?from=2026-11-01&to=2026-11-30&format=csv");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="revenue-2026-11-01-2026-11-30.csv"');
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await r.arrayBuffer());
    expect(body.startsWith("﻿")).toBe(true);
    expect(body).toContain("\r\n2026-11-10,1000,");
  });

  it("exports every report kind as CSV", async () => {
    for (const kind of ["occupancy", "bookings", "cancellations"]) {
      const r = await api("manager", "?from=2026-12-01&to=2026-12-31&format=csv", kind);
      expect(r.status, kind).toBe(200);
      expect(r.headers.get("content-disposition")).toBe(`attachment; filename="${kind}-2026-12-01-2026-12-31.csv"`);
    }
  });

  it("refuses a range of 400 days with 400, and a reversed or malformed one", async () => {
    expect((await api("manager", "?from=2026-01-01&to=2027-02-05")).status).toBe(400);
    expect((await api("manager", "?from=2026-02-01&to=2026-01-01")).status).toBe(400);
    expect((await api("manager", "?from=2026-02-01")).status).toBe(400);
    expect((await api("manager", "?from=2026-01-01&to=2026-02-01&format=xml")).status).toBe(400);
    expect((await api("manager", "?from=2026-01-01&to=2026-02-01&groupBy=year")).status).toBe(400);
  });

  it("is 404 for an unknown report kind", async () => {
    expect((await api("manager", "?from=2026-01-01&to=2026-02-01", "secrets")).status).toBe(404);
  });

  it("is 403 for marketing and front desk, and for staff without access to the current property", async () => {
    const q = "?from=2026-11-01&to=2026-11-30";
    expect((await api("marketing", q)).status).toBe(403);
    expect((await api("front_desk", q)).status).toBe(403);
    expect((await api("manager", q, "revenue", [])).status).toBe(403);
  });
});
