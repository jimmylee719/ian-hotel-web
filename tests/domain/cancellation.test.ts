import { describe, expect, test } from "vitest";
import { refundAmount, validateCancelPolicy } from "@/lib/domain/cancellation";

const policy = { rules: [{ daysBefore: 3, refundPct: 100 }, { daysBefore: 1, refundPct: 50 }] };

describe("refundAmount", () => {
  test("exactly 3 days before (Taipei midnight) refunds in full", () => {
    expect(refundAmount(policy, 4960, "2026-12-10", new Date("2026-12-06T16:00:00Z"))).toBe(4960);
  });
  test("1 day before refunds half", () => {
    expect(refundAmount(policy, 4960, "2026-12-10", new Date("2026-12-08T16:00:00Z"))).toBe(2480);
  });
  test("check-in day refunds nothing", () => {
    expect(refundAmount(policy, 4960, "2026-12-10", new Date("2026-12-09T16:00:00Z"))).toBe(0);
  });
  test("rule order in the policy does not matter", () => {
    const reversed = { rules: [...policy.rules].reverse() };
    expect(refundAmount(reversed, 4960, "2026-12-10", new Date("2026-12-01T00:00:00Z"))).toBe(4960);
  });
  test("non-refundable policy refunds nothing", () => {
    expect(refundAmount({ rules: [] }, 4960, "2026-12-10", new Date("2026-11-01T00:00:00Z"))).toBe(0);
  });
});

describe("validateCancelPolicy", () => {
  const rules = (...r: [number, number][]) => ({ rules: r.map(([daysBefore, refundPct]) => ({ daysBefore, refundPct })) });
  test("accepts a sane policy, an unsorted one, and no rules (non-refundable)", () => {
    expect(validateCancelPolicy(rules([7, 100], [3, 50], [0, 0]))).toBeNull();
    expect(validateCancelPolicy(rules([1, 50], [3, 100]))).toBeNull();
    expect(validateCancelPolicy(rules([3, 50], [1, 50]))).toBeNull();
    expect(validateCancelPolicy({ rules: [] })).toBeNull();
  });
  test("rejects a later, closer rule that refunds more", () => {
    expect(validateCancelPolicy(rules([3, 50], [1, 100]))).not.toBeNull();
    expect(validateCancelPolicy(rules([1, 100], [3, 50]))).not.toBeNull();
  });
  test("rejects duplicate daysBefore, out-of-range pct, negatives and non-integers", () => {
    expect(validateCancelPolicy(rules([3, 100], [3, 50]))).not.toBeNull();
    expect(validateCancelPolicy(rules([3, 101]))).not.toBeNull();
    expect(validateCancelPolicy(rules([3, -1]))).not.toBeNull();
    expect(validateCancelPolicy(rules([-1, 50]))).not.toBeNull();
    expect(validateCancelPolicy(rules([1.5, 50]))).not.toBeNull();
    expect(validateCancelPolicy(rules([3, 33.3]))).not.toBeNull();
  });
  test("rejects the wrong shape", () => {
    for (const bad of [null, undefined, "x", {}, { rules: "x" }, { rules: [null] }, { rules: [{ daysBefore: "3", refundPct: 50 }] }]) {
      expect(validateCancelPolicy(bad)).not.toBeNull();
    }
  });
});
