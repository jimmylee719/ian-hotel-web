import { lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { jobRuns } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { alertOnFailureStreak, notifyOps, reconcileAlertDetail, type OpsDeps } from "@/lib/ops/alerts";
import { configRefusal } from "@/lib/runtime/config-guard";
import { buildOpsDeps, buildScheduledDeps, type ScheduledDeps } from "@/lib/runtime/deps";
import type { AppEnv } from "@/lib/runtime/env";
import { log } from "@/lib/runtime/log";
import { redact } from "@/lib/runtime/redact";
import { pruneRateLimits } from "./rate-limits";
import { CHANNEL_RECONCILE_JOB, runChannelReconcile } from "./reconcile-channel";
import { runGatewayReconcile } from "./reconcile-gateway";
import { runScheduled } from "./scheduled";

/** The job_runs name of the 5-minute cron. */
export const CRON_JOB = "cron";
/** The job_runs names of the reconcile jobs (lib/jobs/reconcile-*.ts). */
export const GATEWAY_RECONCILE_JOB = "gateway_reconcile";
export { CHANNEL_RECONCILE_JOB };

/** The Worker's cron triggers (wrangler.jsonc, top level and every env). Each fires its own `scheduled` event. */
export const CRON_EVERY_5_MIN = "*/5 * * * *";
export const CRON_GATEWAY_RECONCILE = "*/15 * * * *";
/** 20:00 UTC = 04:00 Asia/Taipei (UTC+8, no DST). */
export const CRON_CHANNEL_RECONCILE = "0 20 * * *";
/** job_runs rows are kept this long (the cron prunes older ones). */
export const JOB_RUN_RETENTION_MS = 30 * 86_400_000;

/**
 * One cron tick, from the Worker's `scheduled` handler (which has no request or OpenNext context,
 * so the database comes straight from the DB binding). Logs one summary line and records the run in
 * job_runs (its counts, or the error), pruning job_runs rows older than 30 days. Recording never fails the run.
 * A config assertConfig refuses skips the run (refusedRun). Ops are alerted after CRON_FAILURE_STREAK failures in a row.
 */
export async function runCron(env: AppEnv & { DB: D1Database }, now: Date, db?: Db): Promise<void> {
  const database = db ?? (drizzle(env.DB, { schema }) as unknown as Db);
  const ops = buildOpsDeps(env, database);
  if (await refusedRun(env, CRON_JOB, now, database, ops)) return;
  let result: Record<string, unknown>;
  try {
    const deps = buildScheduledDeps(env, database);
    const r = await runScheduled(deps, now, { skipSyncReason: deps.syncSkipReason, skipEmailReason: deps.emailSkipReason });
    let pruned = 0;
    try {
      pruned = (await pruneRateLimits(database, now)).pruned;
    } catch (e) {
      log.error("scheduled job rate-limit prune failed", e);
    }
    log.info(`scheduled: expired=${r.expired} attempted=${r.attempted} preArrival=${r.preArrival} pruned=${pruned}`);
    result = { ...r, pruned, syncSkipped: deps.syncSkipReason, emailSkipped: deps.emailSkipReason };
  } catch (e) {
    await recordRun(database, now, { error: e instanceof Error ? e.message : String(e) }, CRON_JOB, ops);
    throw e;
  }
  await recordRun(database, now, result, CRON_JOB, ops);
}

/**
 * The scheduled entry's config check (lib/runtime/config-guard.ts): when the config is refused, the run is skipped,
 * logged, recorded in job_runs as `{ skipped: "CONFIG_REFUSED", error }` (so the dashboard shows it and it counts
 * towards the failure streak) and ops are alerted (config_refused, at most hourly). Returns true when refused.
 */
async function refusedRun(env: AppEnv, name: string, now: Date, db: Db, ops: OpsDeps): Promise<boolean> {
  const reason = configRefusal(env);
  if (!reason) return false;
  log.error(`scheduled: ${name} skipped: ${reason}`);
  await recordRun(db, now, { skipped: "CONFIG_REFUSED", error: reason }, name, ops);
  await notifyOps(ops, { kind: "config_refused", detail: `${name} skipped. ${reason}` }, now);
  return true;
}

/**
 * The Worker's `scheduled` handler: run the job of the trigger that fired (`cron` is ScheduledController.cron).
 * An unknown expression runs the 5-minute cron, as before there were several triggers.
 */
export async function runCronTrigger(env: AppEnv & { DB: D1Database }, cron: string, now: Date, db?: Db): Promise<void> {
  if (cron === CRON_GATEWAY_RECONCILE) return runReconcileJob(env, GATEWAY_RECONCILE_JOB, now, db, runGatewayReconcile);
  if (cron === CRON_CHANNEL_RECONCILE) return runReconcileJob(env, CHANNEL_RECONCILE_JOB, now, db, runChannelReconcile);
  return runCron(env, now, db);
}

/**
 * One reconcile run with the scheduled deps. Skipped (and recorded as such) when payments/channel are not
 * configured, or when guest emails cannot be sent (production without BASE_URL): finishing a cancellation or a
 * booking emails the guest. Never throws: the error is recorded in job_runs. A refused config skips it
 * (refusedRun); a run whose result staff are alerted about also alerts ops (reconcile_mismatch, reconcileAlertDetail).
 */
async function runReconcileJob(
  env: AppEnv & { DB: D1Database }, name: string, now: Date, db: Db | undefined,
  run: (deps: ScheduledDeps, now: Date) => Promise<object>,
): Promise<void> {
  const database = db ?? (drizzle(env.DB, { schema }) as unknown as Db);
  const ops = buildOpsDeps(env, database);
  if (await refusedRun(env, name, now, database, ops)) return;
  const r = await recordJob(database, name, now, async () => {
    const deps = buildScheduledDeps(env, database);
    const skipped = deps.emailSkipReason ?? deps.syncSkipReason;
    if (skipped) {
      log.warn(`scheduled: ${name} skipped (${skipped})`);
      return { skipped };
    }
    const r = await run(deps, now);
    log.info(`scheduled: ${name} ${JSON.stringify(r)}`);
    return r;
  }, ops);
  const detail = r && reconcileAlertDetail(name, r);
  if (detail) await notifyOps(ops, { kind: "reconcile_mismatch", scope: name, detail }, now);
}

/**
 * Run `job` and record it in job_runs under `name`: its result, or `{ error }` if it throws (logged, not rethrown,
 * so a reconcile job never fails the Worker's scheduled event). Returns the result (undefined on error).
 * With `ops`, a failure that completes a streak of CRON_FAILURE_STREAK alerts ops (alertOnFailureStreak).
 */
export async function recordJob<T extends object>(
  db: Db, name: string, startedAt: Date, job: () => Promise<T>, ops?: OpsDeps,
): Promise<T | undefined> {
  let result: T | undefined;
  try {
    result = await job();
  } catch (e) {
    log.error(`scheduled job ${name} failed`, e);
    await recordRun(db, startedAt, { error: e instanceof Error ? e.message : String(e) }, name, ops);
    return undefined;
  }
  await recordRun(db, startedAt, result as Record<string, unknown>, name, ops);
  return result;
}

/** Write the job_runs row (the error text redacted) and prune old rows; then, for a failure, check the streak. */
async function recordRun(db: Db, startedAt: Date, result: Record<string, unknown>, name = CRON_JOB, ops?: OpsDeps): Promise<void> {
  const failed = typeof result.error === "string";
  const row = failed ? { ...result, error: redact(result.error as string) } : result;
  try {
    await db.insert(jobRuns).values({ name, startedAt: startedAt.getTime(), finishedAt: Math.max(Date.now(), startedAt.getTime()), result: row });
    await db.delete(jobRuns).where(lt(jobRuns.startedAt, startedAt.getTime() - JOB_RUN_RETENTION_MS));
  } catch (e) {
    log.error("scheduled: recording the run in job_runs failed", e);
    return;
  }
  if (failed && ops) await alertOnFailureStreak(ops, name, startedAt);
}
