import type { ISODate } from "./dates";

export type AriNight = {
  date: ISODate;
  available: number;
  price: number;
  minStay: number;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
  /** Longest stay arriving this night (SetMaxLOS); null / absent = no limit. */
  maxStay?: number | null;
  /** Stay Through: a stay covering this night must be at least / at most this many nights; null / absent = no limit. */
  minStayThrough?: number | null;
  maxStayThrough?: number | null;
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
 * A night with no ARI row, or priced 0 (rates not loaded yet), counts as unavailable.
 * Restrictions (SiteMinder's, docs/integrations/siteminder.md §4.1): stop sell on any night; closed to arrival,
 * min / max stay on the arrival night; closed to departure on the check-out date; Stay Through min / max on every
 * night of the stay.
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
  if (stay.some((n) => !n || n.stopSell || n.price <= 0 || n.available < rooms)) return null;
  const first = stay[0]!;
  const len = nights.length;
  if (first.closedToArrival || len < first.minStay || (first.maxStay != null && len > first.maxStay)) return null;
  if (stay.some((n) => (n!.minStayThrough != null && len < n!.minStayThrough) || (n!.maxStayThrough != null && len > n!.maxStayThrough))) return null;
  if (byDate.get(checkOut)?.closedToDeparture) return null;
  const nightlyPrices = stay.map((n) => n!.price);
  return {
    ...ids,
    nightlyPrices,
    roomSubtotal: nightlyPrices.reduce((a, b) => a + b, 0),
    availableUnits: Math.min(...stay.map((n) => n!.available)),
  };
}
