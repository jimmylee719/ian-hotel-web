import { asc, eq, sql, type SQL } from "drizzle-orm";
import { runAtomic } from "@/lib/db/atomic";
import { auditLog, staff } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { auditStatement } from "./audit";
import type { StaffContext } from "./auth";
import { can, type StaffRole, type StaffRow } from "./permissions";

/**
 * Staff accounts. Every write needs `staff.manage` (owners only), may only hand out properties the actor
 * manages, may only touch staff whose properties are all ones the actor manages, and commits its audit row in
 * the same batch. Emails are stored trimmed and lowercase (the unique index is on lower(email) too).
 * Nobody may change their own role, active flag or email, and the last active owner can never be demoted or
 * deactivated: that check is part of the UPDATE itself, so two owners demoting each other at once still leave one.
 */

export const STAFF_ROLES: readonly StaffRole[] = ["owner", "manager", "front_desk", "marketing"];

export type StaffError =
  | { ok: false; error: "FORBIDDEN" | "NOT_FOUND" | "EMAIL_TAKEN" | "PROPERTY_NOT_ALLOWED" | "CANNOT_CHANGE_SELF" | "LAST_OWNER" }
  | { ok: false; error: "INVALID_INPUT"; field: string };
export type StaffResult = { ok: true } | StaffError;
export type CreateStaffResult = { ok: true; id: string } | StaffError;

export type StaffInput = { email: string; name: string; role: StaffRole; propertyIds: string[] };
export type StaffPatch = Partial<StaffInput> & { active?: boolean };

const EMAIL = /^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/;
const KEYS = ["email", "name", "role", "propertyIds", "active"] as const;
const invalid = (field: string): StaffError => ({ ok: false, error: "INVALID_INPUT", field });

/** The address as stored: trimmed, lowercase. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Validates and normalises the set keys of `p`; an unknown key is INVALID_INPUT. */
function clean(ctx: StaffContext, p: Record<string, unknown>): StaffError | StaffPatch {
  const out: StaffPatch = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    if (!(KEYS as readonly string[]).includes(k)) return invalid(k);
    switch (k) {
      case "email":
        if (typeof v !== "string" || !EMAIL.test(normalizeEmail(v)) || v.length > 254) return invalid("email");
        out.email = normalizeEmail(v);
        break;
      case "name":
        if (typeof v !== "string" || !v.trim() || v.trim().length > 100) return invalid("name");
        out.name = v.trim();
        break;
      case "role":
        if (!STAFF_ROLES.includes(v as StaffRole)) return invalid("role");
        out.role = v as StaffRole;
        break;
      case "propertyIds": {
        if (!Array.isArray(v) || v.length === 0 || v.some((id) => typeof id !== "string")) return invalid("propertyIds");
        const ids = [...new Set(v as string[])];
        if (ids.some((id) => !ctx.staff.propertyIds.includes(id))) return { ok: false, error: "PROPERTY_NOT_ALLOWED" };
        out.propertyIds = ids;
        break;
      }
      case "active":
        if (typeof v !== "boolean") return invalid("active");
        out.active = v;
        break;
    }
  }
  return out;
}
const isError = (v: object): v is StaffError => "ok" in v;

/** May `ctx` edit `target` at all? Only when every property of the target is one `ctx` manages. */
const manages = (ctx: StaffContext, target: StaffRow) => target.propertyIds.every((id) => ctx.staff.propertyIds.includes(id));

async function emailTaken(db: Db, email: string, exceptId?: string): Promise<boolean> {
  const [hit] = await db.select({ id: staff.id }).from(staff).where(sql`lower(${staff.email}) = ${email}`);
  return !!hit && hit.id !== exceptId;
}

const isUniqueViolation = (e: unknown): boolean => {
  for (let c: unknown = e; c; c = (c as { cause?: unknown }).cause)
    if (String((c as { message?: unknown }).message ?? c).includes("UNIQUE constraint failed")) return true;
  return false;
};

/** Add a staff member (active). Needs `staff.manage`; `propertyIds` non-empty and all managed by the actor. */
export async function createStaff(db: Db, ctx: StaffContext, input: StaffInput, now: Date = new Date()): Promise<CreateStaffResult> {
  if (!can(ctx.staff, "staff.manage")) return { ok: false, error: "FORBIDDEN" };
  const p = clean(ctx, { ...input, active: undefined });
  if (isError(p)) return p;
  for (const k of ["email", "name", "role", "propertyIds"] as const) if (p[k] === undefined) return invalid(k);
  if (await emailTaken(db, p.email!)) return { ok: false, error: "EMAIL_TAKEN" };
  const row = { id: crypto.randomUUID(), email: p.email!, name: p.name!, role: p.role!, propertyIds: p.propertyIds!, active: true };
  try {
    await runAtomic(db, [db.insert(staff).values(row), auditStatement(db, ctx, { action: "staff.create", entity: "staff", entityId: row.id, after: row }, now)]);
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: "EMAIL_TAKEN" };
    throw e;
  }
  return { ok: true, id: row.id };
}

/**
 * Edit a staff member: any of email, name, role, propertyIds, active. A change that would leave no active
 * owner is LAST_OWNER (decided by the UPDATE, see the module comment).
 */
export async function updateStaff(db: Db, ctx: StaffContext, id: string, patch: StaffPatch, now: Date = new Date()): Promise<StaffResult> {
  return write(db, ctx, id, patch, "staff.update", now);
}

/** Switch a staff member off (`active: false`); they can no longer open the admin. Rows are never deleted. */
export async function deactivateStaff(db: Db, ctx: StaffContext, id: string, now: Date = new Date()): Promise<StaffResult> {
  return write(db, ctx, id, { active: false }, "staff.deactivate", now);
}

async function write(db: Db, ctx: StaffContext, id: string, patch: StaffPatch, action: string, now: Date): Promise<StaffResult> {
  if (!can(ctx.staff, "staff.manage")) return { ok: false, error: "FORBIDDEN" };
  const [row] = await db.select().from(staff).where(eq(staff.id, id));
  if (!row) return { ok: false, error: "NOT_FOUND" };
  if (!manages(ctx, row)) return { ok: false, error: "FORBIDDEN" };
  const p = clean(ctx, patch as Record<string, unknown>);
  if (isError(p)) return p;
  const changed = Object.fromEntries(
    Object.entries(p).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(row[k as keyof StaffRow])),
  ) as StaffPatch;
  const keys = Object.keys(changed) as (keyof StaffPatch)[];
  if (keys.length === 0) return { ok: true };
  if (row.id === ctx.staff.id && (changed.role !== undefined || changed.active !== undefined || changed.email !== undefined))
    return { ok: false, error: "CANNOT_CHANGE_SELF" };
  if (changed.email !== undefined && (await emailTaken(db, changed.email, id))) return { ok: false, error: "EMAIL_TAKEN" };

  // Removing an active owner (demotion or deactivation) needs another active owner at the moment of the write.
  const removesOwner = (changed.role !== undefined && changed.role !== "owner") || changed.active === false;
  const guard: SQL = removesOwner
    ? sql`(not (${staff.role} = 'owner' and ${staff.active} = 1)
          or (select count(*) from ${staff} o where o.role = 'owner' and o.active = 1 and o.id != ${id}) >= 1)`
    : sql`1 = 1`;
  const auditId = crypto.randomUUID();
  const before = Object.fromEntries(keys.map((k) => [k, row[k]]));
  try {
    // The audit row is written first, under the same guard (evaluated against the row as it is now), so it
    // exists exactly when the UPDATE below applies.
    await runAtomic(db, [
      db.insert(auditLog).select(sql`select ${auditId}, ${ctx.email}, ${action}, 'staff', ${id},
        ${JSON.stringify(before)}, ${JSON.stringify(changed)}, ${now.getTime()}
        from ${staff} where ${staff.id} = ${id} and ${guard}`),
      db.update(staff).set(changed).where(sql`${staff.id} = ${id} and ${guard}`),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: "EMAIL_TAKEN" };
    throw e;
  }
  const [won] = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.id, auditId));
  return won ? { ok: true } : { ok: false, error: "LAST_OWNER" };
}

export type StaffListRow = StaffRow & { manageable: boolean };

/** Staff sharing at least one property with the viewer, owners first; `manageable` = the viewer may edit them. */
export async function listStaff(db: Db, ctx: StaffContext): Promise<StaffListRow[]> {
  const rows = await db.select().from(staff).orderBy(asc(staff.role), asc(staff.email));
  return rows
    .filter((r) => r.propertyIds.some((id) => ctx.staff.propertyIds.includes(id)))
    .map((r) => ({ ...r, manageable: manages(ctx, r) }));
}

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * SQL that adds the first owner: active, lowercase email, owner of every property. Used by
 * scripts/create-owner.ts (local D1) and printed in docs/DEPLOY.md for the owner to run with `--remote`.
 * Inserts nothing when there are no properties yet.
 */
export function firstOwnerSql(email: string, name: string, id: string = crypto.randomUUID()): string {
  const e = normalizeEmail(email);
  if (!EMAIL.test(e)) throw new Error(`not an email address: ${email}`);
  if (!name.trim()) throw new Error("name is required");
  return `INSERT INTO staff (id, email, name, role, property_ids, active)
SELECT ${q(id)}, ${q(e)}, ${q(name.trim())}, 'owner', json_group_array(id), 1 FROM properties HAVING count(*) > 0;`;
}
