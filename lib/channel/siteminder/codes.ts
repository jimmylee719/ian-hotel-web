import { and, eq, isNull, or } from "drizzle-orm";
import { properties, ratePlans, unitTypes } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/**
 * Our SiteMinder codes: HotelCode (properties.smPropertyCode), RoomTypeCode (unit_types.smRoomCode) and RatePlanCode
 * (rate_plans.smRatePlanCode). They are OURS, not SiteMinder's (docs/integrations/siteminder.md §8.1): SiteMinder
 * pulls them with Rooms and Rates and the hotel maps them once. Changing one breaks that mapping ([RR]), so a code
 * is written once (here, or by migration 0024's backfill, which uses the same rule in SQL) and never edited.
 *
 * Format: the slug, upper-cased, with everything but A–Z and 0–9 dropped (slugs are [a-z0-9-], so: hyphens
 * removed), at most SM_CODE_MAX characters ("buddy-room-six" → "BUDDYROOMSIX"). Unique within the property (the
 * HotelCode across all properties); a clash gets a numeric suffix inside the length limit ("…2", "…3").
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

/** Codes for `rows` whose code is missing, in slug order (deterministic), avoiding every code already held. */
function assign<T extends { id: string; slug: string; code: string | null }>(rows: T[]): { id: string; code: string }[] {
  const taken = new Set(rows.map((r) => r.code).filter((c): c is string => !missing(c)));
  const out: { id: string; code: string }[] = [];
  for (const r of [...rows].filter((x) => missing(x.code)).sort((a, b) => a.slug.localeCompare(b.slug))) {
    const code = uniqueSmCode(r.slug, taken);
    taken.add(code);
    out.push({ id: r.id, code });
  }
  return out;
}

/**
 * Give every property, room type and rate plan without a code its code (existing codes are never touched).
 * Seeding calls it for new rows; it also covers rows migration 0024 skipped because two slugs map to one code.
 * Returns how many codes were written.
 */
export async function fillMissingSmCodes(db: Db): Promise<number> {
  let written = 0;
  const props = await db.select({ id: properties.id, slug: properties.slug, code: properties.smPropertyCode }).from(properties);
  for (const a of assign(props)) {
    await db.update(properties).set({ smPropertyCode: a.code })
      .where(and(eq(properties.id, a.id), or(isNull(properties.smPropertyCode), eq(properties.smPropertyCode, ""))));
    written++;
  }
  for (const p of props) {
    const rooms = await db.select({ id: unitTypes.id, slug: unitTypes.slug, code: unitTypes.smRoomCode }).from(unitTypes)
      .where(eq(unitTypes.propertyId, p.id));
    for (const a of assign(rooms)) {
      await db.update(unitTypes).set({ smRoomCode: a.code })
        .where(and(eq(unitTypes.id, a.id), or(isNull(unitTypes.smRoomCode), eq(unitTypes.smRoomCode, ""))));
      written++;
    }
    const plans = await db.select({ id: ratePlans.id, slug: ratePlans.slug, code: ratePlans.smRatePlanCode }).from(ratePlans)
      .where(eq(ratePlans.propertyId, p.id));
    for (const a of assign(plans)) {
      await db.update(ratePlans).set({ smRatePlanCode: a.code })
        .where(and(eq(ratePlans.id, a.id), or(isNull(ratePlans.smRatePlanCode), eq(ratePlans.smRatePlanCode, ""))));
      written++;
    }
  }
  return written;
}
