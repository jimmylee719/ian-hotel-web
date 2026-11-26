import { and, asc, desc, eq, ne } from "drizzle-orm";
import { runAtomic } from "@/lib/db/atomic";
import { contentPages, faqs, LOCALES, news, unitTypes, type I18n } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { isValidMediaKey } from "@/lib/media";
import { auditStatement } from "./audit";
import type { StaffContext } from "./auth";
import { can } from "./permissions";

/**
 * Staff edits to the public site's content: room types (four-language text, numbers, photos), news,
 * FAQs and content pages. Every write needs `content.edit` at the row's property, is validated in full
 * before anything is written, and commits its audit row in the same batch. Public pages read straight
 * from these tables on every request (lib/content-repo.ts), so an edit shows at once.
 */

/** What the R2 binding needs for photo checks (a fake in tests). */
export type MediaHead = { head(key: string): Promise<unknown | null> };

export type ContentError =
  | { ok: false; error: "NOT_FOUND" | "FORBIDDEN" | "SLUG_TAKEN" }
  | { ok: false; error: "I18N_INCOMPLETE" | "INVALID_INPUT"; field: string }
  | { ok: false; error: "IMAGE_NOT_FOUND"; key: string };
export type ContentResult = { ok: true } | ContentError;
export type CreateResult = { ok: true; id: string } | ContentError;

export type UnitTypePatch = {
  name?: I18n;
  description?: I18n;
  bedType?: I18n;
  amenities?: string[];
  sizeSqm?: number | null;
  maxAdults?: number;
  maxOccupancy?: number;
  sortOrder?: number;
  active?: boolean;
  images?: string[];
};

export type ContentItemInput = { slug: string; title: I18n; body: I18n; publishedAt: number | null; sortOrder?: number };
export type ContentItemPatch = Partial<ContentItemInput>;

export const MAX_IMAGES = 40;
export const MAX_AMENITIES = 60;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

const invalid = (field: string): ContentError => ({ ok: false, error: "INVALID_INPUT", field });
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Every locale present and non-blank. Values are stored trimmed. */
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

/** Validates the I18n fields of `patch` in place (trimming them); the first incomplete field is the error. */
function checkI18n<T extends object>(patch: T, fields: (keyof T & string)[]): ContentError | null {
  for (const f of fields) {
    if (patch[f] === undefined) continue;
    const v = i18nOf(patch[f]);
    if (!v) return { ok: false, error: "I18N_INCOMPLETE", field: f };
    (patch as Record<string, unknown>)[f] = v;
  }
  return null;
}

/** Only the keys that are set (an explicit `null` counts). */
const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

const pick = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row[k]]));

/**
 * Update a room type. All four languages of each I18n field must be non-blank, `maxOccupancy` is at least
 * `maxAdults`, and every photo key must already be in R2 (`media.head`). The audit row records the before
 * and after of the fields in the patch.
 */
export async function updateUnitType(
  db: Db, ctx: StaffContext, id: string, input: UnitTypePatch, media: MediaHead, now: Date = new Date(),
): Promise<ContentResult> {
  const [row] = await db.select().from(unitTypes).where(eq(unitTypes.id, id));
  if (!row) return { ok: false, error: "NOT_FOUND" };
  if (!can(ctx.staff, "content.edit", row.propertyId)) return { ok: false, error: "FORBIDDEN" };

  // Our SiteMinder RoomTypeCode is written once (lib/channel/siteminder/codes.ts); changing it breaks the hotel's mapping.
  if ("smRoomCode" in input) return invalid("smRoomCode");
  const patch = defined({ ...input });
  const i18nError = checkI18n(patch, ["name", "description", "bedType"]);
  if (i18nError) return i18nError;

  if (patch.amenities !== undefined) {
    if (!Array.isArray(patch.amenities) || patch.amenities.length > MAX_AMENITIES
      || !patch.amenities.every((a) => typeof a === "string" && a.trim() && a.length <= 100)) return invalid("amenities");
    patch.amenities = patch.amenities.map((a) => a.trim());
  }
  if (patch.sizeSqm !== undefined && patch.sizeSqm !== null && !isInt(patch.sizeSqm, 1, 10_000)) return invalid("sizeSqm");
  if (patch.maxAdults !== undefined && !isInt(patch.maxAdults, 1, 50)) return invalid("maxAdults");
  if (patch.maxOccupancy !== undefined && !isInt(patch.maxOccupancy, 1, 50)) return invalid("maxOccupancy");
  if ((patch.maxOccupancy ?? row.maxOccupancy) < (patch.maxAdults ?? row.maxAdults)) return invalid("maxOccupancy");
  if (patch.sortOrder !== undefined && !isInt(patch.sortOrder, -10_000, 10_000)) return invalid("sortOrder");
  if (patch.active !== undefined && typeof patch.active !== "boolean") return invalid("active");
  if (patch.images !== undefined) {
    const images = patch.images;
    if (!Array.isArray(images) || images.length > MAX_IMAGES || new Set(images).size !== images.length
      || !images.every((k) => typeof k === "string" && isValidMediaKey(k))) return invalid("images");
    for (const key of images) if (!(await media.head(key))) return { ok: false, error: "IMAGE_NOT_FOUND", key };
  }

  const keys = Object.keys(patch);
  if (keys.length === 0) return { ok: true };
  await runAtomic(db, [
    db.update(unitTypes).set(patch).where(eq(unitTypes.id, id)),
    auditStatement(db, ctx, {
      action: "unit_type.update", entity: "unit_type", entityId: id, before: pick(row, keys), after: patch,
    }, now),
  ]);
  return { ok: true };
}

type ContentTable = typeof contentPages | typeof news | typeof faqs;
export type Kind = "news" | "faq" | "page";
const TABLES: Record<Kind, ContentTable> = { news, faq: faqs, page: contentPages };

/** Validates a create input or update patch; returns the cleaned fields or the error. */
function checkItem(patch: ContentItemPatch): ContentError | ContentItemPatch {
  const p = defined({ ...patch });
  if (p.slug !== undefined && (typeof p.slug !== "string" || !SLUG.test(p.slug))) return invalid("slug");
  const i18nError = checkI18n(p, ["title", "body"]);
  if (i18nError) return i18nError;
  if (p.publishedAt !== undefined && p.publishedAt !== null && !isInt(p.publishedAt, 0, 8.64e15)) return invalid("publishedAt");
  if (p.sortOrder !== undefined && !isInt(p.sortOrder, -10_000, 10_000)) return invalid("sortOrder");
  return p;
}

const isError = (v: ContentError | ContentItemPatch): v is ContentError => "ok" in v;

async function slugTaken(db: Db, table: ContentTable, propertyId: string, slug: string, exceptId?: string): Promise<boolean> {
  const [hit] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.propertyId, propertyId), eq(table.slug, slug), exceptId ? ne(table.id, exceptId) : undefined));
  return !!hit;
}

async function createItem(db: Db, ctx: StaffContext, kind: Kind, propertyId: string, input: ContentItemInput, now: Date): Promise<CreateResult> {
  if (!can(ctx.staff, "content.edit", propertyId)) return { ok: false, error: "FORBIDDEN" };
  const table = TABLES[kind];
  const p = checkItem(input);
  if (isError(p)) return p;
  if (p.slug === undefined) return invalid("slug");
  if (p.title === undefined) return { ok: false, error: "I18N_INCOMPLETE", field: "title" };
  if (p.body === undefined) return { ok: false, error: "I18N_INCOMPLETE", field: "body" };
  if (await slugTaken(db, table, propertyId, p.slug)) return { ok: false, error: "SLUG_TAKEN" };
  const row = {
    id: crypto.randomUUID(), propertyId, slug: p.slug, title: p.title, body: p.body,
    publishedAt: p.publishedAt ?? null, sortOrder: p.sortOrder ?? 0,
  };
  await runAtomic(db, [
    db.insert(table).values(row),
    auditStatement(db, ctx, { action: `${kind}.create`, entity: kind, entityId: row.id, after: row }, now),
  ]);
  return { ok: true, id: row.id };
}

async function updateItem(db: Db, ctx: StaffContext, kind: Kind, id: string, patch: ContentItemPatch, now: Date, action = "update"): Promise<ContentResult> {
  const table = TABLES[kind];
  const [row] = await db.select().from(table).where(eq(table.id, id));
  if (!row) return { ok: false, error: "NOT_FOUND" };
  if (!can(ctx.staff, "content.edit", row.propertyId)) return { ok: false, error: "FORBIDDEN" };
  const p = checkItem(patch);
  if (isError(p)) return p;
  if (p.slug !== undefined && p.slug !== row.slug && (await slugTaken(db, table, row.propertyId, p.slug, id))) return { ok: false, error: "SLUG_TAKEN" };
  const keys = Object.keys(p);
  if (keys.length === 0) return { ok: true };
  await runAtomic(db, [
    db.update(table).set(p).where(eq(table.id, id)),
    auditStatement(db, ctx, { action: `${kind}.${action}`, entity: kind, entityId: id, before: pick(row, keys), after: p }, now),
  ]);
  return { ok: true };
}

/** "Delete" is unpublishing: publishedAt becomes null, the row stays (it can be published again). */
const unpublish = (db: Db, ctx: StaffContext, kind: Kind, id: string, now: Date) => updateItem(db, ctx, kind, id, { publishedAt: null }, now, "delete");

export const createNews = (db: Db, ctx: StaffContext, propertyId: string, input: ContentItemInput, now = new Date()) =>
  createItem(db, ctx, "news", propertyId, input, now);
export const updateNews = (db: Db, ctx: StaffContext, id: string, patch: ContentItemPatch, now = new Date()) =>
  updateItem(db, ctx, "news", id, patch, now);
export const deleteNews = (db: Db, ctx: StaffContext, id: string, now = new Date()) => unpublish(db, ctx, "news", id, now);

export const createFaq = (db: Db, ctx: StaffContext, propertyId: string, input: ContentItemInput, now = new Date()) =>
  createItem(db, ctx, "faq", propertyId, input, now);
export const updateFaq = (db: Db, ctx: StaffContext, id: string, patch: ContentItemPatch, now = new Date()) =>
  updateItem(db, ctx, "faq", id, patch, now);
export const deleteFaq = (db: Db, ctx: StaffContext, id: string, now = new Date()) => unpublish(db, ctx, "faq", id, now);

export const createPage = (db: Db, ctx: StaffContext, propertyId: string, input: ContentItemInput, now = new Date()) =>
  createItem(db, ctx, "page", propertyId, input, now);
export const updatePage = (db: Db, ctx: StaffContext, id: string, patch: ContentItemPatch, now = new Date()) =>
  updateItem(db, ctx, "page", id, patch, now);
export const deletePage = (db: Db, ctx: StaffContext, id: string, now = new Date()) => unpublish(db, ctx, "page", id, now);

/** Admin reads: every row of the property, published or not. */
export const listUnitTypesForAdmin = (db: Db, propertyId: string) =>
  db.select().from(unitTypes).where(eq(unitTypes.propertyId, propertyId)).orderBy(asc(unitTypes.sortOrder));

export async function getUnitTypeForAdmin(db: Db, propertyId: string, id: string) {
  const [row] = await db.select().from(unitTypes).where(and(eq(unitTypes.propertyId, propertyId), eq(unitTypes.id, id)));
  return row ?? null;
}

export type ContentItemRow = typeof news.$inferSelect;

export function listItemsForAdmin(db: Db, kind: Kind, propertyId: string): Promise<ContentItemRow[]> {
  const table = TABLES[kind];
  const order = kind === "news" ? [desc(table.publishedAt), asc(table.sortOrder)] : [asc(table.sortOrder)];
  return db.select().from(table).where(eq(table.propertyId, propertyId)).orderBy(...order);
}

export async function getItemForAdmin(db: Db, kind: Kind, propertyId: string, id: string): Promise<ContentItemRow | null> {
  const table = TABLES[kind];
  const [row] = await db.select().from(table).where(and(eq(table.propertyId, propertyId), eq(table.id, id)));
  return row ?? null;
}
