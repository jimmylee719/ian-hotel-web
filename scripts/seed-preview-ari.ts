/**
 * Public preview only (wrangler env.preview): fills the preview's D1 with TEST availability and prices
 * (inventory_daily + ari_daily) for today (Taipei) through today + 180 days, for every active room type and rate plan
 * already in it (scripts/seed-preview.ts seeds those). The numbers are seed-local's fake ARI (lib/db/preview-ari.ts):
 * test data for the mocked booking flow, not real prices. Idempotent: nights that already exist are left as they are,
 * so it can be re-run (e.g. monthly) to extend the window without undoing test bookings.
 *
 * Every run first checks the SQL: it runs it twice on an in-memory SQLite with the real migrations and the NK seed,
 * and prints the row counts and price range.
 *
 *   npx tsx scripts/seed-preview-ari.ts            # dry run: writes .wrangler/seed-preview-ari.sql only
 *   npx tsx scripts/seed-preview-ari.ts --local    # applies it to the LOCAL copy of the preview D1 (wrangler --local)
 *   npx tsx scripts/seed-preview-ari.ts --apply    # applies it to the preview's REMOTE D1 (wrangler --remote)
 */
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../lib/db/schema";
import { previewAriSql } from "../lib/db/preview-ari";
import { seedNk } from "../lib/db/seed-nk";
import { todayInTaipei } from "../lib/domain/dates";

/** today .. today + 180. */
const DAYS = 181;

async function main() {
  const lines = previewAriSql(todayInTaipei(), DAYS, Date.now());

  // Check the SQL against the real schema, twice, to show a re-run adds nothing.
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve("drizzle/migrations") });
  await seedNk(db);
  const one = (q: string) => sqlite.prepare(q).get() as Record<string, number | string>;
  const counts: string[] = [];
  for (let run = 0; run < 2; run++) {
    sqlite.exec(lines.join("\n"));
    counts.push(`${one("select count(*) n from inventory_daily").n}/${one("select count(*) n from ari_daily").n}`);
  }
  if (counts[0] !== counts[1]) throw new Error(`a second run changed the row counts (${counts.join(" then ")})`);
  const types = one("select count(*) n from unit_types where active = 1").n;
  const inv = one("select count(*) n, min(date) first, max(date) last from inventory_daily");
  const ari = one("select count(*) n, min(price) lo, max(price) hi from ari_daily");
  console.log(`checked on the NK seed: ${DAYS} nights, ${inv.first} to ${inv.last}, ${types} active room types`);
  console.log(`inventory_daily ${inv.n} rows, ari_daily ${ari.n} rows, NT$${ari.lo} to NT$${ari.hi} a night; a re-run adds 0`);

  const file = path.resolve(".wrangler/seed-preview-ari.sql");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n"));
  console.log(`${lines.length} statements in ${path.relative(process.cwd(), file)}`);

  const where = process.argv.includes("--apply") ? "--remote" : process.argv.includes("--local") ? "--local" : null;
  if (!where) return console.log("dry run; pass --apply for the preview's remote D1, or --local for its local copy");
  execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--env", "preview", where, "--file", file], { stdio: "inherit" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
