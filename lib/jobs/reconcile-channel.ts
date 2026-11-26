import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import { releasePropertyLease, takePropertyLease } from "@/lib/booking/channel-sync";
import { notifyStaff, type Deps } from "@/lib/booking/notify";
import { toChannelReservation } from "@/lib/booking/to-channel";
import type { CancelResult, LookupResult, PushResult } from "@/lib/channel/types";
import { notifications, reservations } from "@/lib/db/schema";
import { addDaysISO, todayInTaipei } from "@/lib/domain/dates";
import { CallBudget, type StoppedEarly } from "./budget";
import { log } from "@/lib/runtime/log";

/** This job's job_runs name; the dashboard reads its latest row's mismatches. */
export const CHANNEL_RECONCILE_JOB = "channel_reconcile";
/** How far ahead (Taipei calendar days from today) stays are compared with the channel. */
export const CHANNEL_RECONCILE_DAYS = 60;
/** At most this many mismatches are kept in one run's job_runs result (and so on the dashboard). */
export const MISMATCH_LIMIT = 100;
/** A run stops issuing channel calls this long after it started. */
export const CHANNEL_RECONCILE_BUDGET_MS = 20 * 60_000;

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
  /** Fixes not made because another channel call held the property's lease (one in flight per hotel); tomorrow. */
  deferred?: number;
  /** Set when the channel cannot be asked what it holds (SiteMinder has no lookup, doc §8.3): nothing was checked. */
  unsupported?: "NO_LOOKUP";
  /** Set when the run stopped issuing channel calls early: its wall-clock budget ran out, or too many errors in a row. */
  stoppedEarly?: StoppedEarly;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** lastSyncError prefix of a confirmed booking the channel does not hold and that could not be pushed again. */
export const CHANNEL_MISSING = "CHANNEL_MISSING";
/** The staff alert's ref (+ Taipei date) for a run with lookup errors: one email a day. */
export const CHANNEL_LOOKUP_ERRORS_REF = "channel-lookup-errors:";

/**
 * Daily (04:00 Taipei): compare every direct booking this system pushed (confirmed) or took back (cancelled,
 * confirm_failed_refunded) whose stay overlaps today..today+60 (Taipei) with what the channel holds
 * (lookupReservation), and fix what is safe to fix:
 * - confirmed here, not on the channel → pushed again (pushReservation is idempotent by code); the channel's
 *   smConfirmation is stored (a failure: see below);
 * - cancelled / refunded here, active there → cancelled there under the smConfirmation the lookup reported;
 * - confirmed on both sides under different smConfirmations, or confirmed here but cancelled there → reported as a
 *   mismatch (the dashboard's channel_mismatch alert, from this run's job_runs row); nothing is changed.
 * Bookings the sync-retry job currently owns (syncState pending: a push, modify or cancel in progress or queued)
 * are skipped, so the two never act on one booking at once. A failed lookup skips the booking (lookupErrors) and
 * staff are emailed once that day; a failed re-push marks the booking syncState failed with lastSyncError
 * `CHANNEL_MISSING: <error>` (the dashboard's sync_failed alert) and emails staff once that day; a failed cancel is
 * counted (failed). Failed rows stay in this job's set, so all of these are tried again tomorrow.
 * The run stops issuing channel calls 20 minutes after it started, or after 5 errors in a row (lib/jobs/budget.ts),
 * and records `stoppedEarly`; the bookings it did not reach are checked tomorrow.
 * A re-push or cancel is made under the property's channel lease (one message in flight per hotel); if another call
 * holds it, that fix waits for tomorrow (`deferred`). A channel without lookup (SiteMinder) cannot be compared at
 * all: the run returns `unsupported: "NO_LOOKUP"` and the sync job's durable retries are the only safety net.
 */
export async function runChannelReconcile(
  deps: Deps, now: Date, o: { clock?: () => number } = {},
): Promise<ChannelReconcileResult> {
  const budget = new CallBudget(CHANNEL_RECONCILE_BUDGET_MS, o.clock);
  // Leases go by the real clock, never the run's scheduled `now`.
  const leaseClock = o.clock ?? deps.clock ?? Date.now;
  const { db } = deps;
  const today = todayInTaipei(now);
  const horizon = addDaysISO(today, CHANNEL_RECONCILE_DAYS);
  const out: ChannelReconcileResult = { checked: 0, repushed: 0, cancelled: 0, lookupErrors: 0, failed: 0, mismatches: [] };
  const lookup = deps.channel.lookupReservation?.bind(deps.channel);
  if (!lookup) return { ...out, unsupported: "NO_LOOKUP" };
  let firstLookupError: typeof reservations.$inferSelect | undefined;

  const rows = await db.select().from(reservations)
    .where(and(
      eq(reservations.channel, "direct"),
      inArray(reservations.status, ["confirmed", "cancelled", "confirm_failed_refunded"]),
      inArray(reservations.syncState, ["synced", "failed"]),
      lte(reservations.checkIn, horizon), gt(reservations.checkOut, today),
    ))
    .orderBy(asc(reservations.checkIn), asc(reservations.id));

  for (const res of rows) {
    if (!budget.canCall()) break;
    out.checked++;
    let l: LookupResult;
    try {
      l = await lookup(res.code);
    } catch (e) {
      l = { error: errorText(e), retryable: true };
    }
    budget.record(!("error" in l));
    if ("error" in l) {
      out.lookupErrors++;
      firstLookupError ??= res;
      continue;
    }
    // Written back only while the booking is as read: a staff modification or cancel since then wins.
    const unchanged = and(eq(reservations.id, res.id), eq(reservations.status, res.status), eq(reservations.syncState, res.syncState));
    // The fix below is a channel message: made only under the property's lease.
    const fixes = res.status === "confirmed" ? !l.found : l.found && l.state === "active";
    const holder = fixes ? await takePropertyLease(db, res.propertyId, leaseClock) : null;
    if (fixes && !holder) {
      out.deferred = (out.deferred ?? 0) + 1;
      continue;
    }
    try {
      if (res.status === "confirmed") {
        if (!l.found) {
          let r: PushResult;
          try {
            r = await deps.channel.pushReservation(await toChannelReservation(db, res.id));
          } catch (e) {
            r = { ok: false, retryable: true, error: errorText(e) };
          }
          budget.record(r.ok || !r.retryable);
          if (!r.ok) {
            // Confirmed here, not held there: the room can be sold twice. A red alert (sync_failed) and on-duty
            // staff told (spec §5.3); the row stays in this job's set, so tomorrow's run pushes again.
            const marked = await db.update(reservations)
              .set({ syncState: "failed", nextSyncAt: null, lastSyncError: `${CHANNEL_MISSING}: ${r.error}`, lastSyncAt: now.getTime(), updatedAt: now.getTime() })
              .where(unchanged).returning({ id: reservations.id });
            if (marked.length) await notifyStaff(deps, res.id, "staff_sync_failed", now, {}, `channel-missing:${today}`);
            out.failed++;
            continue;
          }
          await db.update(reservations)
            .set({ smConfirmation: r.smConfirmation, syncState: "synced", nextSyncAt: null, lastSyncError: null, channelSyncedAt: leaseClock(), updatedAt: now.getTime() })
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
        // Cancelled (or refunded) here, active there: cancel it under the smConfirmation the channel reported.
        const r: CancelResult = await toChannelReservation(db, res.id)
          .then((body) => deps.channel.cancelReservation(body, l.smConfirmation))
          .catch((e: unknown) => ({ ok: false as const, retryable: true, error: errorText(e) }));
        budget.record(r.ok || !r.retryable);
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
      log.error(`channel reconcile failed for reservation ${res.id}`, e);
      out.failed++;
    } finally {
      if (holder) await releasePropertyLease(db, res.propertyId, holder);
    }
  }
  // The channel would not answer for some bookings: nothing was changed for them, but staff should know the
  // channel is not being checked. One email a day (anchored on the first such booking).
  if (firstLookupError) await alertLookupErrors(deps, firstLookupError.id, out.lookupErrors, today, now);
  if (budget.stoppedEarly) out.stoppedEarly = budget.stoppedEarly;
  return out;
}

/** Staff alert (staff_sync_failed) for a run with lookup errors, at most once per Taipei day across all runs. */
async function alertLookupErrors(deps: Deps, reservationId: string, count: number, today: string, now: Date): Promise<void> {
  const ref = `${CHANNEL_LOOKUP_ERRORS_REF}${today}`;
  const [sent] = await deps.db.select({ id: notifications.id }).from(notifications)
    .where(and(eq(notifications.kind, "staff_sync_failed"), eq(notifications.ref, ref))).limit(1);
  if (sent) return;
  log.error(`channel reconcile: ${count} lookup(s) failed`);
  await notifyStaff(deps, reservationId, "staff_sync_failed", now, {}, ref);
}
