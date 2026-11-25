import { describe, expect, it } from "vitest";
import { displayMoney } from "@/lib/admin/money-metrics";

const m = { total: 4000, received: 3000, refunded: 1000 };

describe("displayMoney", () => {
  it.each(["pending_payment", "paid_pending_confirm", "confirmed"])("%s: net paid and the balance still owed", (status) => {
    expect(displayMoney(status, m)).toEqual({ paid: 2000, refunded: 1000, balanceDue: 2000 });
  });

  it.each(["cancelled", "expired", "confirm_failed_refunded"])("%s: balanceDue is null, amounts unchanged", (status) => {
    expect(displayMoney(status, m)).toEqual({ paid: 2000, refunded: 1000, balanceDue: null });
  });

  it("keeps an overpayment as a negative balance on an open booking", () => {
    expect(displayMoney("confirmed", { total: 1000, received: 1500, refunded: 0 }).balanceDue).toBe(-500);
  });
});
