import { describe, expect, test } from "vitest";
import { daysBefore, parseStay, todayInTaipei } from "@/lib/domain/dates";

describe("parseStay", () => {
  test("lists each night of a half-open stay", () => {
    expect(parseStay("2026-12-01", "2026-12-03")).toEqual({
      ok: true,
      nights: ["2026-12-01", "2026-12-02"],
    });
  });
  test("rejects checkout equal to checkin", () => {
    expect(parseStay("2026-12-03", "2026-12-03")).toEqual({ ok: false, error: "CHECKOUT_NOT_AFTER_CHECKIN" });
  });
  test("rejects an impossible date", () => {
    expect(parseStay("2026-13-01", "2026-12-03")).toEqual({ ok: false, error: "INVALID_DATE" });
  });
  test("rejects a non-ISO string", () => {
    expect(parseStay("12/01/2026", "2026-12-03")).toEqual({ ok: false, error: "INVALID_DATE" });
  });
  test("rejects stays over 30 nights", () => {
    expect(parseStay("2026-12-01", "2027-01-01")).toEqual({ ok: false, error: "STAY_TOO_LONG" });
  });
  test("accepts exactly 30 nights", () => {
    const r = parseStay("2026-12-01", "2026-12-31");
    expect(r.ok && r.nights.length).toBe(30);
  });
});

describe("daysBefore", () => {
  test("counts Taipei calendar days: midnight Taipei is 3 days before", () => {
    expect(daysBefore("2026-12-10", new Date("2026-12-06T16:00:00Z"))).toBe(3);
  });
  test("one second before Taipei midnight is still 4 days before", () => {
    expect(daysBefore("2026-12-10", new Date("2026-12-06T15:59:59Z"))).toBe(4);
  });
  test("check-in day is 0", () => {
    expect(daysBefore("2026-12-10", new Date("2026-12-10T03:00:00Z"))).toBe(0);
  });
});

test("todayInTaipei uses Taipei date, not UTC", () => {
  expect(todayInTaipei(new Date("2026-12-06T16:30:00Z"))).toBe("2026-12-07");
});
