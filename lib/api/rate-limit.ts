import { eq, sql } from "drizzle-orm";
import { rateLimits } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/** Per-IP limits, per minute. */
export const RATE = {
  create: 5,
  /** Lookups that found nothing (wrong code or email), per IP: the enumeration guard. */
  lookupFailed: 10,
  /** Successful lookups of one booking, per IP + code: covers the return page polling every 2 s. */
  lookupBooking: 60,
  cancel: 10,
  inquiry: 5,
  quote: 30,
  /** Mock pay page outcomes (test sites only, app/dev/pay), per IP. */
  mockPay: 10,
} as const;

const windowStartOf = (now: Date, windowSec: number) => Math.floor(now.getTime() / (windowSec * 1000)) * windowSec * 1000;

/**
 * Fixed-window counter in D1: true if this request is within `limit` for its window.
 * One atomic upsert per call: the row is reset when a new window starts, otherwise incremented.
 */
export async function checkRate(db: Db, key: string, limit: number, windowSec: number, now: Date): Promise<boolean> {
  const windowStart = windowStartOf(now, windowSec);
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

/** True if `key` has already used up `limit` in the current window. Reads only; counts nothing. */
export async function isLimited(db: Db, key: string, limit: number, windowSec: number, now: Date): Promise<boolean> {
  const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, key));
  return !!row && row.windowStart === windowStartOf(now, windowSec) && row.count >= limit;
}

/** Seconds until the current window ends (at least 1). */
export function retryAfterSec(windowSec: number, now: Date): number {
  return Math.max(1, Math.ceil((windowStartOf(now, windowSec) + windowSec * 1000 - now.getTime()) / 1000));
}

/** The caller's IP as Cloudflare reports it. */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

export const tooManyRequests = (retryAfter = 60) =>
  Response.json({ ok: false, error: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } });
