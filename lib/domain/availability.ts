import type { ISODate } from "./dates";

export type AriNight = {
  date: ISODate;
  available: number;
  price: number;
  minStay: number;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
};

export type Offer = {
  unitTypeId: string;
  ratePlanId: string;
  nightlyPrices: number[];
  roomSubtotal: number;
  availableUnits: number;
};

/**
 * Decide whether one (room type, rate plan) can be sold for the stay.
 * A night with no ARI row counts as unavailable.
 */
export function evaluateOffer(
  ids: { unitTypeId: string; ratePlanId: string },
  nights: ISODate[],
  checkOut: ISODate,
  rows: AriNight[],
  rooms: number,
): Offer | null {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const stay = nights.map((d) => byDate.get(d));
  if (stay.some((n) => !n || n.stopSell || n.available < rooms)) return null;
  const first = stay[0]!;
  if (first.closedToArrival || nights.length < first.minStay) return null;
  if (byDate.get(checkOut)?.closedToDeparture) return null;
  const nightlyPrices = stay.map((n) => n!.price);
  return {
    ...ids,
    nightlyPrices,
    roomSubtotal: nightlyPrices.reduce((a, b) => a + b, 0),
    availableUnits: Math.min(...stay.map((n) => n!.available)),
  };
}
