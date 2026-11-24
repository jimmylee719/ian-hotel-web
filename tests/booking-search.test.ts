import { describe, expect, test } from "vitest";
import { bookingSearchPath, defaultStay, nightsBetween } from "@/lib/booking-search";

describe("booking search", () => {
  test("path carries every field in the brief's order", () => {
    expect(bookingSearchPath({ checkIn: "2026-12-18", checkOut: "2026-12-20", adults: 2, children: 1, rooms: 1 })).toBe(
      "/book?checkIn=2026-12-18&checkOut=2026-12-20&adults=2&children=1&rooms=1",
    );
  });

  test("default stay is tomorrow for one night, in Taipei time", () => {
    // 2026-11-25 20:00 UTC is already 26 Nov in Taipei.
    expect(defaultStay(new Date("2026-11-25T20:00:00Z"))).toEqual({ checkIn: "2026-11-27", checkOut: "2026-11-28" });
    expect(defaultStay(new Date("2026-11-25T01:00:00Z"), 0)).toEqual({ checkIn: "2026-11-25", checkOut: "2026-11-26" });
  });

  test("nights between two dates; 0 when missing or reversed", () => {
    expect(nightsBetween("2026-12-18", "2026-12-20")).toBe(2);
    expect(nightsBetween("2026-12-20", "2026-12-18")).toBe(0);
    expect(nightsBetween("", "2026-12-18")).toBe(0);
  });
});
