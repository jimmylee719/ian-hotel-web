/**
 * Local dev only: seed NK Hostel + 14 days of fake ARI into the local D1 (`wrangler --local`).
 * Builds the rows in an in-memory SQLite with the real migrations, dumps them as INSERTs,
 * then applies the file with wrangler. Wipes the seeded tables in the local DB first.
 */
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { addDays, format } from "date-fns";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../lib/db/schema";
import { seedNk } from "../lib/db/seed-nk";
import { todayInTaipei } from "../lib/domain/dates";

const TABLES = ["inventory_daily", "ari_daily", "rate_plans", "unit_types", "properties"];

async function main() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve("drizzle/migrations") });
  const { propertyId } = await seedNk(db);

  const [plan] = await db.select().from(schema.ratePlans);
  const types = await db.select().from(schema.unitTypes);
  const start = new Date(`${todayInTaipei()}T00:00:00`);
  for (const u of types)
    for (let i = 0; i < 14; i++) {
      const day = addDays(start, i);
      const date = format(day, "yyyy-MM-dd");
      await db.insert(schema.inventoryDaily).values({ propertyId, unitTypeId: u.id, date, available: 3, source: "siteminder", syncedAt: Date.now() });
      await db.insert(schema.ariDaily).values({
        propertyId, unitTypeId: u.id, ratePlanId: plan.id, date,
        price: 2000 + u.sortOrder * 150 + ([5, 6].includes(day.getDay()) ? 400 : 0),
        source: "siteminder", syncedAt: Date.now(),
      });
    }

  const q = (v: unknown) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
  const lines = TABLES.map((t) => `DELETE FROM ${t};`);
  for (const t of [...TABLES].reverse())
    for (const row of sqlite.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[])
      lines.push(`INSERT INTO ${t} (${Object.keys(row).join(",")}) VALUES (${Object.values(row).map(q).join(",")});`);

  const file = path.resolve(".wrangler/seed-local.sql");
  writeFileSync(file, lines.join("\n"));
  execFileSync("npx", ["wrangler", "d1", "execute", "nk-booking", "--local", "--file", file], { stdio: "inherit" });
}

main();
