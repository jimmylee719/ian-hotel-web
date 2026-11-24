import { lt } from "drizzle-orm";
import { rateLimits } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

const KEEP_MS = 24 * 3600_000;

/** Delete rate-limit counters whose window ended more than a day ago (the longest window is a minute). */
export async function pruneRateLimits(db: Db, now: Date): Promise<{ pruned: number }> {
  const gone = await db.delete(rateLimits).where(lt(rateLimits.windowStart, now.getTime() - KEEP_MS)).returning({ key: rateLimits.key });
  return { pruned: gone.length };
}
