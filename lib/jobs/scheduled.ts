import type { Deps } from "@/lib/booking/notify";
import { runExpireHolds } from "./expire-holds";
import { runPreArrival } from "./pre-arrival";
import { runSyncRetry } from "./sync-retry";

export type ScheduledResult = { expired: number; attempted: number; preArrival: number };

/**
 * The 5-minute cron: expire lapsed holds, retry due channel syncs, send pre-arrival emails.
 * Each runs on its own: one throwing is logged and counts as 0, and never stops the others.
 */
export async function runScheduled(deps: Deps, now: Date): Promise<ScheduledResult> {
  const attempt = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (e) {
      console.error(`scheduled job ${name} failed`, e);
      return null;
    }
  };
  const expired = await attempt("expire-holds", () => runExpireHolds(deps, now));
  const retried = await attempt("sync-retry", () => runSyncRetry(deps, now));
  const arrival = await attempt("pre-arrival", () => runPreArrival(deps, now));
  return { expired: expired?.expired ?? 0, attempted: retried?.attempted ?? 0, preArrival: arrival?.sent ?? 0 };
}
