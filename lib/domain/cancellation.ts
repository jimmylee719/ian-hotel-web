import { daysBefore, type ISODate } from "./dates";
import { percentOf } from "./money";

/** Refund `refundPct` when cancelled at least `daysBefore` Taipei days before check-in. */
export type CancelPolicy = { rules: { daysBefore: number; refundPct: number }[] };

export function refundAmount(policy: CancelPolicy, paid: number, checkIn: ISODate, at: Date): number {
  const d = daysBefore(checkIn, at);
  const rule = [...policy.rules].sort((a, b) => b.daysBefore - a.daysBefore).find((r) => d >= r.daysBefore);
  return rule ? Math.min(paid, percentOf(paid, rule.refundPct)) : 0;
}
