import type { Db } from "./types";

type Runnable = { run: () => unknown };

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
