import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { oldSiteContent } from "@/lib/content/old-site";
import { parseImportArgs, planContentImport, wranglerExecuteArgs } from "@/lib/content/import-remote";
import { contentPages, faqs, news, unitTypes } from "@/lib/db/schema";
import { seedContent } from "@/lib/db/seed-content";
import { seedNk } from "@/lib/db/seed-nk";
import type { Db } from "@/lib/db/types";
import { createTestDb, rawSqlite, type TestDb } from "../helpers/test-db";

const NOW = Date.parse("2026-11-25T00:00:00Z");
const data = oldSiteContent();

function plan() {
  let n = 0;
  return planContentImport(data, { propertySlug: "nk-hostel", now: NOW, newId: () => `id-${++n}` });
}
const apply = (db: TestDb, statements: string[]) => { for (const s of statements) rawSqlite(db).exec(s); };

/** Every content row, without ids (random, the property's too), in a stable order. */
async function snapshot(db: TestDb) {
  const strip = <T extends { id: string; propertyId: string }>(rows: T[]) => rows.map((r) => {
    const { id, propertyId, ...rest } = r;
    void id; void propertyId;
    return rest;
  }).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  return {
    rooms: strip(await db.select().from(unitTypes)),
    pages: strip(await db.select().from(contentPages)),
    faqs: strip(await db.select().from(faqs)),
    news: strip(await db.select().from(news)),
  };
}

async function freshDb() {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  return { db, propertyId };
}

describe("planContentImport (the remote import's SQL, run here against better-sqlite3 with the real migrations)", () => {
  test("on an empty site it writes exactly what seedContent writes", async () => {
    const viaSql = await freshDb();
    apply(viaSql.db, plan().statements);
    const viaSeed = await freshDb();
    const realNow = Date.now;
    Date.now = () => NOW;
    try { await seedContent(viaSeed.db as unknown as Db, viaSeed.propertyId, data); } finally { Date.now = realNow; }
    expect(await snapshot(viaSql.db)).toEqual(await snapshot(viaSeed.db));
    expect((await viaSql.db.select().from(contentPages)).length).toBe(data.pages.length);
  });

  test("insert-only: staff edits and existing rows are never overwritten, and a second run changes nothing", async () => {
    const { db, propertyId } = await freshDb();
    const room = data.rooms[0];
    const edited = { "zh-TW": "員工改過的說明", en: "Staff text", ja: "", ko: "" };
    await db.update(unitTypes).set({ description: edited, images: ["rooms/staff-pick.jpg"] }).where(eq(unitTypes.slug, room.slug));
    const page = data.pages[0];
    await db.insert(contentPages).values({
      id: "staff-page", propertyId, slug: page.slug, title: edited, body: edited, publishedAt: null, sortOrder: 9,
    });

    apply(db, plan().statements);
    const [u] = await db.select().from(unitTypes).where(eq(unitTypes.slug, room.slug));
    expect(u.description).toEqual(edited);
    expect(u.images).toEqual(["rooms/staff-pick.jpg"]);
    expect(u.bedType).toEqual(room.bedType); // a blank field is still filled
    expect(await db.select().from(contentPages).where(eq(contentPages.slug, page.slug)))
      .toMatchObject([{ id: "staff-page", title: edited, sortOrder: 9, publishedAt: null }]);

    const once = await snapshot(db);
    apply(db, plan().statements);
    expect(await snapshot(db)).toEqual(once);
  });

  test("a property that is not there gets nothing", async () => {
    const db = createTestDb();
    apply(db, planContentImport(data, { propertySlug: "nk-hostel", now: NOW, newId: () => crypto.randomUUID() }).statements);
    expect(await snapshot(db)).toEqual({ rooms: [], pages: [], faqs: [], news: [] });
  });

  test("the dry-run summary lists what would be written", () => {
    const p = plan();
    expect(p.summary.join("\n")).toContain(`content_pages: ${data.pages.length}`);
    for (const r of data.rooms) expect(p.summary.join("\n")).toContain(r.slug);
    expect(p.imageKeys).toEqual(expect.arrayContaining(data.rooms[0].images));
  });
});

describe("parseImportArgs / wranglerExecuteArgs", () => {
  test("default: a dry run against staging", () => {
    expect(parseImportArgs([])).toEqual({ ok: true, env: "staging", apply: false });
    expect(parseImportArgs(["--env", "staging", "--apply"])).toEqual({ ok: true, env: "staging", apply: true });
  });

  test("production may be dry-run freely, but writing to it needs --env production --yes", () => {
    expect(parseImportArgs(["--env", "production"])).toEqual({ ok: true, env: "production", apply: false });
    expect(parseImportArgs(["--env", "production", "--apply"])).toEqual({ ok: false, error: expect.stringContaining("--yes") });
    expect(parseImportArgs(["--env", "production", "--apply", "--yes"])).toEqual({ ok: true, env: "production", apply: true });
  });

  test("anything else is refused", () => {
    expect(parseImportArgs(["--env", "local"])).toMatchObject({ ok: false });
    expect(parseImportArgs(["--env"])).toMatchObject({ ok: false });
    expect(parseImportArgs(["--force"])).toMatchObject({ ok: false });
  });

  test("the write goes through wrangler d1 execute --env <env> --remote with the planned file", () => {
    expect(wranglerExecuteArgs("production", "/tmp/x.sql"))
      .toEqual(["wrangler", "d1", "execute", "DB", "--env", "production", "--remote", "--file", "/tmp/x.sql"]);
  });
});
