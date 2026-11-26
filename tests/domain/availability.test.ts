import { describe, expect, test } from "vitest";
import { evaluateOffer, type AriNight } from "@/lib/domain/availability";

const night = (date: string, o: Partial<AriNight> = {}): AriNight => ({
  date, available: 3, price: 2000, minStay: 1,
  closedToArrival: false, closedToDeparture: false, stopSell: false, ...o,
});
const nights = ["2026-12-01", "2026-12-02"];
const ids = { unitTypeId: "u", ratePlanId: "r" };

describe("evaluateOffer", () => {
  test("sums nightly prices when every night is open", () => {
    const o = evaluateOffer(ids, nights, "2026-12-03", [night("2026-12-01"), night("2026-12-02", { price: 2400 })], 1);
    expect(o).toMatchObject({ nightlyPrices: [2000, 2400], roomSubtotal: 4400, availableUnits: 3 });
  });
  test("a stop-sell night blocks the whole stay", () => {
    expect(evaluateOffer(ids, nights, "2026-12-03", [night("2026-12-01"), night("2026-12-02", { stopSell: true })], 1)).toBeNull();
  });
  test("a missing night counts as unavailable", () => {
    expect(evaluateOffer(ids, nights, "2026-12-03", [night("2026-12-01")], 1)).toBeNull();
  });
  test("zero inventory on any night blocks", () => {
    expect(evaluateOffer(ids, nights, "2026-12-03", [night("2026-12-01"), night("2026-12-02", { available: 0 })], 1)).toBeNull();
  });
  test("closed to arrival on the first night blocks", () => {
    expect(evaluateOffer(ids, nights, "2026-12-03", [night("2026-12-01", { closedToArrival: true }), night("2026-12-02")], 1)).toBeNull();
  });
  test("closed to arrival on a later night does not block", () => {
    expect(evaluateOffer(ids, nights, "2026-12-03", [night("2026-12-01"), night("2026-12-02", { closedToArrival: true })], 1)).not.toBeNull();
  });
  test("closed to departure on the checkout date blocks", () => {
    expect(evaluateOffer(ids, nights, "2026-12-03", [night("2026-12-01"), night("2026-12-02"), night("2026-12-03", { closedToDeparture: true })], 1)).toBeNull();
  });
  test("stay shorter than first night's min stay blocks", () => {
    expect(evaluateOffer(ids, ["2026-12-01"], "2026-12-02", [night("2026-12-01", { minStay: 2 })], 1)).toBeNull();
  });
  test("two rooms need two units on every night", () => {
    expect(evaluateOffer(ids, nights, "2026-12-03", [night("2026-12-01"), night("2026-12-02", { available: 1 })], 2)).toBeNull();
  });
  test("availableUnits is the minimum across nights", () => {
    expect(evaluateOffer(ids, nights, "2026-12-03", [night("2026-12-01", { available: 5 }), night("2026-12-02", { available: 2 })], 1)?.availableUnits).toBe(2);
  });
  test("max stay applies on the arrival night only; null is no limit", () => {
    const two = [night("2026-12-01", { maxStay: 1 }), night("2026-12-02")];
    expect(evaluateOffer(ids, nights, "2026-12-03", two, 1)).toBeNull();
    expect(evaluateOffer(ids, nights, "2026-12-03", [night("2026-12-01", { maxStay: 2 }), night("2026-12-02", { maxStay: 1 })], 1)).not.toBeNull();
    expect(evaluateOffer(ids, nights, "2026-12-03", [night("2026-12-01", { maxStay: null }), night("2026-12-02")], 1)).not.toBeNull();
  });
  test("Stay Through min / max apply on every night of the stay", () => {
    expect(evaluateOffer(ids, nights, "2026-12-03", [night("2026-12-01"), night("2026-12-02", { minStayThrough: 3 })], 1)).toBeNull();
    expect(evaluateOffer(ids, nights, "2026-12-03", [night("2026-12-01"), night("2026-12-02", { maxStayThrough: 1 })], 1)).toBeNull();
    expect(evaluateOffer(ids, nights, "2026-12-03", [night("2026-12-01", { minStayThrough: 2, maxStayThrough: 2 }), night("2026-12-02")], 1)).not.toBeNull();
  });
});
