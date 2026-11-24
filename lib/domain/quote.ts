import type { Offer } from "./availability";
import { assertTwd, percentOf } from "./money";

export type AddonLine = { addonId: string; unit: "per_stay" | "per_night" | "per_person_night"; unitPrice: number; qty: number };
export type Promo = { code: string; kind: "percent" | "fixed"; value: number };
export type Quote = {
  nights: number;
  roomSubtotal: number;
  addonLines: { addonId: string; amount: number }[];
  addonSubtotal: number;
  discount: number;
  total: number;
  payNow: number;
  payLater: number;
  promoCode?: string;
};
export type QuoteInput = {
  offer: Offer;
  nights: number;
  adults: number;
  rooms: number;
  addons: AddonLine[];
  promo?: Promo;
  paymentMode: "full" | "deposit";
  depositPct: number;
};

/** The ONLY place a reservation's money is computed. Discounts apply to rooms only. */
export function quote(i: QuoteInput): Quote {
  const roomSubtotal = i.offer.roomSubtotal * i.rooms;
  const addonLines = i.addons.map((a) => {
    const mult = a.unit === "per_stay" ? 1 : a.unit === "per_night" ? i.nights : i.adults * i.nights;
    return { addonId: a.addonId, amount: a.unitPrice * a.qty * mult };
  });
  const addonSubtotal = addonLines.reduce((s, l) => s + l.amount, 0);
  const raw = !i.promo ? 0 : i.promo.kind === "percent" ? percentOf(roomSubtotal, i.promo.value) : i.promo.value;
  const discount = Math.min(Math.max(raw, 0), roomSubtotal);
  const total = roomSubtotal - discount + addonSubtotal;
  const payNow = i.paymentMode === "full" ? total : percentOf(total, i.depositPct);

  const q: Quote = {
    nights: i.nights,
    roomSubtotal: assertTwd(roomSubtotal),
    addonLines,
    addonSubtotal: assertTwd(addonSubtotal),
    discount: assertTwd(discount),
    total: assertTwd(total),
    payNow: assertTwd(payNow),
    payLater: assertTwd(total - payNow),
    ...(i.promo ? { promoCode: i.promo.code } : {}),
  };
  addonLines.forEach((l) => assertTwd(l.amount));
  return q;
}
