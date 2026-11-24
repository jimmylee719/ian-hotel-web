import { describe, expect, test } from "vitest";
import { refundAmount } from "@/lib/domain/cancellation";

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
