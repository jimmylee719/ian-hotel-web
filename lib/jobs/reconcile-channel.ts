import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import { cancelIfActive } from "@/lib/booking/manage";
import type { Deps } from "@/lib/booking/notify";
import { toChannelReservation } from "@/lib/booking/to-channel";
import type { LookupResult } from "@/lib/channel/types";
import { reservations } from "@/lib/db/schema";
import { addDaysISO, todayInTaipei } from "@/lib/domain/dates";

/** This job's job_runs name; the dashboard reads its latest row's mismatches. */
export const CHANNEL_RECONCILE_JOB = "channel_reconcile";
/** How far ahead (Taipei calendar days from today) stays are compared with the channel. */
export const CHANNEL_RECONCILE_DAYS = 60;
/** At most this many mismatches are kept in one run's job_runs result (and so on the dashboard). */
export const MISMATCH_LIMIT = 100;

/** A booking whose channel copy disagrees with ours in a way the job does not fix by itself: staff decide. */
export type ChannelMismatch = {
  propertyId: string; reservationId: string; code: string;
  /** Our smConfirmation (null if we hold none). */
  local: string | null;
  /** The channel's smConfirmation, and its state there. */
  channel: string; channelState: "active" | "cancelled";
};

export type ChannelReconcileResult = {
  checked: number; repushed: number; cancelled: number; lookupErrors: number; failed: number;
  mismatches: ChannelMismatch[];
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Daily (04:00 Taipei): compare every direct booking this system pushed (confirmed) or took back (cancelled,
 * confirm_failed_refunded) whose stay overlaps today..today+60 (Taipei) with what the channel holds
 * (lookupReservation), and fix what is safe to fix:
 * - confirmed here, not on the channel → pushed again (pushReservation is idempotent by code); the channel's
 *   smConfirmation is stored;
 * - cancelled / refunded here, active there → cancelled there under the channel's smConfirmation (cancelIfActive);
 * - confirmed on both sides under different smConfirmations, or confirmed here but cancelled there → reported as a
 *   mismatch (the dashboard's channel_mismatch alert, from this run's job_runs row); nothing is changed.
 * Bookings the sync-retry job currently owns (syncState pending: a push, modify or cancel in progress or queued)
 * are skipped, so the two never act on one booking at once. A failed lookup skips the booking (lookupErrors);
 * a failed push or cancel is counted (failed) and tried again tomorrow.
 */
export async function runChannelReconcile(deps: Deps, now: Date): Promise<ChannelReconcileResult> {
  const { db } = deps;
  const today = todayInTaipei(now);
  const horizon = addDaysISO(today, CHANNEL_RECONCILE_DAYS);
  const out: ChannelReconcileResult = { checked: 0, repushed: 0, cancelled: 0, lookupErrors: 0, failed: 0, mismatches: [] };

  const rows = await db.select().from(reservations)
    .where(and(
      eq(reservations.channel, "direct"),
      inArray(reservations.status, ["confirmed", "cancelled", "confirm_failed_refunded"]),
      inArray(reservations.syncState, ["synced", "failed"]),
      lte(reservations.checkIn, horizon), gt(reservations.checkOut, today),
    ))
    .orderBy(asc(reservations.checkIn), asc(reservations.id));

  for (const res of rows) {
    out.checked++;
    let l: LookupResult;
    try {
      l = await deps.channel.lookupReservation(res.code);
    } catch (e) {
      l = { error: errorText(e), retryable: true };
    }
    if ("error" in l) {
      out.lookupErrors++;
      continue;
    }
    // Written back only while the booking is as read: a staff modification or cancel since then wins.
    const unchanged = and(eq(reservations.id, res.id), eq(reservations.status, res.status), eq(reservations.syncState, res.syncState));
    try {
      if (res.status === "confirmed") {
        if (!l.found) {
          const r = await deps.channel.pushReservation(await toChannelReservation(db, res.id));
          if (!r.ok) {
            out.failed++;
            continue;
          }
          await db.update(reservations)
            .set({ smConfirmation: r.smConfirmation, syncState: "synced", nextSyncAt: null, lastSyncError: null, updatedAt: now.getTime() })
            .where(unchanged);
          out.repushed++;
        } else if (l.state === "cancelled" || l.smConfirmation !== res.smConfirmation) {
          if (out.mismatches.length < MISMATCH_LIMIT)
            out.mismatches.push({
              propertyId: res.propertyId, reservationId: res.id, code: res.code,
              local: res.smConfirmation, channel: l.smConfirmation, channelState: l.state,
            });
        }
      } else if (l.found && l.state === "active") {
        const r = await cancelIfActive(deps, res.code);
        if (!r.ok) {
          out.failed++;
          continue;
        }
        // A cancel that had given up (syncState failed) is done now; a refunded booking keeps its failure reason.
        if (res.syncState === "failed")
          await db.update(reservations)
            .set({ syncState: "synced", ...(res.status === "cancelled" ? { lastSyncError: null } : {}), updatedAt: now.getTime() })
            .where(unchanged);
        out.cancelled++;
      }
    } catch (e) {
      console.error(`channel reconcile failed for reservation ${res.id}`, e);
      out.failed++;
    }
  }
  return out;
}
