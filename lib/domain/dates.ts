import { addDays, differenceInCalendarDays, format, isValid, parse } from "date-fns";
import { toZonedTime } from "date-fns-tz";

/** A calendar date, `YYYY-MM-DD`. Stays are half-open: [checkIn, checkOut). */
export type ISODate = string;

export const PROPERTY_TZ = "Asia/Taipei";
export const MAX_NIGHTS = 30;

export type StayResult =
  | { ok: true; nights: ISODate[] }
  | { ok: false; error: "INVALID_DATE" | "CHECKOUT_NOT_AFTER_CHECKIN" | "STAY_TOO_LONG" };

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function toLocalDate(s: string): Date | null {
  if (!ISO_RE.test(s)) return null;
  const d = parse(s, "yyyy-MM-dd", new Date(2000, 0, 1));
  return isValid(d) && format(d, "yyyy-MM-dd") === s ? d : null;
}

export function parseStay(checkIn: string, checkOut: string): StayResult {
  const a = toLocalDate(checkIn);
  const b = toLocalDate(checkOut);
  if (!a || !b) return { ok: false, error: "INVALID_DATE" };
  const n = differenceInCalendarDays(b, a);
  if (n <= 0) return { ok: false, error: "CHECKOUT_NOT_AFTER_CHECKIN" };
  if (n > MAX_NIGHTS) return { ok: false, error: "STAY_TOO_LONG" };
  return { ok: true, nights: Array.from({ length: n }, (_, i) => format(addDays(a, i), "yyyy-MM-dd")) };
}

export function todayInTaipei(now: Date = new Date()): ISODate {
  return format(toZonedTime(now, PROPERTY_TZ), "yyyy-MM-dd");
}

/** Whole Taipei calendar days from `at` until `checkIn` (check-in day = 0). */
export function daysBefore(checkIn: ISODate, at: Date): number {
  const ci = toLocalDate(checkIn);
  if (!ci) throw new Error(`Invalid check-in date: ${checkIn}`);
  const today = toLocalDate(todayInTaipei(at))!;
  return differenceInCalendarDays(ci, today);
}
