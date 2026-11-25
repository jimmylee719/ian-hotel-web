/**
 * Public preview only (wrangler env.preview): seeds NK Hostel (property, room types, rate plans) and its migrated
 * site content (room photos and texts, pages, FAQs, news from content/old-site.json) into the preview's REMOTE D1.
 * No ARI, add-ons, promo codes or staff: booking is closed on the preview. Refuses if the property already exists.
 *
 *   npx tsx scripts/seed-preview.ts            # dry run: writes .wrangler/seed-preview.sql only
 *   npx tsx scripts/seed-preview.ts --apply    # runs it with `wrangler d1 execute DB --env preview --remote`
 */
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../lib/db/schema";
import { seedContent } from "../lib/db/seed-content";
import { seedNk } from "../lib/db/seed-nk";
import { oldSiteContent } from "../lib/content/old-site";

const TABLES = ["properties", "unit_types", "rate_plans", "content_pages", "faqs", "news"];

async function main() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve("drizzle/migrations") });
  const { propertyId } = await seedNk(db);
  await seedContent(db, propertyId, oldSiteContent());

  const q = (v: unknown) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
  const lines: string[] = [];
  for (const t of TABLES)
    for (const row of sqlite.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[])
      lines.push(`INSERT INTO ${t} (${Object.keys(row).join(",")}) VALUES (${Object.values(row).map(q).join(",")});`);

  const file = path.resolve(".wrangler/seed-preview.sql");
  writeFileSync(file, lines.join("\n"));
  console.log(`${lines.length} INSERTs in ${path.relative(process.cwd(), file)}`);
  if (!process.argv.includes("--apply")) return console.log("dry run; pass --apply to write to the preview D1");
  const existing = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--env", "preview", "--remote", "--json", "--command", "select count(*) as n from properties"], { encoding: "utf8" });
  if (!/"n":\s*0\b/.test(existing)) throw new Error("the preview D1 already has a property; not seeding again");
  execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--env", "preview", "--remote", "--file", file], { stdio: "inherit" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
