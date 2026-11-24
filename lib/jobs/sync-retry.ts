import { and, asc, eq, lte } from "drizzle-orm";
import { confirmWithChannel } from "@/lib/booking/confirm";
import type { Deps } from "@/lib/booking/notify";
import { reservations } from "@/lib/db/schema";

export const SYNC_RETRY_BATCH = 20;

/** Retry pushing paid reservations whose SiteMinder sync is due, oldest first, at most 20 per run. */
export async function runSyncRetry(deps: Deps, now: Date): Promise<{ attempted: number }> {
  const due = await deps.db.select({ id: reservations.id }).from(reservations)
    .where(and(
      eq(reservations.status, "paid_pending_confirm"),
      eq(reservations.syncState, "pending"),
      lte(reservations.nextSyncAt, now.getTime()),
    ))
    .orderBy(asc(reservations.nextSyncAt))
    .limit(SYNC_RETRY_BATCH);
  for (const { id } of due) {
    try {
      await confirmWithChannel(deps, id, now);
    } catch (e) {
      console.error(`sync retry failed for reservation ${id}`, e);
    }
  }
  return { attempted: due.length };
}
