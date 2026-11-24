import { sql } from "drizzle-orm";
import { rateLimits } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/** Per-IP limits, per minute. */
export const RATE = {
  create: 5,
  lookup: 10,
  cancel: 10,
  inquiry: 5,
} as const;

/**
 * Fixed-window counter in D1: true if this request is within `limit` for its window.
 * One atomic upsert per call: the row is reset when a new window starts, otherwise incremented.
 */
export async function checkRate(db: Db, key: string, limit: number, windowSec: number, now: Date): Promise<boolean> {
  const windowMs = windowSec * 1000;
  const windowStart = Math.floor(now.getTime() / windowMs) * windowMs;
  const [row] = await db.insert(rateLimits).values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        // SQLite evaluates every SET expression against the old row, so both see the old window_start.
        count: sql`CASE WHEN ${rateLimits.windowStart} = excluded.window_start THEN ${rateLimits.count} + 1 ELSE 1 END`,
        windowStart: sql`excluded.window_start`,
      },
    })
    .returning({ count: rateLimits.count });
  return row.count <= limit;
}

/** The caller's IP as Cloudflare reports it. */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

export const tooManyRequests = () =>
  Response.json({ ok: false, error: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
