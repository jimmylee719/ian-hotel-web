import { and, asc, eq, gte, inArray, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { CHANNEL_ALERT_AFTER, CHANNEL_SYNC_STATUSES, syncWithChannel } from "@/lib/booking/channel-sync";
import { confirmPaid } from "@/lib/booking/confirm";
import { notifyStaff, type Deps } from "@/lib/booking/notify";
import { notifications, reservations } from "@/lib/db/schema";
import { todayInTaipei } from "@/lib/domain/dates";
import { log } from "@/lib/runtime/log";

export const SYNC_RETRY_BATCH = 20;
/** A run starts no channel call this long after it began (each call may take up to 120 s; the cron runs every 5 min). */
export const SYNC_RUN_BUDGET_MS = 4 * 60_000;
/** At most this many unsynced bookings are alerted about per run (the rest follow at the next runs). */
export const UNSYNCED_ALERT_BATCH = 50;
/** The staff alert's ref (+ Taipei date) for a booking not yet on the channel: one email per booking per day. */
export const UNSYNCED_REF = "channel-unsynced:";

export type SyncRetryResult = {
  attempted: number;
  /** Codes of the bookings staff were alerted about in this run (absent when none). */
  alerted?: string[];
};

/**
 * Every 5 minutes (the cron): drive each booking whose step is due, oldest first, at most 20 per run:
 * - paid_pending_confirm (a request died before confirming it) → confirmPaid: confirm locally, or refund a genuine
 *   payment problem;
 * - confirmed / cancelled (and legacy refunded) with syncState pending → syncWithChannel: push, modify or cancel at
 *   the channel, one call per property at a time (a booking whose property is busy waits for the next run and is not
 *   counted). Failures back off (5, 10, 20, 40 min, then hourly) and are retried until they succeed.
 * Channel calls stop starting SYNC_RUN_BUDGET_MS into the run (by `clock`, the real clock; tests inject one).
 * Then staff are alerted (alertUnsynced) about bookings that keep failing.
 */
export async function runSyncRetry(deps: Deps, now: Date, o: { clock?: () => number } = {}): Promise<SyncRetryResult> {
  const clock = o.clock ?? Date.now;
  const deadline = clock() + SYNC_RUN_BUDGET_MS;
  const due = await deps.db.select({ id: reservations.id, status: reservations.status }).from(reservations)
    .where(and(
      inArray(reservations.status, ["paid_pending_confirm", ...CHANNEL_SYNC_STATUSES]),
      eq(reservations.syncState, "pending"),
      or(isNull(reservations.nextSyncAt), lte(reservations.nextSyncAt, now.getTime())),
    ))
    .orderBy(asc(reservations.nextSyncAt), asc(reservations.createdAt), asc(reservations.id))
    .limit(SYNC_RETRY_BATCH);
  let attempted = 0;
  for (const { id, status } of due) {
    try {
      if (status === "paid_pending_confirm") {
        await confirmPaid(deps, id, now);
        attempted++;
        continue;
      }
      if (clock() >= deadline) break;
      const outcome = await syncWithChannel(deps, id, now);
      if (outcome !== "busy" && outcome !== "not_due" && outcome !== "not_configured") attempted++;
    } catch (e) {
      log.error(`sync retry failed for reservation ${id}`, e);
    }
  }
  let alerted: string[] = [];
  try {
    alerted = await alertUnsynced(deps, now);
  } catch (e) {
    log.error("sync retry: alerting unsynced bookings failed", e);
  }
  return { attempted, ...(alerted.length ? { alerted } : {}) };
}

/**
 * Tell staff (staff_sync_failed) about each direct booking whose channel copy is not up to date and is not getting
 * there by itself: CHANNEL_ALERT_AFTER (3) or more failed hand-offs in a row, or a non-retryable failure (syncState
 * failed: it waits for a staff retry). Once per booking per Taipei day (ref `channel-unsynced:<date>`), for as long
 * as it stays so: never given up silently. Returns the codes alerted (the cron also alerts ops about them).
 */
export async function alertUnsynced(deps: Deps, now: Date): Promise<string[]> {
  const ref = `${UNSYNCED_REF}${todayInTaipei(now)}`;
  const rows = await deps.db.select({ id: reservations.id, code: reservations.code }).from(reservations)
    .where(and(
      eq(reservations.channel, "direct"),
      inArray(reservations.status, ["confirmed", "cancelled"]),
      or(
        and(eq(reservations.syncState, "pending"), gte(reservations.syncAttempts, CHANNEL_ALERT_AFTER)),
        eq(reservations.syncState, "failed"),
      ),
      notExists(deps.db.select({ one: sql`1` }).from(notifications).where(and(
        eq(notifications.reservationId, reservations.id), eq(notifications.kind, "staff_sync_failed"), eq(notifications.ref, ref),
      ))),
    ))
    .orderBy(asc(reservations.createdAt), asc(reservations.id))
    .limit(UNSYNCED_ALERT_BATCH);
  for (const r of rows) await notifyStaff(deps, r.id, "staff_sync_failed", now, {}, ref);
  return rows.map((r) => r.code);
}
