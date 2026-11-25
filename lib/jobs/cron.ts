import { lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { jobRuns } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { buildScheduledDeps } from "@/lib/runtime/deps";
import type { AppEnv } from "@/lib/runtime/env";
import { pruneRateLimits } from "./rate-limits";
import { runScheduled } from "./scheduled";

/** The job_runs name of the 5-minute cron. */
export const CRON_JOB = "cron";
/** job_runs rows are kept this long (the cron prunes older ones). */
export const JOB_RUN_RETENTION_MS = 30 * 86_400_000;

/**
 * One cron tick, from the Worker's `scheduled` handler (which has no request or OpenNext context,
 * so the database comes straight from the DB binding). Logs one summary line and records the run in
 * job_runs (its counts, or the error), pruning job_runs rows older than 30 days. Recording never fails the run.
 */
export async function runCron(env: AppEnv & { DB: D1Database }, now: Date, db?: Db): Promise<void> {
  const database = db ?? (drizzle(env.DB, { schema }) as unknown as Db);
  let result: Record<string, unknown>;
  try {
    const deps = buildScheduledDeps(env, database);
    const r = await runScheduled(deps, now, { skipSyncReason: deps.syncSkipReason, skipEmailReason: deps.emailSkipReason });
    let pruned = 0;
    try {
      pruned = (await pruneRateLimits(database, now)).pruned;
    } catch (e) {
      console.error("scheduled job rate-limit prune failed", e);
    }
    console.log(`scheduled: expired=${r.expired} attempted=${r.attempted} preArrival=${r.preArrival} pruned=${pruned}`);
    result = { ...r, pruned, syncSkipped: deps.syncSkipReason, emailSkipped: deps.emailSkipReason };
  } catch (e) {
    await recordRun(database, now, { error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  await recordRun(database, now, result);
}

async function recordRun(db: Db, startedAt: Date, result: Record<string, unknown>): Promise<void> {
  try {
    await db.insert(jobRuns).values({ name: CRON_JOB, startedAt: startedAt.getTime(), finishedAt: Math.max(Date.now(), startedAt.getTime()), result });
    await db.delete(jobRuns).where(lt(jobRuns.startedAt, startedAt.getTime() - JOB_RUN_RETENTION_MS));
  } catch (e) {
    console.error("scheduled: recording the run in job_runs failed", e);
  }
}
