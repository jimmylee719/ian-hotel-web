import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditStatement, recordAudit } from "@/lib/admin/audit";
import type { StaffContext } from "@/lib/admin/auth";
import { runAtomic } from "@/lib/db/atomic";
import { auditLog, staff } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createTestDb } from "../helpers/test-db";

const NOW = new Date("2026-12-01T03:00:00Z");

function setup() {
  const db = createTestDb();
  const row = { id: "s1", email: "boss@nk.com", name: "Boss", role: "owner" as const, propertyIds: ["A"], active: true };
  db.insert(staff).values([row, { ...row, id: "s2", email: "fd@nk.com", name: "FD", role: "front_desk" }]).run();
  const ctx: StaffContext = { staff: row, email: row.email };
  return { db, ctx, d: db as unknown as Db };
}

describe("audit log", () => {
  it("commits the audit row with the write it records", async () => {
    const { db, ctx, d } = setup();
    await runAtomic(d, [
      d.update(staff).set({ name: "Front Desk" }).where(eq(staff.id, "s2")),
      auditStatement(d, ctx, { action: "staff.update", entity: "staff", entityId: "s2", before: { name: "FD" }, after: { name: "Front Desk" } }, NOW),
    ]);
    expect(db.select().from(staff).where(eq(staff.id, "s2")).get()?.name).toBe("Front Desk");
    const logs = db.select().from(auditLog).all();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      staffEmail: "boss@nk.com", action: "staff.update", entity: "staff", entityId: "s2",
      before: { name: "FD" }, after: { name: "Front Desk" }, at: NOW.getTime(),
    });
  });

  it("leaves no audit row when the write fails", async () => {
    const { db, ctx, d } = setup();
    await expect(runAtomic(d, [
      auditStatement(d, ctx, { action: "staff.update", entity: "staff", entityId: "s2", after: { email: "boss@nk.com" } }, NOW),
      d.update(staff).set({ email: "boss@nk.com" }).where(eq(staff.id, "s2")), // unique violation
    ])).rejects.toThrow();
    expect(db.select().from(auditLog).all()).toHaveLength(0);
    expect(db.select().from(staff).where(eq(staff.id, "s2")).get()?.email).toBe("fd@nk.com");
  });

  it("recordAudit writes directly, with null before/after when omitted", async () => {
    const { db, ctx, d } = setup();
    await recordAudit(d, ctx, { action: "notifications.resend", entity: "reservation", entityId: "r1" }, NOW);
    expect(db.select().from(auditLog).all()).toMatchObject([{ action: "notifications.resend", before: null, after: null }]);
  });
});
