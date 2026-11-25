import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { StaffContext } from "@/lib/admin/auth";
import { createStaff, deactivateStaff, firstOwnerSql, listStaff, updateStaff } from "@/lib/admin/staff";
import * as schema from "@/lib/db/schema";
import { auditLog, properties, staff, type I18n } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import { createTestDb, rawSqlite } from "../helpers/test-db";

const NOW = new Date("2026-11-24T02:00:00Z");
const t = (s: string): I18n => ({ "zh-TW": s, en: s, ja: s, ko: s });

async function setup() {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  const other = "other-property";
  await db.insert(properties).values({
    id: other, slug: "other", type: "hotel", name: t("o"), timezone: "Asia/Taipei", currency: "TWD", address: t("a"),
    phone: "1", email: "o@x.test", createdAt: 0,
  });
  const mk = async (id: string, role: "owner" | "manager" | "front_desk" | "marketing", propertyIds = [propertyId]): Promise<StaffContext> => {
    const row = { id, email: `${id}@nk.test`, name: id, role, propertyIds, active: true };
    await db.insert(staff).values(row);
    return { staff: row, email: row.email };
  };
  const reload = async (id: string) => (await db.select().from(staff).where(eq(staff.id, id)))[0];
  const ctxOf = async (id: string): Promise<StaffContext> => { const r = await reload(id); return { staff: r, email: r.email }; };
  const audits = (entityId: string) => db.select().from(auditLog).where(eq(auditLog.entityId, entityId));
  return { db, propertyId, other, mk, reload, ctxOf, audits, owner: await mk("owner", "owner"), manager: await mk("manager", "manager") };
}

const input = (propertyIds: string[], over = {}) => ({ email: "new@nk.test", name: "新人", role: "front_desk" as const, propertyIds, ...over });

describe("permissions", () => {
  test("a manager (no staff.manage) cannot create, update or deactivate staff", async () => {
    const { db, propertyId, manager, owner } = await setup();
    expect(await createStaff(db, manager, input([propertyId]), NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(await updateStaff(db, manager, owner.staff.id, { name: "x" }, NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(await deactivateStaff(db, manager, owner.staff.id, NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(await db.select().from(staff)).toHaveLength(2);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  test("an owner cannot give a property they do not manage, and propertyIds may not be empty", async () => {
    const { db, propertyId, other, owner, manager } = await setup();
    expect(await createStaff(db, owner, input([propertyId, other]), NOW)).toEqual({ ok: false, error: "PROPERTY_NOT_ALLOWED" });
    expect(await createStaff(db, owner, input([]), NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "propertyIds" });
    expect(await updateStaff(db, owner, manager.staff.id, { propertyIds: [other] }, NOW)).toEqual({ ok: false, error: "PROPERTY_NOT_ALLOWED" });
    expect(await db.select().from(staff)).toHaveLength(2);
  });

  test("an owner cannot edit staff who also work at a property the owner does not manage", async () => {
    const { db, propertyId, other, owner, mk } = await setup();
    const both = await mk("both", "front_desk", [propertyId, other]);
    expect(await updateStaff(db, owner, both.staff.id, { name: "x" }, NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(await deactivateStaff(db, owner, both.staff.id, NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
  });
});

describe("create", () => {
  test("stores the email lowercased; the same address in any case is EMAIL_TAKEN", async () => {
    const { db, propertyId, owner, audits } = await setup();
    const r = await createStaff(db, owner, input([propertyId], { email: "  Front.Desk@NK.Test " }), NOW);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const [row] = await db.select().from(staff).where(eq(staff.id, r.id));
    expect(row).toMatchObject({ email: "front.desk@nk.test", role: "front_desk", propertyIds: [propertyId], active: true });
    expect(await createStaff(db, owner, input([propertyId], { email: "FRONT.DESK@nk.test" }), NOW)).toEqual({ ok: false, error: "EMAIL_TAKEN" });
    expect(await updateStaff(db, owner, "manager", { email: "Front.Desk@nk.test" }, NOW)).toEqual({ ok: false, error: "EMAIL_TAKEN" });
    const [a] = await audits(r.id);
    expect(a).toMatchObject({ action: "staff.create", entity: "staff", staffEmail: owner.email });
  });

  test("rejects a bad email, a blank name and an unknown role", async () => {
    const { db, propertyId, owner } = await setup();
    expect(await createStaff(db, owner, input([propertyId], { email: "nope" }), NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "email" });
    expect(await createStaff(db, owner, input([propertyId], { name: "  " }), NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "name" });
    expect(await createStaff(db, owner, input([propertyId], { role: "admin" }), NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "role" });
  });

  test("the unique index is on the lowercased email, so a direct mixed-case duplicate fails too", async () => {
    const { db, propertyId, owner } = await setup();
    await createStaff(db, owner, input([propertyId], { email: "dup@nk.test" }), NOW);
    expect(() => rawSqlite(db).prepare("INSERT INTO staff (id,email,name,role,property_ids,active) VALUES ('x','DUP@nk.test','x','owner','[]',1)").run())
      .toThrow(/UNIQUE|CHECK/);
  });
});

describe("update and deactivate", () => {
  test("updates role, name and properties, audited with before and after", async () => {
    const { db, propertyId, owner, manager, reload, audits } = await setup();
    expect(await updateStaff(db, owner, manager.staff.id, { role: "marketing", name: " 小美 " }, NOW)).toEqual({ ok: true });
    expect(await reload(manager.staff.id)).toMatchObject({ role: "marketing", name: "小美", propertyIds: [propertyId] });
    const [a] = await audits(manager.staff.id);
    expect(a).toMatchObject({ action: "staff.update", before: { role: "manager", name: "manager" }, after: { role: "marketing", name: "小美" } });
  });

  test("nobody can deactivate or demote themselves", async () => {
    const { db, owner, mk, reload } = await setup();
    await mk("owner2", "owner");
    expect(await updateStaff(db, owner, owner.staff.id, { role: "manager" }, NOW)).toEqual({ ok: false, error: "CANNOT_CHANGE_SELF" });
    expect(await deactivateStaff(db, owner, owner.staff.id, NOW)).toEqual({ ok: false, error: "CANNOT_CHANGE_SELF" });
    expect(await updateStaff(db, owner, owner.staff.id, { active: false }, NOW)).toEqual({ ok: false, error: "CANNOT_CHANGE_SELF" });
    expect(await reload(owner.staff.id)).toMatchObject({ role: "owner", active: true });
    // Editing your own name is fine.
    expect(await updateStaff(db, owner, owner.staff.id, { name: "店主" }, NOW)).toEqual({ ok: true });
  });

  test("the last active owner cannot be demoted or deactivated by another owner", async () => {
    const { db, owner, mk, reload, ctxOf } = await setup();
    const second = await mk("owner2", "owner");
    // owner2 deactivates owner: fine, owner2 remains.
    expect(await deactivateStaff(db, second, owner.staff.id, NOW)).toEqual({ ok: true });
    // A third, inactive owner does not count; owner2 is now the last active owner.
    const third = await mk("owner3", "owner");
    await db.update(staff).set({ active: false }).where(eq(staff.id, third.staff.id));
    // Bring the first owner back (reactivation needs no owner check) and have them try to remove owner2 after
    // owner2 has demoted them: they no longer hold staff.manage.
    expect(await updateStaff(db, second, owner.staff.id, { active: true, role: "manager" }, NOW)).toEqual({ ok: true });
    expect(await updateStaff(db, await ctxOf(owner.staff.id), second.staff.id, { role: "manager" }, NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(await reload(second.staff.id)).toMatchObject({ role: "owner", active: true });
  });

  test("two owners demoting each other at the same time leave at least one active owner", async () => {
    const { db, owner, mk } = await setup();
    const second = await mk("owner2", "owner");
    const results = await Promise.all([
      updateStaff(db, owner, second.staff.id, { role: "manager" }, NOW),
      updateStaff(db, second, owner.staff.id, { role: "manager" }, NOW),
    ]);
    const owners = (await db.select().from(staff)).filter((s) => s.role === "owner" && s.active);
    expect(owners.length).toBeGreaterThanOrEqual(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, error: "LAST_OWNER" });
    // Only the change that happened is audited.
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "staff.update"))).toHaveLength(1);
  });

  test("two owners deactivating each other at the same time leave at least one active owner", async () => {
    const { db, owner, mk } = await setup();
    const second = await mk("owner2", "owner");
    const results = await Promise.all([deactivateStaff(db, owner, second.staff.id, NOW), deactivateStaff(db, second, owner.staff.id, NOW)]);
    expect((await db.select().from(staff)).filter((s) => s.role === "owner" && s.active).length).toBeGreaterThanOrEqual(1);
    expect(results).toContainEqual({ ok: false, error: "LAST_OWNER" });
  });

  test("deactivate is audited; an unknown id is NOT_FOUND", async () => {
    const { db, owner, manager, reload, audits } = await setup();
    expect(await deactivateStaff(db, owner, manager.staff.id, NOW)).toEqual({ ok: true });
    expect((await reload(manager.staff.id)).active).toBe(false);
    expect((await audits(manager.staff.id))[0]).toMatchObject({ action: "staff.deactivate", before: { active: true }, after: { active: false } });
    expect(await deactivateStaff(db, owner, "nope", NOW)).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  test("listStaff shows staff sharing a property with the viewer, flagging who they may edit", async () => {
    const { db, propertyId, other, owner, mk } = await setup();
    await mk("elsewhere", "manager", [other]);
    await mk("both", "manager", [propertyId, other]);
    const rows = await listStaff(db, owner);
    expect(rows.map((r) => [r.id, r.manageable])).toEqual(expect.arrayContaining([["owner", true], ["manager", true], ["both", false]]));
    expect(rows.find((r) => r.id === "elsewhere")).toBeUndefined();
    expect(rows.map((r) => r.role)).toEqual(["owner", "manager", "manager"]);
  });
});

describe("first owner", () => {
  test("firstOwnerSql inserts an active, lowercased owner of every property, quoting safely", async () => {
    const { db, propertyId, other } = await setup();
    rawSqlite(db).exec(firstOwnerSql("Boss@NK.test", "O'Brien", "first-owner"));
    const [row] = await db.select().from(staff).where(eq(staff.id, "first-owner"));
    expect(row).toMatchObject({ email: "boss@nk.test", name: "O'Brien", role: "owner", active: true });
    expect([...row.propertyIds].sort()).toEqual([other, propertyId].sort());
    expect(() => firstOwnerSql("not-an-email", "x")).toThrow();
  });
});

describe("migration 0017 (staff emails lowercase)", () => {
  /** A database migrated up to (not including) 0017, then `rows` inserted, then the rest applied. */
  function migrateWith(rows: [id: string, email: string][]) {
    const src = path.resolve(__dirname, "../../drizzle/migrations");
    const before = mkdtempSync(path.join(tmpdir(), "mig-"));
    cpSync(src, before, { recursive: true });
    const journalPath = path.join(before, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    const idx = journal.entries.findIndex((e: { tag: string }) => e.tag.startsWith("0017_"));
    writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, idx) }));
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: before });
    for (const [id, email] of rows)
      sqlite.prepare("INSERT INTO staff (id,email,name,role,property_ids,active) VALUES (?,?,?,'owner','[]',1)").run(id, email, id);
    const emails = () => sqlite.prepare("SELECT id, email FROM staff ORDER BY id").all();
    return Object.assign(() => { migrate(db, { migrationsFolder: src }); return emails(); }, { emails });
  }

  test("lowercases and trims existing emails", () => {
    expect(migrateWith([["a", " Boss@NK.test "], ["b", "front@nk.test"]])()).toEqual([
      { id: "a", email: "boss@nk.test" }, { id: "b", email: "front@nk.test" },
    ]);
  });

  test("aborts when two rows differ only by case, changing nothing", () => {
    const run = migrateWith([["a", "Boss@nk.test"], ["b", "boss@NK.test"]]);
    let err: unknown;
    try { run(); } catch (e) { err = e; }
    expect(String((err as { cause?: unknown })?.cause)).toMatch(/UNIQUE constraint failed/);
    expect(run.emails()).toEqual([{ id: "a", email: "Boss@nk.test" }, { id: "b", email: "boss@NK.test" }]);
  });
});
