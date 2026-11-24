export { formatPrice } from "@/components/site/price";

/** "12月1日 (週二)" / "Tue, December 1" — dates are calendar dates, so format them in UTC. */
export function formatDate(iso: string, locale: string, opts: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", weekday: "short" }): string {
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}

const int = (v: string | string[] | undefined, min: number, max: number, dflt: number) => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
};
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export type SearchParams = Record<string, string | string[] | undefined>;

/** Guests from a /book or /book/details query string, clamped to what the booking API accepts. */
export function parseGuests(q: SearchParams): { adults: number; children: number; rooms: number } {
  const adults = int(q.adults, 1, 12, 2);
  const children = int(q.children, 0, 6, 0);
  const rooms = Math.min(int(q.rooms, 1, 6, 1), adults);
  return { adults, children, rooms };
}

export const param = one;
