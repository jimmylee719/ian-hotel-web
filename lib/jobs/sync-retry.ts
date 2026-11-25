import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { modifyWithChannel } from "@/lib/admin/modify";
import { confirmWithChannel } from "@/lib/booking/confirm";
import { cancelWithChannel } from "@/lib/booking/manage";
import type { Deps } from "@/lib/booking/notify";
import { reservations } from "@/lib/db/schema";
import { log } from "@/lib/runtime/log";

export const SYNC_RETRY_BATCH = 20;

/**
 * Drive every booking whose channel sync is due (or that a crashed request left behind):
 * - paid_pending_confirm → confirmWithChannel: push, retry, or refund;
 * - cancelled → cancelWithChannel: cancel on the channel, retry, or alert staff;
 * - confirm_failed_refunded (no push succeeded here, but one may have landed) → cancelWithChannel: look it up,
 *   cancel it on the channel if it is there, retry, or alert staff;
 * - confirmed (a staff modification not yet on the channel) → modifyWithChannel: modify, retry, or alert staff.
 * Oldest first, at most 20 per run. All take a lease, so overlapping runs never work on the same booking.
 */
export async function runSyncRetry(deps: Deps, now: Date): Promise<{ attempted: number }> {
  const due = await deps.db.select({ id: reservations.id, status: reservations.status }).from(reservations)
    .where(and(
      inArray(reservations.status, ["paid_pending_confirm", "cancelled", "confirm_failed_refunded", "confirmed"]),
      eq(reservations.syncState, "pending"),
      or(isNull(reservations.nextSyncAt), lte(reservations.nextSyncAt, now.getTime())),
    ))
    .orderBy(asc(reservations.nextSyncAt))
    .limit(SYNC_RETRY_BATCH);
  for (const { id, status } of due) {
    try {
      if (status === "cancelled" || status === "confirm_failed_refunded") await cancelWithChannel(deps, id, now);
      else if (status === "confirmed") await modifyWithChannel(deps, id, now);
      else await confirmWithChannel(deps, id, now);
    } catch (e) {
      log.error(`sync retry failed for reservation ${id}`, e);
    }
  }
  return { attempted: due.length };
}
