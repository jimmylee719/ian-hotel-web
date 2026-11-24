import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import * as schema from "@/lib/db/schema";

export type TestDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function createTestDb(): TestDb {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve(__dirname, "../../drizzle/migrations") });
  return db as TestDb;
}

export function rawSqlite(db: TestDb): Database.Database {
  return db.$client;
}
