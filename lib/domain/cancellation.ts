import { daysBefore, type ISODate } from "./dates";
import { percentOf } from "./money";

/** Refund `refundPct` when cancelled at least `daysBefore` Taipei days before check-in. */
export type CancelPolicy = { rules: { daysBefore: number; refundPct: number }[] };

export function refundAmount(policy: CancelPolicy, paid: number, checkIn: ISODate, at: Date): number {
  const d = daysBefore(checkIn, at);
  const rule = [...policy.rules].sort((a, b) => b.daysBefore - a.daysBefore).find((r) => d >= r.daysBefore);
  return rule ? Math.min(paid, percentOf(paid, rule.refundPct)) : 0;
}

/**
 * Whether `p` is a policy staff may save: every rule has a non-negative integer `daysBefore` (none repeated)
 * and an integer `refundPct` of 0..100, and the refund never rises as check-in gets closer. Returns the
 * reason (zh-TW, shown to staff) or null when it is fine. No rules at all means non-refundable.
 */
export function validateCancelPolicy(p: unknown): string | null {
  const rules = (p as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rules) || rules.length > 20) return "取消規則格式不正確（最多 20 條）";
  const seen = new Set<number>();
  for (const r of rules) {
    const { daysBefore: d, refundPct: pct } = (r ?? {}) as { daysBefore?: unknown; refundPct?: unknown };
    if (!Number.isInteger(d) || (d as number) < 0 || (d as number) > 3650) return "「入住前幾天」必須是 0 以上的整數";
    if (!Number.isInteger(pct) || (pct as number) < 0 || (pct as number) > 100) return "退款比例必須是 0 到 100 的整數";
    if (seen.has(d as number)) return "「入住前幾天」不能重複";
    seen.add(d as number);
  }
  const sorted = ([...rules] as { daysBefore: number; refundPct: number }[]).sort((a, b) => b.daysBefore - a.daysBefore);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].refundPct > sorted[i - 1].refundPct) return "離入住越近，退款比例不能比較高";
  }
  return null;
}
