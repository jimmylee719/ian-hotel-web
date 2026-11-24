import { todayInTaipei, type ISODate } from "@/lib/domain/dates";

export type BookingSearch = { checkIn: ISODate; checkOut: ISODate; adults: number; children: number; rooms: number };

const DAY = 86_400_000;
const toUtc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

export function addDaysIso(iso: ISODate, days: number): ISODate {
  return new Date(toUtc(iso) + days * DAY).toISOString().slice(0, 10);
}

/** One night, starting `startOffset` Taipei days from now (default tomorrow). */
export function defaultStay(now: Date, startOffset = 1): { checkIn: ISODate; checkOut: ISODate } {
  const checkIn = addDaysIso(todayInTaipei(now), startOffset);
  return { checkIn, checkOut: addDaysIso(checkIn, 1) };
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  if (!checkIn || !checkOut) return 0;
  const n = Math.round((toUtc(checkOut) - toUtc(checkIn)) / DAY);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Locale-less path; the next-intl router adds the `/{locale}` prefix. */
export function bookingSearchPath(s: BookingSearch): string {
  const q = new URLSearchParams({
    checkIn: s.checkIn,
    checkOut: s.checkOut,
    adults: String(s.adults),
    children: String(s.children),
    rooms: String(s.rooms),
  });
  return `/book?${q}`;
}
