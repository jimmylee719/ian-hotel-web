import { and, eq, inArray, like, ne, sql, type SQL } from "drizzle-orm";
import { payments } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/**
 * THE money vocabulary. Every figure about a reservation's money comes from here, with one meaning each:
 * - onlineNet: succeeded online charges minus succeeded refunds. The only money the gateway can refund.
 * - frontDeskNet: succeeded front_desk payments (card terminal, cash, transfer; a voided one is failed).
 *   Never refunded through the gateway: the desk hands it back.
 * - received: onlineNet + frontDeskNet (NET of refunds). What guests, staff and SiteMinder see as paid, and
 *   what the balance due and the cancellation policy are computed from.
 * - grossReceived: charges + front-desk payments before refunds. Display only (已收款（退款前）).
 * - refunded: succeeded refunds.
 * Only succeeded rows of MONEY_KINDS count; preauth/capture and pending/failed rows never do.
 */

/** Payment kinds that move money in (card charge, front-desk) or out (refund). */
export const MONEY_KINDS = ["charge", "front_desk", "refund"] as const;
type MoneyKind = (typeof MONEY_KINDS)[number];

/** Effect of one succeeded payment on `received`: refunds subtract. */
export const netDelta = (kind: string, amount: number): number => (kind === "refund" ? -amount : amount);

export type MoneyMetrics = {
  onlineNet: number;
  frontDeskNet: number;
  /** onlineNet + frontDeskNet. */
  received: number;
  /** Before refunds; display only. */
  grossReceived: number;
  refunded: number;
};

export const EMPTY_METRICS: MoneyMetrics = { onlineNet: 0, frontDeskNet: 0, received: 0, grossReceived: 0, refunded: 0 };

/** The one fold: succeeded MONEY_KINDS rows (of one reservation; amounts may be per-kind sums) into metrics. */
export function summarizeMoney(rows: { kind: string; amount: number }[]): MoneyMetrics {
  let onlineNet = 0;
  let frontDeskNet = 0;
  let refunded = 0;
  for (const r of rows) {
    if (r.kind === "front_desk") frontDeskNet += r.amount;
    else if (r.kind === "charge") onlineNet += r.amount;
    else if (r.kind === "refund") { onlineNet -= r.amount; refunded += r.amount; }
  }
  const received = onlineNet + frontDeskNet;
  return { onlineNet, frontDeskNet, received, grossReceived: received + refunded, refunded };
}

/** What is still owed on a reservation: its total minus what was received. Negative when overpaid. */
export const balanceDue = (total: number, m: MoneyMetrics): number => total - m.received;

/**
 * What the guest is owed back on a live booking: received beyond its total. Desk payments cannot overpay and
 * online overpayments are refunded, so this is what a price-lowering staff modification left for the front
 * desk to hand back (the booking's frontDeskRefundDue is kept equal to it). A cancel never applies its policy
 * to this money: it is the guest's already.
 */
export const owedBack = (total: number, m: MoneyMetrics): number => Math.max(0, m.received - total);

/**
 * SQL subquery: a refund of one of the booking's staff modifications (`modify:<id>:<n>`) that has not succeeded.
 * While one exists the booking's money is in motion: no further modification, and no cancel, may start.
 */
export const unsettledModifyRefund = (reservationId: string): SQL =>
  sql`select 1 from ${payments} where ${payments.reservationId} = ${reservationId} and ${payments.kind} = 'refund'
    and ${payments.idempotencyKey} like ${`modify:${reservationId}:%`} and ${payments.status} <> 'succeeded'`;

/** Whether the booking has an unsettled modification refund (see unsettledModifyRefund). */
export async function modifyRefundPending(db: Db, reservationId: string): Promise<boolean> {
  const rows = await db.select({ id: payments.id }).from(payments).where(and(
    eq(payments.reservationId, reservationId), eq(payments.kind, "refund"),
    like(payments.idempotencyKey, `modify:${reservationId}:%`), ne(payments.status, "succeeded"),
  )).limit(1);
  return rows.length > 0;
}

/** SQL twin of `summarizeMoney().received`, for aggregation: which rows count ... */
export const countsAsReceived: SQL = and(eq(payments.status, "succeeded"), inArray(payments.kind, MONEY_KINDS as unknown as MoneyKind[]))!;
/** ... and their sum (use with `countsAsReceived` and a GROUP BY, or via `receivedOf`). */
export const receivedSum: SQL<number> = sql<number>`coalesce(sum(case when ${payments.kind} = 'refund' then -${payments.amount} else ${payments.amount} end), 0)`;

/** SQL scalar: `received` of one reservation (a value or a column). Used inside guarded batch writes. */
export const receivedOf = (reservationId: string | SQL): SQL<number> =>
  sql<number>`(select ${receivedSum} from ${payments} where ${payments.reservationId} = ${reservationId} and ${countsAsReceived})`;

/** Statuses whose booking owes nothing, whatever its payment history says. */
export const CLOSED_STATUSES: readonly string[] = ["cancelled", "expired", "confirm_failed_refunded"];

export type DisplayMoney = {
  /** received: what the 已收（淨額）figure shows everywhere. */
  paid: number;
  refunded: number;
  /** What is still owed; null (shown as "—") for closed bookings. */
  balanceDue: number | null;
};

/** The one rule for the money figures staff see: list, detail and guest pages all go through here. */
export function displayMoney(status: string, total: number, m: MoneyMetrics): DisplayMoney {
  return { paid: m.received, refunded: m.refunded, balanceDue: CLOSED_STATUSES.includes(status) ? null : balanceDue(total, m) };
}

/** Metrics per reservation id, from succeeded payments only. Ids with none map to zeros. Keep `ids` to a page's worth. */
export async function moneyByReservation(db: Db, ids: string[]): Promise<Map<string, MoneyMetrics>> {
  const out = new Map<string, MoneyMetrics>(ids.map((id) => [id, EMPTY_METRICS]));
  if (ids.length === 0) return out;
  const rows = await db.select({
    id: payments.reservationId, kind: payments.kind, amount: sql<number>`sum(${payments.amount})`,
  }).from(payments)
    .where(and(inArray(payments.reservationId, ids), countsAsReceived))
    .groupBy(payments.reservationId, payments.kind);
  const byId = new Map<string, { kind: string; amount: number }[]>();
  for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), { kind: r.kind, amount: Number(r.amount) }]);
  for (const [id, list] of byId) out.set(id, summarizeMoney(list));
  return out;
}

/** Metrics of one reservation. */
export async function moneyOf(db: Db, reservationId: string): Promise<MoneyMetrics> {
  return (await moneyByReservation(db, [reservationId])).get(reservationId)!;
}

/** onlineNet of one reservation: what the gateway holds and can refund. Payment checks and refunds use this. */
export async function onlineNetAmount(db: Db, reservationId: string): Promise<number> {
  return (await moneyOf(db, reservationId)).onlineNet;
}

/** received of one reservation. Displays, emails ("已付金額") and SiteMinder use this. */
export async function receivedAmount(db: Db, reservationId: string): Promise<number> {
  return (await moneyOf(db, reservationId)).received;
}
