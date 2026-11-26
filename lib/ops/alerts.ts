import { and, desc, eq, gt } from "drizzle-orm";
import { hasSqliteError } from "@/lib/db/inventory-hold";
import { jobRuns, opsAlerts } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { renderOpsAlert } from "@/lib/email/templates";
import type { EmailSender } from "@/lib/email/types";
import { log } from "@/lib/runtime/log";
import { redact } from "@/lib/runtime/redact";

/**
 * What ops are alerted about:
 * - cron_failed: a cron job (scope: its job_runs name) failed CRON_FAILURE_STREAK runs in a row (lib/jobs/cron.ts);
 * - config_refused: assertConfig refused the config, so the cron was skipped (lib/jobs/cron.ts);
 * - reconcile_mismatch: a reconcile run (scope: its job_runs name) found what it also tells staff about
 *   (reconcileAlertDetail; lib/jobs/cron.ts);
 * - channel_sync_failed: the 5-minute cron alerted staff about bookings whose channel hand-off keeps failing
 *   (3 failures in a row, then daily; lib/jobs/sync-retry.ts) or stopped on a non-retryable error;
 * - ari_rejected: SiteMinder ARI needs a person (lib/channel/siteminder/inbound/ari.ts, after the answer): scope
 *   `mapping` at once on a 402 / 249 / 137 answer, `currency` at once on a CurrencyCode other than the property's
 *   (stored as price 0), and unscoped when ARI_REJECTION_ALERT_COUNT messages were rejected within an hour.
 */
export type OpsAlertKind = "cron_failed" | "config_refused" | "reconcile_mismatch" | "channel_sync_failed" | "ari_rejected";

/** `scope` splits one kind into separately limited alerts (e.g. per job). `detail` is redacted before it is sent. */
export type OpsAlert = { kind: OpsAlertKind; detail: string; scope?: string };

export type OpsDeps = { db: Db; email: EmailSender; opsEmails: string[]; environment: string };

/** Each alert key (kind[:scope]) emails ops at most once per this long. */
export const OPS_ALERT_WINDOW_MS = 3600_000;
/** A cron job failing this many runs in a row (its latest job_runs rows all `{ error }`) alerts ops. */
export const CRON_FAILURE_STREAK = 3;

export type OpsAlertResult = "sent" | "failed" | "duplicate" | "no_recipients";

const TITLES: Record<OpsAlertKind, string> = {
  cron_failed: "排程工作連續失敗",
  config_refused: "設定被拒絕，網站與排程已停止",
  reconcile_mismatch: "對帳發現不一致，需人工處理",
  channel_sync_failed: "訂單尚未同步到 SiteMinder，需人工處理",
  ari_rejected: "SiteMinder ARI 需要人工處理",
};

/**
 * Email every OPS_EMAILS address about `alert`, at most once per key per hour (the ops_alerts table: a key with a
 * row in the last hour is a "duplicate"; its unique (key, hour) index stops two concurrent runs from both sending).
 * The row is claimed before sending, so a refused send is recorded "failed" and still counts for the hour.
 * Without OPS_EMAILS the alert is only logged. Never throws (alerts run inside jobs that must carry on).
 */
export async function notifyOps(deps: OpsDeps, alert: OpsAlert, now: Date = new Date()): Promise<OpsAlertResult> {
  const key = alert.scope ? `${alert.kind}:${alert.scope}` : alert.kind;
  const detail = redact(alert.detail);
  if (deps.opsEmails.length === 0) {
    log.warn(`ops alert ${key} not emailed (OPS_EMAILS not set): ${detail}`);
    return "no_recipients";
  }
  try {
    const [recent] = await deps.db.select({ id: opsAlerts.id }).from(opsAlerts)
      .where(and(eq(opsAlerts.key, key), gt(opsAlerts.at, now.getTime() - OPS_ALERT_WINDOW_MS))).limit(1);
    if (recent) return "duplicate";
    const id = crypto.randomUUID();
    try {
      await deps.db.insert(opsAlerts).values({ id, key, hour: Math.floor(now.getTime() / OPS_ALERT_WINDOW_MS), status: "sent", at: now.getTime() });
    } catch (e) {
      if (hasSqliteError(e, "UNIQUE constraint failed")) return "duplicate";
      throw e;
    }
    const rendered = renderOpsAlert({ key, title: TITLES[alert.kind], detail, environment: deps.environment, at: now });
    let ok = true;
    for (const to of deps.opsEmails) {
      const r = await deps.email.send({ to, ...rendered }).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
      if (!r.ok) {
        ok = false;
        log.error(`ops alert ${key} to ${to} failed: ${r.error}`);
      }
    }
    if (!ok) await deps.db.update(opsAlerts).set({ status: "failed" }).where(eq(opsAlerts.id, id));
    return ok ? "sent" : "failed";
  } catch (e) {
    log.error(`notifyOps ${key} failed`, e);
    return "failed";
  }
}

/**
 * After a job_runs row for `name` was written: if the latest CRON_FAILURE_STREAK rows of that job are all failures
 * (`{ error }`), alert ops (cron_failed, scoped by job; so at most hourly while it keeps failing). Never throws.
 */
export async function alertOnFailureStreak(deps: OpsDeps, name: string, now: Date): Promise<void> {
  try {
    const rows = await deps.db.select({ startedAt: jobRuns.startedAt, result: jobRuns.result }).from(jobRuns)
      .where(eq(jobRuns.name, name)).orderBy(desc(jobRuns.startedAt), desc(jobRuns.id)).limit(CRON_FAILURE_STREAK);
    if (rows.length < CRON_FAILURE_STREAK || !rows.every((r) => typeof r.result.error === "string")) return;
    const errors = rows.map((r) => `- ${new Date(r.startedAt).toISOString()} ${String(r.result.error)}`);
    await notifyOps(deps, {
      kind: "cron_failed", scope: name,
      detail: `${name} failed ${CRON_FAILURE_STREAK} runs in a row. Latest first:\n${errors.join("\n")}`,
    }, now);
  } catch (e) {
    log.error(`ops: checking ${name}'s failure streak failed`, e);
  }
}

/** How many booking codes a reconcile alert lists (the rest are on /admin and in job_runs). */
const CODES_LISTED = 20;

/**
 * The ops alert text for a reconcile run's result, or null when it found nothing ops must hear about. These are the
 * outcomes that already alert staff (each booking once, by notifyStaff) or raise a dashboard alert; ops get one
 * summary per job per hour, never a second email to staff:
 * - channel_reconcile: mismatches (channel_mismatch), failed (a CHANNEL_MISSING re-push or a channel cancel that
 *   failed), lookupErrors (the channel did not answer);
 * - gateway_reconcile: refundsFailed (refund marked failed), flowsFailed (a settled refund whose flow would not finish).
 * Skipped runs and anything else: null.
 */
export function reconcileAlertDetail(name: string, result: object): string | null {
  const r = result as Record<string, unknown>;
  const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : 0);
  const parts: string[] = [];
  if (Array.isArray(r.mismatches) && r.mismatches.length > 0) {
    const codes = (r.mismatches as { code?: unknown }[]).map((m) => String(m.code));
    parts.push(`channel_mismatch=${codes.length}: ${codes.slice(0, CODES_LISTED).join(", ")}${codes.length > CODES_LISTED ? ", …" : ""}`);
  }
  for (const k of ["failed", "lookupErrors", "refundsFailed", "flowsFailed"]) if (n(k) > 0) parts.push(`${k}=${n(k)}`);
  return parts.length ? `${name}: ${parts.join("; ")}` : null;
}
