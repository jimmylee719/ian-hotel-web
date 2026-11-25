import type { Deps } from "@/lib/booking/notify";
import { runExpireHolds } from "./expire-holds";
import { runPreArrival } from "./pre-arrival";
import { runSyncRetry } from "./sync-retry";
import { log } from "@/lib/runtime/log";

export type ScheduledResult = { expired: number; attempted: number; preArrival: number };

/**
 * The 5-minute cron: expire lapsed holds, retry due channel syncs, send pre-arrival emails.
 * Each runs on its own: one throwing is logged and counts as 0, and never stops the others.
 * `skipSyncReason` (channel/payments not configured) skips only the sync retry, with a warning.
 * `skipEmailReason` (production without BASE_URL) skips the jobs that email guests (sync retry sends
 * refund emails; pre-arrival), with an error: their links would point nowhere valid.
 */
export async function runScheduled(
  deps: Deps, now: Date, opts: { skipSyncReason?: string | null; skipEmailReason?: string | null } = {},
): Promise<ScheduledResult> {
  const attempt = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (e) {
      log.error(`scheduled job ${name} failed`, e);
      return null;
    }
  };
  const expired = await attempt("expire-holds", () => runExpireHolds(deps, now));
  if (opts.skipEmailReason) log.error(`scheduled: sync retry and pre-arrival emails skipped (${opts.skipEmailReason})`);
  else if (opts.skipSyncReason) log.warn(`scheduled: sync retry skipped (${opts.skipSyncReason})`);
  const skipSync = opts.skipEmailReason || opts.skipSyncReason;
  const retried = skipSync ? null : await attempt("sync-retry", () => runSyncRetry(deps, now));
  const arrival = opts.skipEmailReason ? null : await attempt("pre-arrival", () => runPreArrival(deps, now));
  return { expired: expired?.expired ?? 0, attempted: retried?.attempted ?? 0, preArrival: arrival?.sent ?? 0 };
}
