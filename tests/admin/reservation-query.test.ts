import { describe, expect, it } from "vitest";
import { parseReservationQuery, reservationQueryString } from "@/lib/admin/reservation-query";

describe("reservation list query string", () => {
  it("round-trips filters through the URL", () => {
    const f = parseReservationQuery({ q: " nk-abc ", status: "confirmed,cancelled", sync: "failed", from: "2026-12-01", to: "2026-12-31", field: "createdAt", sort: "checkIn", page: "3" });
    expect(f).toEqual({
      q: "nk-abc", status: ["confirmed", "cancelled"], syncState: ["failed"], from: "2026-12-01", to: "2026-12-31",
      dateField: "createdAt", sort: "checkIn", page: 3,
    });
    expect(parseReservationQuery(Object.fromEntries(new URLSearchParams(reservationQueryString(f))))).toEqual(f);
  });

  it("drops unknown or malformed values and defaults the rest", () => {
    const f = parseReservationQuery({ status: ["confirmed", "bogus"], sync: "nope", from: "tomorrow", to: "2026-13-45x", page: "-2", sort: "x" });
    expect(f).toEqual({ status: ["confirmed"], dateField: "checkIn", sort: "-createdAt", page: 1 });
    expect(reservationQueryString(f)).toBe("?status=confirmed");
    expect(reservationQueryString({ page: 1, dateField: "checkIn", sort: "-createdAt" })).toBe("");
  });
});
