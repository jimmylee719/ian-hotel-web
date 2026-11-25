import { and, desc, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { auditLog } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { addDaysISO } from "@/lib/domain/dates";
import { paginate, type Page } from "./paginate";

/**
 * The audit log viewer. Which property a row belongs to is derived at read time from (entity, entityId),
 * by looking the entity up in its own table, rather than stored on audit_log:
 *  - it covers every row ever written, with no backfill, and no writer can forget to set it (several writers
 *    insert audit rows with positional `insert … select` guarded statements, which a new column would break);
 *  - entities never move between properties, so the answer cannot drift;
 *  - an entity it does not know, or a row whose entity is gone, maps to NULL, which only owners see (fails closed).
 * Staff rows (and anything else not tied to a property) are NULL on purpose: owner-only.
 * A new audited entity must be added to PROPERTY_OF or it stays owner-only.
 */
const PROPERTY_OF: Record<string, SQL> = {
  reservation: sql`(select r.property_id from reservations r where r.id = ${auditLog.entityId})`,
  reservation_note: sql`(select n.property_id from reservation_notes n where n.id = ${auditLog.entityId})`,
  payment: sql`(select r.property_id from payments p join reservations r on r.id = p.reservation_id where p.id = ${auditLog.entityId})`,
  notification: sql`(select n.property_id from notifications n where n.id = ${auditLog.entityId})`,
  unit_type: sql`(select u.property_id from unit_types u where u.id = ${auditLog.entityId})`,
  news: sql`(select c.property_id from news c where c.id = ${auditLog.entityId})`,
  faq: sql`(select c.property_id from faqs c where c.id = ${auditLog.entityId})`,
  page: sql`(select c.property_id from content_pages c where c.id = ${auditLog.entityId})`,
  addon: sql`(select a.property_id from addons a where a.id = ${auditLog.entityId})`,
  promo_code: sql`(select c.property_id from promo_codes c where c.id = ${auditLog.entityId})`,
  rate_plan: sql`(select rp.property_id from rate_plans rp where rp.id = ${auditLog.entityId})`,
  property: sql`(select p.id from properties p where p.id = ${auditLog.entityId})`,
};

/** The entities whose audit rows belong to a property (everything else is owner-only). */
export const AUDIT_PROPERTY_ENTITIES: readonly string[] = Object.keys(PROPERTY_OF);

const propertyOfRow: SQL<string | null> = sql`(case ${auditLog.entity} ${sql.join(
  Object.entries(PROPERTY_OF).map(([entity, q]) => sql`when ${entity} then ${q}`),
  sql` `,
)} else null end)`;

export type AuditQuery = {
  q?: string; staffEmail?: string; entity?: string; from?: string; to?: string; page: number; pageSize?: number;
  /** Also show rows tied to no property (staff accounts and the like). Only for owners. */
  includeUnscoped?: boolean;
};

export type AuditRow = {
  id: string; staffEmail: string; action: string; entity: string; entityId: string;
  before: unknown; after: unknown; at: number; propertyId: string | null;
};

function isDate(s: string | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}
/** Taipei is UTC+8 with no DST. */
const taipeiDayStart = (d: string) => Date.parse(`${d}T00:00:00Z`) - 8 * 3_600_000;
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Audit rows the viewer may see, newest first: rows tied to one of `propertyScope`, plus (with
 * `includeUnscoped`) rows tied to no property. `from`/`to` are Taipei dates, inclusive; invalid ones are ignored.
 * `q` matches action, entity, entity id, actor and the before/after JSON.
 */
export async function listAudit(db: Db, propertyScope: string[], o: AuditQuery): Promise<Page<AuditRow>> {
  const scope = or(
    propertyScope.length ? inArray(propertyOfRow, propertyScope) : sql`0`,
    o.includeUnscoped ? isNull(propertyOfRow) : sql`0`,
  )!;
  const q = o.q?.trim();
  const where = and(
    scope,
    o.staffEmail?.trim() ? sql`lower(${auditLog.staffEmail}) = ${o.staffEmail.trim().toLowerCase()}` : undefined,
    o.entity?.trim() ? sql`${auditLog.entity} = ${o.entity.trim()}` : undefined,
    isDate(o.from) ? sql`${auditLog.at} >= ${taipeiDayStart(o.from)}` : undefined,
    isDate(o.to) ? sql`${auditLog.at} < ${taipeiDayStart(addDaysISO(o.to, 1))}` : undefined,
    q
      ? sql`(${auditLog.action} like ${like(q)} escape '\\' or ${auditLog.entity} like ${like(q)} escape '\\'
          or ${auditLog.entityId} like ${like(q)} escape '\\' or ${auditLog.staffEmail} like ${like(q)} escape '\\'
          or coalesce(${auditLog.before}, '') like ${like(q)} escape '\\' or coalesce(${auditLog.after}, '') like ${like(q)} escape '\\')`
      : undefined,
  );
  return paginate<AuditRow>(
    {
      rows: (limit, offset) =>
        db.select({
          id: auditLog.id, staffEmail: auditLog.staffEmail, action: auditLog.action, entity: auditLog.entity,
          entityId: auditLog.entityId, before: auditLog.before, after: auditLog.after, at: auditLog.at, propertyId: propertyOfRow,
        }).from(auditLog).where(where).orderBy(desc(auditLog.at), desc(auditLog.id)).limit(limit).offset(offset),
      total: async () => (await db.select({ n: sql<number>`count(*)` }).from(auditLog).where(where))[0].n,
    },
    { page: o.page, pageSize: o.pageSize },
  );
}

export type DiffLine = { key: string; before: string; after: string; changed: boolean };

const show = (v: unknown) => (v === undefined ? "" : JSON.stringify(v));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Before and after side by side: one line per top-level key (in first-seen order), values as JSON.
 * A value that is not an object is shown as a single line with an empty key.
 */
export function auditDiff(before: unknown, after: unknown): DiffLine[] {
  const b = before ?? undefined;
  const a = after ?? undefined;
  if ((b !== undefined && !isObject(b)) || (a !== undefined && !isObject(a)))
    return [{ key: "", before: show(b), after: show(a), changed: show(b) !== show(a) }];
  const bo = (b ?? {}) as Record<string, unknown>;
  const ao = (a ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(bo), ...Object.keys(ao)])];
  return keys.map((key) => ({ key, before: show(bo[key]), after: show(ao[key]), changed: show(bo[key]) !== show(ao[key]) }));
}
