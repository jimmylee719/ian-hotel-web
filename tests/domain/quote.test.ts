import { describe, expect, test } from "vitest";
import { quote } from "@/lib/domain/quote";
import type { Offer } from "@/lib/domain/availability";

const offer: Offer = { unitTypeId: "u", ratePlanId: "r", nightlyPrices: [2000, 2400], roomSubtotal: 4400, availableUnits: 3 };
const breakfast = { addonId: "bf", unit: "per_person_night" as const, unitPrice: 250, qty: 1 };
const base = { offer, nights: 2, adults: 2, rooms: 1, addons: [breakfast], paymentMode: "full" as const, depositPct: 0 };

describe("quote", () => {
  test("percent promo discounts rooms only; add-ons are added after", () => {
    const q = quote({ ...base, promo: { code: "WELCOME10", kind: "percent", value: 10 } });
    expect(q).toMatchObject({ roomSubtotal: 4400, discount: 440, addonSubtotal: 1000, total: 4960, payNow: 4960, payLater: 0, promoCode: "WELCOME10" });
    expect(q.addonLines).toEqual([{ addonId: "bf", amount: 1000 }]);
  });
  test("fixed promo larger than room subtotal never makes the total negative", () => {
    const q = quote({ ...base, promo: { code: "BIG", kind: "fixed", value: 9999 } });
    expect(q.discount).toBe(4400);
    expect(q.total).toBe(1000);
  });
  test("deposit mode splits pay-now and pay-later", () => {
    const q = quote({ ...base, promo: { code: "WELCOME10", kind: "percent", value: 10 }, paymentMode: "deposit", depositPct: 30 });
    expect(q).toMatchObject({ total: 4960, payNow: 1488, payLater: 3472 });
  });
  test("multiple rooms multiply the room subtotal", () => {
    expect(quote({ ...base, rooms: 2, addons: [] }).roomSubtotal).toBe(8800);
  });
  test("per_stay and per_night add-ons", () => {
    const q = quote({ ...base, addons: [
      { addonId: "pickup", unit: "per_stay", unitPrice: 800, qty: 1 },
      { addonId: "parking", unit: "per_night", unitPrice: 300, qty: 1 },
    ] });
    expect(q.addonSubtotal).toBe(1400);
  });
});
