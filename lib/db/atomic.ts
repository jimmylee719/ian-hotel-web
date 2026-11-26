import type { SQL } from "drizzle-orm";
import type { Db } from "./types";

export type Runnable = { run: () => unknown };

/**
 * Run statements all-or-nothing: D1 `batch` (implicit transaction) in production,
 * a better-sqlite3 transaction in tests. Any statement error rolls back all of them.
 */
export async function runAtomic(db: Db, statements: Runnable[]): Promise<void> {
  if (statements.length === 0) return;
  const d = db as unknown as { batch?: (s: unknown[]) => Promise<unknown>; transaction: (fn: () => void) => unknown };
  if (typeof d.batch === "function") {
    await d.batch(statements);
    return;
  }
  d.transaction(() => {
    for (const s of statements) s.run();
  });
}

/**
 * A raw SQL statement for runAtomic: on D1 drizzle's lazy `db.run` (batched), on better-sqlite3 (which would run
 * `db.run` at once) a thunk that runs it inside runAtomic's transaction.
 */
export function rawStatement(db: Db, query: SQL): Runnable {
  const d = db as unknown as { batch?: unknown; run: (q: SQL) => unknown };
  if (typeof d.batch === "function") return d.run(query) as Runnable;
  return { run: () => d.run(query) };
}
