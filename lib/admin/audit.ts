import { auditLog } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { StaffContext } from "./auth";

export type AuditEntry = { action: string; entity: string; entityId: string; before?: unknown; after?: unknown };

/** The audit row for a staff write, as a statement to commit in the same `runAtomic` batch as the write. */
export function auditStatement(db: Db, ctx: StaffContext, a: AuditEntry, now: Date) {
  return db.insert(auditLog).values({
    id: crypto.randomUUID(),
    staffEmail: ctx.email,
    action: a.action,
    entity: a.entity,
    entityId: a.entityId,
    before: a.before ?? null,
    after: a.after ?? null,
    at: now.getTime(),
  });
}

/** Write an audit row on its own, for actions whose write cannot share a batch (e.g. an external call). */
export async function recordAudit(db: Db, ctx: StaffContext, a: AuditEntry, now: Date): Promise<void> {
  await auditStatement(db, ctx, a, now);
}
