import { and, eq, inArray, sql } from "drizzle-orm";
import { payments } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/** Payment kinds that move money in (card charge, front-desk) or out (refund). Preauth/capture are not counted. */
export const MONEY_KINDS = ["charge", "front_desk", "refund"] as const;
type MoneyKind = (typeof MONEY_KINDS)[number];

/** Effect of one succeeded payment on the money held: refunds subtract. */
export const netDelta = (kind: string, amount: number): number => (kind === "refund" ? -amount : amount);

export type MoneyMetrics = {
  /** Gross money received: succeeded charges and front-desk payments. */
  paid: number;
  /** Money returned: succeeded refunds. */
  refunded: number;
  /** paid - refunded. */
  net: number;
};

export const EMPTY_METRICS: MoneyMetrics = { paid: 0, refunded: 0, net: 0 };

/** What is still owed on a reservation: its total minus the net received. Negative when overpaid. */
export const balanceDue = (total: number, m: MoneyMetrics): number => total - m.net;

/** Fold succeeded payment rows (of one reservation) into metrics. */
export function summarizeMoney(rows: { kind: string; amount: number }[]): MoneyMetrics {
  let paid = 0;
  let refunded = 0;
  for (const r of rows) {
    if (r.kind === "refund") refunded += r.amount;
    else paid += r.amount;
  }
  return { paid, refunded, net: paid - refunded };
}

/** Metrics per reservation id, from succeeded payments only. Ids with none map to zeros. Keep `ids` to a page's worth. */
export async function moneyByReservation(db: Db, ids: string[]): Promise<Map<string, MoneyMetrics>> {
  const out = new Map<string, MoneyMetrics>(ids.map((id) => [id, EMPTY_METRICS]));
  if (ids.length === 0) return out;
  const rows = await db.select({
    id: payments.reservationId, kind: payments.kind, amount: sql<number>`sum(${payments.amount})`,
  }).from(payments)
    .where(and(inArray(payments.reservationId, ids), eq(payments.status, "succeeded"), inArray(payments.kind, MONEY_KINDS as unknown as MoneyKind[])))
    .groupBy(payments.reservationId, payments.kind);
  const byId = new Map<string, { kind: string; amount: number }[]>();
  for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), { kind: r.kind, amount: Number(r.amount) }]);
  for (const [id, list] of byId) out.set(id, summarizeMoney(list));
  return out;
}
