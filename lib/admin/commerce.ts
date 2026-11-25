import { and, asc, eq, ne, sql } from "drizzle-orm";
import { runAtomic } from "@/lib/db/atomic";
import { addons, LOCALES, promoCodes, properties, ratePlans, type CancelPolicy, type I18n } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { validateCancelPolicy } from "@/lib/domain/cancellation";
import { auditStatement } from "./audit";
import type { StaffContext } from "./auth";
import { can } from "./permissions";

/**
 * Staff edits to what is sold and how: add-ons, promo codes, rate plan terms and the property's settings.
 * Every write needs `commerce.edit` at the row's property, is validated in full before anything is written
 * (a field that is not editable is rejected, never ignored), and commits its audit row in the same batch.
 * Prices and stock stay in SiteMinder; `smRatePlanCode`, `sinopacMerchantId` and `smPropertyCode` are read-only.
 */

export type CommerceError =
  | { ok: false; error: "NOT_FOUND" | "FORBIDDEN" | "SLUG_TAKEN" | "CODE_TAKEN" }
  | { ok: false; error: "I18N_INCOMPLETE" | "INVALID_INPUT"; field: string };
export type CommerceResult = { ok: true } | CommerceError;
export type CreateResult = { ok: true; id: string } | CommerceError;

export type AddonUnit = (typeof addons.$inferSelect)["unit"];
export type AddonInput = { slug: string; name: I18n; price: number; unit: AddonUnit; active?: boolean };
export type AddonPatch = Partial<AddonInput>;

export type PromoKind = (typeof promoCodes.$inferSelect)["kind"];
export type PromoInput = {
  code: string; kind: PromoKind; value: number; validFrom?: string | null; validTo?: string | null; maxUses?: number | null; active?: boolean;
};
export type PromoPatch = Partial<PromoInput>;

export type RatePlanPatch = {
  name?: I18n; cancelPolicy?: CancelPolicy; paymentMode?: "full" | "deposit"; depositPct?: number;
  includesBreakfast?: boolean; directOnly?: boolean; active?: boolean;
};

export type PropertyPatch = {
  name?: I18n; address?: I18n; phone?: string; email?: string; checkInTime?: string; checkOutTime?: string; directions?: I18n;
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROMO_CODE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNITS: readonly AddonUnit[] = ["per_stay", "per_night", "per_person_night"];

const invalid = (field: string): CommerceError => ({ ok: false, error: "INVALID_INPUT", field });
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Every locale present and non-blank; values are stored trimmed. */
function i18nOf(v: unknown): I18n | null {
  if (!v || typeof v !== "object") return null;
  const out = {} as I18n;
  for (const l of LOCALES) {
    const s = (v as Record<string, unknown>)[l];
    if (typeof s !== "string" || !s.trim()) return null;
    out[l] = s.trim();
  }
  return out;
}

/** Validates (and trims) the I18n `fields` of `patch` in place; the first incomplete one is the error. */
function checkI18n(patch: Record<string, unknown>, fields: string[]): CommerceError | null {
  for (const f of fields) {
    if (patch[f] === undefined) continue;
    const v = i18nOf(patch[f]);
    if (!v) return { ok: false, error: "I18N_INCOMPLETE", field: f };
    patch[f] = v;
  }
  return null;
}

/** Only the keys that are set, after rejecting any key that may not be edited (read-only or unknown). */
function editable<T extends object>(input: T, allowed: readonly string[]): CommerceError | Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!allowed.includes(k)) return invalid(k);
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}
const isError = (v: object): v is CommerceError => "ok" in v;

const pick = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row[k]]));

/** A real calendar date, YYYY-MM-DD. */
function isDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

/* ------------------------------------------------------------------------------------------------ add-ons */

const ADDON_KEYS = ["slug", "name", "price", "unit", "active"] as const;

function checkAddon(p: AddonPatch): CommerceError | null {
  if (p.slug !== undefined && (typeof p.slug !== "string" || !SLUG.test(p.slug))) return invalid("slug");
  const i18n = checkI18n(p, ["name"]);
  if (i18n) return i18n;
  if (p.price !== undefined && !isInt(p.price, 1, 10_000_000)) return invalid("price");
  if (p.unit !== undefined && !UNITS.includes(p.unit)) return invalid("unit");
  if (p.active !== undefined && typeof p.active !== "boolean") return invalid("active");
  return null;
}

async function addonSlugTaken(db: Db, propertyId: string, slug: string, exceptId?: string): Promise<boolean> {
  const [hit] = await db.select({ id: addons.id }).from(addons)
    .where(and(eq(addons.propertyId, propertyId), eq(addons.slug, slug), exceptId ? ne(addons.id, exceptId) : undefined));
  return !!hit;
}

/** Add an add-on: unique slug, four-language name, positive integer price (TWD), one of three units. */
export async function createAddon(db: Db, ctx: StaffContext, propertyId: string, input: AddonInput, now: Date = new Date()): Promise<CreateResult> {
  if (!can(ctx.staff, "commerce.edit", propertyId)) return { ok: false, error: "FORBIDDEN" };
  const p = editable(input, ADDON_KEYS);
  if (isError(p)) return p;
  for (const k of ["slug", "name", "price", "unit"] as const) if (p[k] === undefined) return invalid(k);
  const bad = checkAddon(p);
  if (bad) return bad;
  if (await addonSlugTaken(db, propertyId, p.slug!)) return { ok: false, error: "SLUG_TAKEN" };
  const row = { id: crypto.randomUUID(), propertyId, active: true, ...p } as typeof addons.$inferInsert;
  await runAtomic(db, [
    db.insert(addons).values(row),
    auditStatement(db, ctx, { action: "addon.create", entity: "addon", entityId: row.id, after: row }, now),
  ]);
  return { ok: true, id: row.id };
}

/** Edit an add-on. "Delete" is `active: false`: bookings keep pointing at the row. */
export async function updateAddon(db: Db, ctx: StaffContext, id: string, input: AddonPatch, now: Date = new Date()): Promise<CommerceResult> {
  const [row] = await db.select().from(addons).where(eq(addons.id, id));
  if (!row) return { ok: false, error: "NOT_FOUND" };
  if (!can(ctx.staff, "commerce.edit", row.propertyId)) return { ok: false, error: "FORBIDDEN" };
  const p = editable(input, ADDON_KEYS);
  if (isError(p)) return p;
  const bad = checkAddon(p);
  if (bad) return bad;
  if (p.slug !== undefined && p.slug !== row.slug && (await addonSlugTaken(db, row.propertyId, p.slug, id))) return { ok: false, error: "SLUG_TAKEN" };
  const keys = Object.keys(p);
  if (keys.length === 0) return { ok: true };
  await runAtomic(db, [
    db.update(addons).set(p).where(eq(addons.id, id)),
    auditStatement(db, ctx, { action: "addon.update", entity: "addon", entityId: id, before: pick(row, keys), after: p }, now),
  ]);
  return { ok: true };
}

/* ------------------------------------------------------------------------------------------- promo codes */

/** `usedCount` is deliberately not here: only a confirmed booking moves it. */
const PROMO_KEYS = ["code", "kind", "value", "validFrom", "validTo", "maxUses", "active"] as const;

/** Checks `p` merged over `base` (the stored row, or defaults on create) and normalises `p.code`. */
function checkPromo(p: PromoPatch, base: Pick<PromoInput, "kind" | "value" | "validFrom" | "validTo">): CommerceError | null {
  if (p.code !== undefined) {
    const code = typeof p.code === "string" ? p.code.trim().toUpperCase() : "";
    if (!PROMO_CODE.test(code)) return invalid("code");
    p.code = code;
  }
  if (p.kind !== undefined && p.kind !== "percent" && p.kind !== "fixed") return invalid("kind");
  const kind = p.kind ?? base.kind;
  const value = p.value ?? base.value;
  if (p.value !== undefined || p.kind !== undefined) {
    if (!(kind === "percent" ? isInt(value, 1, 100) : isInt(value, 1, 10_000_000))) return invalid("value");
  }
  for (const f of ["validFrom", "validTo"] as const) if (p[f] != null && !isDate(p[f])) return invalid(f);
  const from = p.validFrom !== undefined ? p.validFrom : base.validFrom;
  const to = p.validTo !== undefined ? p.validTo : base.validTo;
  if (from && to && from > to) return invalid("validTo");
  if (p.maxUses !== undefined && p.maxUses !== null && !isInt(p.maxUses, 1, 1_000_000)) return invalid("maxUses");
  if (p.active !== undefined && typeof p.active !== "boolean") return invalid("active");
  return null;
}

/** Codes are unique per property ignoring case: legacy rows may still be lower-case, so compare upper(code). */
async function promoCodeTaken(db: Db, propertyId: string, code: string, exceptId?: string): Promise<boolean> {
  const [hit] = await db.select({ id: promoCodes.id }).from(promoCodes)
    .where(and(eq(promoCodes.propertyId, propertyId), eq(sql`upper(${promoCodes.code})`, code), exceptId ? ne(promoCodes.id, exceptId) : undefined));
  return !!hit;
}

/** Add a promo code (stored trimmed and UPPERCASE). Unique per property whatever the case. */
export async function createPromo(db: Db, ctx: StaffContext, propertyId: string, input: PromoInput, now: Date = new Date()): Promise<CreateResult> {
  if (!can(ctx.staff, "commerce.edit", propertyId)) return { ok: false, error: "FORBIDDEN" };
  const p = editable(input, PROMO_KEYS);
  if (isError(p)) return p;
  for (const k of ["code", "kind", "value"] as const) if (p[k] === undefined) return invalid(k);
  const bad = checkPromo(p, { kind: p.kind!, value: p.value!, validFrom: null, validTo: null });
  if (bad) return bad;
  if (await promoCodeTaken(db, propertyId, p.code!)) return { ok: false, error: "CODE_TAKEN" };
  const row = {
    id: crypto.randomUUID(), propertyId, validFrom: null, validTo: null, maxUses: null, usedCount: 0, active: true, ...p,
  } as typeof promoCodes.$inferInsert;
  await runAtomic(db, [
    db.insert(promoCodes).values(row),
    auditStatement(db, ctx, { action: "promo.create", entity: "promo_code", entityId: row.id, after: row }, now),
  ]);
  return { ok: true, id: row.id };
}

/** Edit a promo code. "Delete" is `active: false`: past reservations keep the code they used. */
export async function updatePromo(db: Db, ctx: StaffContext, id: string, input: PromoPatch, now: Date = new Date()): Promise<CommerceResult> {
  const [row] = await db.select().from(promoCodes).where(eq(promoCodes.id, id));
  if (!row) return { ok: false, error: "NOT_FOUND" };
  if (!can(ctx.staff, "commerce.edit", row.propertyId)) return { ok: false, error: "FORBIDDEN" };
  const p = editable(input, PROMO_KEYS);
  if (isError(p)) return p;
  const bad = checkPromo(p, row);
  if (bad) return bad;
  if (p.code !== undefined && (await promoCodeTaken(db, row.propertyId, p.code, id))) return { ok: false, error: "CODE_TAKEN" };
  const keys = Object.keys(p);
  if (keys.length === 0) return { ok: true };
  await runAtomic(db, [
    db.update(promoCodes).set(p).where(eq(promoCodes.id, id)),
    auditStatement(db, ctx, { action: "promo.update", entity: "promo_code", entityId: id, before: pick(row, keys), after: p }, now),
  ]);
  return { ok: true };
}

/* ------------------------------------------------------------------------------------------- rate plans */

/** Not here, on purpose: `smRatePlanCode` (SiteMinder decides it), `slug`, and prices (those live in SiteMinder). */
const RATE_PLAN_KEYS = ["name", "cancelPolicy", "paymentMode", "depositPct", "includesBreakfast", "directOnly", "active"] as const;

/** Edit a rate plan's terms. Rates and stock are changed in SiteMinder, never here. */
export async function updateRatePlan(db: Db, ctx: StaffContext, id: string, input: RatePlanPatch, now: Date = new Date()): Promise<CommerceResult> {
  const [row] = await db.select().from(ratePlans).where(eq(ratePlans.id, id));
  if (!row) return { ok: false, error: "NOT_FOUND" };
  if (!can(ctx.staff, "commerce.edit", row.propertyId)) return { ok: false, error: "FORBIDDEN" };
  const p = editable(input, RATE_PLAN_KEYS);
  if (isError(p)) return p;
  const i18n = checkI18n(p, ["name"]);
  if (i18n) return i18n;
  if (p.cancelPolicy !== undefined) {
    if (validateCancelPolicy(p.cancelPolicy) !== null) return invalid("cancelPolicy");
    // Keep only the known fields, in a stable order.
    p.cancelPolicy = { rules: p.cancelPolicy.rules.map((r) => ({ daysBefore: r.daysBefore, refundPct: r.refundPct })) };
  }
  if (p.paymentMode !== undefined && p.paymentMode !== "full" && p.paymentMode !== "deposit") return invalid("paymentMode");
  if (p.depositPct !== undefined && !isInt(p.depositPct, 0, 100)) return invalid("depositPct");
  const mode = p.paymentMode ?? row.paymentMode;
  const pct = p.depositPct ?? row.depositPct;
  if (mode === "deposit" && !isInt(pct, 1, 99)) return invalid("depositPct");
  if (mode === "full" && p.depositPct !== undefined && p.depositPct > 99) return invalid("depositPct");
  for (const f of ["includesBreakfast", "directOnly", "active"] as const) if (p[f] !== undefined && typeof p[f] !== "boolean") return invalid(f);
  const keys = Object.keys(p);
  if (keys.length === 0) return { ok: true };
  await runAtomic(db, [
    db.update(ratePlans).set(p).where(eq(ratePlans.id, id)),
    auditStatement(db, ctx, { action: "rate_plan.update", entity: "rate_plan", entityId: id, before: pick(row, keys), after: p }, now),
  ]);
  return { ok: true };
}

/* ------------------------------------------------------------------------------------ property settings */

/** Not here, on purpose: `sinopacMerchantId`, `smPropertyCode`, `slug`, `timezone`, `currency` (deploy config). */
const PROPERTY_KEYS = ["name", "address", "phone", "email", "checkInTime", "checkOutTime", "directions"] as const;

/** Edit the property's public details, check-in/out times and directions. */
export async function updateProperty(db: Db, ctx: StaffContext, propertyId: string, input: PropertyPatch, now: Date = new Date()): Promise<CommerceResult> {
  if (!can(ctx.staff, "commerce.edit", propertyId)) return { ok: false, error: "FORBIDDEN" };
  const [row] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (!row) return { ok: false, error: "NOT_FOUND" };
  const p = editable(input, PROPERTY_KEYS);
  if (isError(p)) return p;
  const i18n = checkI18n(p, ["name", "address", "directions"]);
  if (i18n) return i18n;
  for (const f of ["phone", "email"] as const) {
    if (p[f] === undefined) continue;
    const v = typeof p[f] === "string" ? p[f].trim() : "";
    if (!v || v.length > 100 || (f === "email" && !EMAIL.test(v))) return invalid(f);
    p[f] = v;
  }
  for (const f of ["checkInTime", "checkOutTime"] as const) if (p[f] !== undefined && (typeof p[f] !== "string" || !HHMM.test(p[f]))) return invalid(f);
  const keys = Object.keys(p);
  if (keys.length === 0) return { ok: true };
  await runAtomic(db, [
    db.update(properties).set(p).where(eq(properties.id, propertyId)),
    auditStatement(db, ctx, { action: "property.update", entity: "property", entityId: propertyId, before: pick(row, keys), after: p }, now),
  ]);
  return { ok: true };
}

/* ------------------------------------------------------------------------------------------- admin reads */

export const listAddonsForAdmin = (db: Db, propertyId: string) =>
  db.select().from(addons).where(eq(addons.propertyId, propertyId)).orderBy(asc(addons.slug));

export const listPromosForAdmin = (db: Db, propertyId: string) =>
  db.select().from(promoCodes).where(eq(promoCodes.propertyId, propertyId)).orderBy(asc(promoCodes.code));

export const listRatePlansForAdmin = (db: Db, propertyId: string) =>
  db.select().from(ratePlans).where(eq(ratePlans.propertyId, propertyId)).orderBy(asc(ratePlans.slug));

export async function getPropertyForAdmin(db: Db, propertyId: string) {
  const [row] = await db.select().from(properties).where(eq(properties.id, propertyId));
  return row ?? null;
}
