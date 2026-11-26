import { and, eq, isNull, or } from "drizzle-orm";
import { properties, ratePlans, unitTypes } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/**
 * Our SiteMinder codes: HotelCode (properties.smPropertyCode), RoomTypeCode (unit_types.smRoomCode) and RatePlanCode
 * (rate_plans.smRatePlanCode). They are OURS, not SiteMinder's (docs/integrations/siteminder.md §8.1): SiteMinder
 * pulls them with Rooms and Rates and the hotel maps them once. Changing one breaks that mapping ([RR]), so a code
 * is written once and never edited. Who writes it:
 * - migration 0024 (SQL, existing databases): every row whose derived code clashes with no other row's;
 * - seedNk (new and existing databases it runs on) and scripts/fill-sm-codes.ts (remote databases) through
 *   planSmCodes: every row still without a code, clashes included (they get a suffix).
 *
 * Format: the slug, upper-cased, with everything but A–Z and 0–9 dropped, at most SM_CODE_MAX characters
 * ("buddy-room-six" → "BUDDYROOMSIX"). Unique within the property (the HotelCode across all properties); a clash
 * gets a numeric suffix inside the length limit ("…2", "…3").
 * Migration 0024's SQL (UPPER(SUBSTR(REPLACE(slug,'-',''),1,16))) only removes hyphens: it equals smCodeFromSlug for
 * slugs of [a-z0-9-], which is every slug admin and seeding allow. A slug with other characters (none exist) would
 * get a different code from the SQL; that code is still kept once written.
 *
 * SITEMINDER-OPEN-Q16: the SiteConnect pages give no allowed characters or length for these codes. We stay inside
 * the strictest rule the docs give for any identifier (UniqueID: alphanumeric only) and OTA's StringLength1to16
 * (HotelCode, RoomTypeCode). If SiteMinder answers differently, change SM_CODE_MAX / smCodeFromSlug (and the SQL
 * in drizzle/migrations/0024_siteminder_codes.sql, for databases not yet migrated) — nothing else.
 */
export const SM_CODE_MAX = 16;

/** The code a slug gets when nothing else in its scope holds it. */
export function smCodeFromSlug(slug: string): string {
  const base = slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, SM_CODE_MAX);
  return base || "X";
}

/** A well-formed code: 1–SM_CODE_MAX of A–Z / 0–9. */
export const isSmCode = (code: string): boolean => new RegExp(`^[A-Z0-9]{1,${SM_CODE_MAX}}$`).test(code);

/** smCodeFromSlug, or (when `taken` holds it) the same base with the smallest numeric suffix ≥ 2 that is free. */
export function uniqueSmCode(slug: string, taken: ReadonlySet<string>): string {
  const base = smCodeFromSlug(slug);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, SM_CODE_MAX - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

const missing = (code: string | null): boolean => code === null || code === "";

type Row = { id: string; slug: string; code: string | null };
type ScopedRow = Row & { propertyId: string };
export type CodeTable = "properties" | "unit_types" | "rate_plans";
export type CodeUpdate = { table: CodeTable; id: string; code: string };

/** Codes for `rows` whose code is missing, in slug order (deterministic), avoiding every code already held. */
function assign(table: CodeTable, rows: Row[]): CodeUpdate[] {
  const taken = new Set(rows.map((r) => r.code).filter((c): c is string => !missing(c)));
  const out: CodeUpdate[] = [];
  for (const r of [...rows].filter((x) => missing(x.code)).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
    const code = uniqueSmCode(r.slug, taken);
    taken.add(code);
    out.push({ table, id: r.id, code });
  }
  return out;
}

/** Every code to write for rows without one (existing codes are never changed). Pure: used by the DB and the script. */
export function planSmCodes(rows: { properties: Row[]; unitTypes: ScopedRow[]; ratePlans: ScopedRow[] }): CodeUpdate[] {
  const byProperty = (xs: ScopedRow[]) => {
    const m = new Map<string, ScopedRow[]>();
    for (const x of xs) m.set(x.propertyId, [...(m.get(x.propertyId) ?? []), x]);
    return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  };
  return [
    ...assign("properties", rows.properties),
    ...byProperty(rows.unitTypes).flatMap((xs) => assign("unit_types", xs)),
    ...byProperty(rows.ratePlans).flatMap((xs) => assign("rate_plans", xs)),
  ];
}

const COLUMN: Record<CodeTable, string> = { properties: "sm_property_code", unit_types: "sm_room_code", rate_plans: "sm_rate_plan_code" };
const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** The plan as SQL, each UPDATE guarded so it never overwrites a code written meanwhile. */
export const smCodeUpdatesSql = (plan: CodeUpdate[]): string[] =>
  plan.map((u) => `UPDATE ${u.table} SET ${COLUMN[u.table]} = ${sqlString(u.code)} WHERE id = ${sqlString(u.id)} AND (${COLUMN[u.table]} IS NULL OR ${COLUMN[u.table]} = '');`);

/**
 * Give every property, room type and rate plan without a code its code (existing codes are never touched).
 * Returns how many codes were written.
 */
export async function fillMissingSmCodes(db: Db): Promise<number> {
  const [props, rooms, plans] = await Promise.all([
    db.select({ id: properties.id, slug: properties.slug, code: properties.smPropertyCode }).from(properties),
    db.select({ id: unitTypes.id, slug: unitTypes.slug, code: unitTypes.smRoomCode, propertyId: unitTypes.propertyId }).from(unitTypes),
    db.select({ id: ratePlans.id, slug: ratePlans.slug, code: ratePlans.smRatePlanCode, propertyId: ratePlans.propertyId }).from(ratePlans),
  ]);
  const plan = planSmCodes({ properties: props, unitTypes: rooms, ratePlans: plans });
  for (const u of plan) {
    if (u.table === "properties")
      await db.update(properties).set({ smPropertyCode: u.code })
        .where(and(eq(properties.id, u.id), or(isNull(properties.smPropertyCode), eq(properties.smPropertyCode, ""))));
    else if (u.table === "unit_types")
      await db.update(unitTypes).set({ smRoomCode: u.code })
        .where(and(eq(unitTypes.id, u.id), or(isNull(unitTypes.smRoomCode), eq(unitTypes.smRoomCode, ""))));
    else
      await db.update(ratePlans).set({ smRatePlanCode: u.code })
        .where(and(eq(ratePlans.id, u.id), or(isNull(ratePlans.smRatePlanCode), eq(ratePlans.smRatePlanCode, ""))));
  }
  return plan.length;
}
