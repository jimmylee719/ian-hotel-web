import { drizzle } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { buildScheduledDeps } from "@/lib/runtime/deps";
import type { AppEnv } from "@/lib/runtime/env";
import { pruneRateLimits } from "./rate-limits";
import { runScheduled } from "./scheduled";

/**
 * One cron tick, from the Worker's `scheduled` handler (which has no request or OpenNext context,
 * so the database comes straight from the DB binding). Logs one summary line.
 */
export async function runCron(env: AppEnv & { DB: D1Database }, now: Date, db?: Db): Promise<void> {
  const database = db ?? (drizzle(env.DB, { schema }) as unknown as Db);
  const result = await runScheduled(buildScheduledDeps(env, database), now);
  let pruned = 0;
  try {
    pruned = (await pruneRateLimits(database, now)).pruned;
  } catch (e) {
    console.error("scheduled job rate-limit prune failed", e);
  }
  console.log(`scheduled: expired=${result.expired} attempted=${result.attempted} preArrival=${result.preArrival} pruned=${pruned}`);
}
