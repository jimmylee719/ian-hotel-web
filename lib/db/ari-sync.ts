import { eq, sql, type SQL } from "drizzle-orm";
import type { AriUpdate } from "@/lib/channel/types";
import { rawStatement, runAtomic, type Runnable } from "./atomic";
import { ratePlans, unitTypes } from "./schema";
import type { Db } from "./types";

/**
 * Statements per D1 batch (one batch is one implicit transaction). The SiteMinder handler caps a message so all of
 * it fits one batch (lib/channel/siteminder/inbound/ari.ts ARI_MAX_ROWS); only a larger call is split.
 */
export const ARI_BATCH_STATEMENTS = 100;
/**
 * Day rows per statement. Rows go in as one JSON parameter (json_each), not as bound values: D1 allows 100 bound
 * parameters per query and 1000 queries per Worker invocation (Workers Paid; 50 on Free), so one statement per
 * day (210 days × 8 room types = 1680) would not fit, and 10-column rows would fit 10 to a statement. 500 rows of
 * ~120 bytes keep each parameter near 60 KB, well under D1's 2 MB value limit.
 */
export const ARI_ROWS_PER_STATEMENT = 500;

export type Rejected = { smRoomCode: string; smRatePlanCode?: string; date: string; reason: "INVALID_VALUE" | "NO_RATE_PLAN" };

const nonNegInt = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 0);
const posInt = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) > 0);
const posIntOrNull = (v: unknown) => v === null || posInt(v);
const isValid = (u: AriUpdate) =>
  /^\d{4}-\d{2}-\d{2}$/.test(u.date) && nonNegInt(u.available) && posInt(u.price) && posInt(u.minStay)
  && posIntOrNull(u.maxStay) && posIntOrNull(u.minStayThrough) && posIntOrNull(u.maxStayThrough);

/** Restriction fields → their short key in the JSON rows (see the UPDATE below). */
const RESTRICTIONS = {
  stopSell: "ss", closedToArrival: "cta", closedToDeparture: "ctd",
  minStay: "mn", maxStay: "mx", minStayThrough: "mnt", maxStayThrough: "mxt",
} as const satisfies Partial<Record<keyof AriUpdate, string>>;
type RestrictionKey = (typeof RESTRICTIONS)[keyof typeof RESTRICTIONS];

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export type ApplyAriOptions = {
  /**
   * The message's ordering time (epoch ms). A day's availability / price / restrictions are written only when this
   * is ≥ the time stored with them (their last writer's), so an older message never overwrites a newer one.
   * Default `now`.
   */
  sourceTs?: number;
  /** Statements to commit in the same transaction as the ARI (e.g. the message log row). */
  extra?: Runnable[];
};

/**
 * Apply SiteMinder ARI to the local cache. Only fields present in an update are overwritten (`null` clears a max /
 * Stay Through limit). Availability goes to the per-room-type inventory and needs no rate plan (doc §4.1: room-type
 * level, RatePlanCode ignored); price and restrictions go to the per-(room type, rate plan) table.
 * - A rate row created by restrictions alone has price 0, which is never sold (lib/domain/availability.ts), so
 *   restrictions that arrive before the rates (as SiteMinder sends them [RATES]) are kept and nothing becomes free.
 * - Ordering per day and per kind (availability / price / restrictions are three separate timestamps, because
 *   availability-and-restrictions and rates are separate SiteMinder messages): see `sourceTs`. A row ignored as
 *   older still counts in `applied` (it was valid and its codes known).
 * - Unknown codes and invalid rows are skipped and reported (callers that must reject a whole message, like the
 *   SiteMinder endpoint, validate first). Everything else is written in one transaction when it fits one batch.
 */
export async function applyAriUpdates(db: Db, propertyId: string, updates: AriUpdate[], now: Date, opts: ApplyAriOptions = {}) {
  const [types, plans] = await Promise.all([
    db.select({ id: unitTypes.id, code: unitTypes.smRoomCode }).from(unitTypes).where(eq(unitTypes.propertyId, propertyId)),
    db.select({ id: ratePlans.id, code: ratePlans.smRatePlanCode }).from(ratePlans).where(eq(ratePlans.propertyId, propertyId)),
  ]);
  const room = new Map(types.filter((t) => t.code).map((t) => [t.code!, t.id]));
  const plan = new Map(plans.filter((p) => p.code).map((p) => [p.code!, p.id]));

  const unknown = new Set<string>();
  const rejected: Rejected[] = [];
  const inv = new Map<string, { u: string; d: string; a: number }>();
  const price = new Map<string, { u: string; r: string; d: string; p: number }>();
  const restr = new Map<string, { u: string; r: string; d: string } & Partial<Record<RestrictionKey, number | boolean | null>>>();
  let applied = 0;

  for (const u of updates) {
    const unitTypeId = room.get(u.smRoomCode);
    if (!unitTypeId) {
      unknown.add(u.smRoomCode);
      continue;
    }
    const needsPlan = u.price !== undefined || Object.keys(RESTRICTIONS).some((f) => u[f as keyof AriUpdate] !== undefined);
    const ratePlanId = u.smRatePlanCode !== undefined ? plan.get(u.smRatePlanCode) : undefined;
    if (needsPlan && u.smRatePlanCode !== undefined && !ratePlanId) {
      unknown.add(u.smRatePlanCode);
      continue;
    }
    if (!isValid(u)) {
      rejected.push({ smRoomCode: u.smRoomCode, smRatePlanCode: u.smRatePlanCode, date: u.date, reason: "INVALID_VALUE" });
      continue;
    }
    if (needsPlan && !ratePlanId) {
      rejected.push({ smRoomCode: u.smRoomCode, date: u.date, reason: "NO_RATE_PLAN" });
      continue;
    }

    if (u.available !== undefined) inv.set(`${unitTypeId}|${u.date}`, { u: unitTypeId, d: u.date, a: u.available });
    if (ratePlanId) {
      const k = `${unitTypeId}|${ratePlanId}|${u.date}`;
      if (u.price !== undefined) price.set(k, { u: unitTypeId, r: ratePlanId, d: u.date, p: u.price });
      const fields = Object.entries(RESTRICTIONS).filter(([f]) => u[f as keyof AriUpdate] !== undefined);
      if (fields.length) {
        const row = restr.get(k) ?? { u: unitTypeId, r: ratePlanId, d: u.date };
        for (const [f, key] of fields) row[key] = u[f as keyof AriUpdate] as number | boolean | null;
        restr.set(k, row);
      }
    }
    applied++;
  }

  const ts = opts.sourceTs ?? now.getTime();
  const at = now.getTime();
  const stmts: Runnable[] = [];
  const add = (q: SQL) => stmts.push(rawStatement(db, q));

  for (const rows of chunks([...inv.values()], ARI_ROWS_PER_STATEMENT))
    add(sql`INSERT INTO inventory_daily (property_id, unit_type_id, date, available, source, synced_at, source_ts)
      SELECT ${propertyId}, json_extract(j.value, '$.u'), json_extract(j.value, '$.d'), json_extract(j.value, '$.a'), 'siteminder', ${at}, ${ts}
      FROM json_each(${JSON.stringify(rows)}) AS j WHERE true
      ON CONFLICT (unit_type_id, date) DO UPDATE SET available = excluded.available, source = 'siteminder', synced_at = excluded.synced_at, source_ts = excluded.source_ts
      WHERE inventory_daily.source_ts IS NULL OR inventory_daily.source_ts <= excluded.source_ts`);

  for (const rows of chunks([...price.values()], ARI_ROWS_PER_STATEMENT))
    add(sql`INSERT INTO ari_daily (property_id, unit_type_id, rate_plan_id, date, price, source, synced_at, price_source_ts)
      SELECT ${propertyId}, json_extract(j.value, '$.u'), json_extract(j.value, '$.r'), json_extract(j.value, '$.d'), json_extract(j.value, '$.p'), 'siteminder', ${at}, ${ts}
      FROM json_each(${JSON.stringify(rows)}) AS j WHERE true
      ON CONFLICT (unit_type_id, rate_plan_id, date) DO UPDATE SET price = excluded.price, source = 'siteminder', synced_at = excluded.synced_at, price_source_ts = excluded.price_source_ts
      WHERE ari_daily.price_source_ts IS NULL OR ari_daily.price_source_ts <= excluded.price_source_ts`);

  // A field absent from a row's JSON (json_type NULL) keeps its value; JSON null clears it (the nullable limits).
  const keep = (col: string, key: RestrictionKey) =>
    sql.raw(`${col} = CASE WHEN json_type(j.value, '$.${key}') IS NULL THEN ${col} ELSE json_extract(j.value, '$.${key}') END`);
  for (const rows of chunks([...restr.values()], ARI_ROWS_PER_STATEMENT)) {
    const json = JSON.stringify(rows);
    add(sql`INSERT INTO ari_daily (property_id, unit_type_id, rate_plan_id, date, price, source, synced_at)
      SELECT ${propertyId}, json_extract(j.value, '$.u'), json_extract(j.value, '$.r'), json_extract(j.value, '$.d'), 0, 'siteminder', ${at}
      FROM json_each(${json}) AS j WHERE true
      ON CONFLICT (unit_type_id, rate_plan_id, date) DO NOTHING`);
    add(sql`UPDATE ari_daily SET ${keep("stop_sell", "ss")}, ${keep("closed_to_arrival", "cta")}, ${keep("closed_to_departure", "ctd")},
        ${keep("min_stay", "mn")}, ${keep("max_stay", "mx")}, ${keep("min_stay_through", "mnt")}, ${keep("max_stay_through", "mxt")},
        source = 'siteminder', synced_at = ${at}, restrictions_source_ts = ${ts}
      FROM json_each(${json}) AS j
      WHERE ari_daily.unit_type_id = json_extract(j.value, '$.u') AND ari_daily.rate_plan_id = json_extract(j.value, '$.r')
        AND ari_daily.date = json_extract(j.value, '$.d')
        AND (ari_daily.restrictions_source_ts IS NULL OR ari_daily.restrictions_source_ts <= ${ts})`);
  }

  stmts.push(...(opts.extra ?? []));
  for (const batch of chunks(stmts, ARI_BATCH_STATEMENTS)) await runAtomic(db, batch);
  return { applied, unknownCodes: [...unknown], rejected };
}
