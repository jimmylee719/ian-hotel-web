import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/** A LIKE pattern that matches `q` anywhere, with `%`, `_` and `\` in the input taken literally (use with ESCAPE '\'). */
export function containsPattern(q: string): string {
  return `%${q.trim().toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
}

/** Case-insensitive "contains" on one column or SQL expression. */
export const containsText = (col: AnyColumn | SQL, q: string): SQL =>
  sql`lower(${col}) LIKE ${containsPattern(q)} ESCAPE '\\'`;
