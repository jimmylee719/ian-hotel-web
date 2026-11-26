import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { CHANNEL_MAX_TIMEOUT_MS, type CancelResult, type PushResult } from "@/lib/channel/types";
import { channelLeases, reservations } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { log } from "@/lib/runtime/log";
import type { Deps } from "./notify";
import type { Reservation } from "./state";
import { toChannelReservation } from "./to-channel";

/**
 * The hand-off of a booking to the channel (SiteMinder), after it was decided here. A paid booking is confirmed
 * locally first (confirmPaid); everything below runs afterwards, in the background, and its failures never change
 * the booking or its money: they are retried and, if they keep failing, staff are told (lib/jobs/sync-retry.ts).
 *
 * The rules, from the SiteConnect docs (docs/integrations/siteminder.md §3, §8):
 * - one message in flight per hotel (§8.7): every call is made under the property's lease (channel_leases);
 * - the first message is the push (Commit); a modify or cancel is sent only once that push has succeeded
 *   (smConfirmation stored). A change made before then simply goes out as the push;
 * - a cancel of a booking never pushed (channelPushedAt null) sends nothing;
 * - there is no lookup (§8.3): a push whose answer was lost is recovered by sending the same code again
 *   (SITEMINDER-OPEN-Q1), which is also how a cancel finds the smConfirmation of such a push;
 * - nothing is sent after a cancel succeeded (§8.6): the booking is then synced and never pending again.
 */

/**
 * How long one worker owns a property's channel lease: one call, at most CHANNEL_MAX_TIMEOUT_MS (120 s), plus a
 * minute of margin for our own work around it. A second call under the same lease renews it first.
 */
export const SYNC_LEASE_MS = CHANNEL_MAX_TIMEOUT_MS + 60_000;
/** Consecutive failed hand-offs after which staff are alerted (then again each Taipei day it stays unsynced). */
export const CHANNEL_ALERT_AFTER = 3;
const FIRST_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 60 * 60_000;

/** The wait after the n-th consecutive failure: 5, 10, 20, 40 minutes, then hourly, forever (never given up). */
export function retryDelayMs(attempts: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
}

/** The statuses whose channel copy the sync keeps: live bookings, cancelled ones, and (legacy) refunded ones. */
export const CHANNEL_SYNC_STATUSES = ["confirmed", "cancelled", "confirm_failed_refunded"] as const;

/** lastSyncError prefix of a modification refund that did not go through; a later channel success keeps it. */
export const MODIFY_REFUND_FAILED = "MODIFY_REFUND_FAILED";

/** Take `propertyId`'s channel lease until now + SYNC_LEASE_MS, unless another holder's lease is still running. */
export async function takePropertyLease(db: Db, propertyId: string, now: Date): Promise<string | null> {
  const holder = crypto.randomUUID();
  const until = now.getTime() + SYNC_LEASE_MS;
  const rows = await db.insert(channelLeases).values({ propertyId, holder, until })
    .onConflictDoUpdate({ target: channelLeases.propertyId, set: { holder, until }, setWhere: lte(channelLeases.until, now.getTime()) })
    .returning({ holder: channelLeases.holder });
  return rows[0]?.holder === holder ? holder : null;
}

/** Extend a lease this worker still holds; false if it lapsed and someone else took it. */
async function renewPropertyLease(db: Db, propertyId: string, holder: string, now: Date): Promise<boolean> {
  const rows = await db.update(channelLeases).set({ until: now.getTime() + SYNC_LEASE_MS })
    .where(and(eq(channelLeases.propertyId, propertyId), eq(channelLeases.holder, holder))).returning({ h: channelLeases.holder });
  return rows.length === 1;
}

/** Give the lease back, if this worker still holds it. */
export async function releasePropertyLease(db: Db, propertyId: string, holder: string): Promise<void> {
  await db.delete(channelLeases).where(and(eq(channelLeases.propertyId, propertyId), eq(channelLeases.holder, holder)));
}

/**
 * What one sync did: `synced` / `not_required` (done), `retry` (retryable failure, backed off), `failed` (not
 * retryable: waits for staff), `busy` (another call holds the property; left due), `not_due` (nothing to do now),
 * `not_configured` (no channel configured; left due).
 */
export type SyncOutcome = "synced" | "not_required" | "retry" | "failed" | "busy" | "not_due" | "not_configured";

/** At most this many channel calls under one lease: a push, then the modify or cancel that was waiting on it. */
const MAX_STEPS = 3;

/**
 * Bring the channel's copy of one booking up to date, if its sync is due (syncState pending, nextSyncAt reached).
 * Under the property's lease, re-reads the booking and sends what it needs (see the rules above): a push for a
 * confirmed booking the channel does not hold yet, a modify for one it holds, a cancel for a cancelled one it
 * holds (first re-sending the push of one whose push answer was lost), nothing for one never pushed.
 * Safe from any number of workers at once.
 */
export async function syncWithChannel(deps: Deps, reservationId: string, now: Date): Promise<SyncOutcome> {
  const { db } = deps;
  if (deps.channel.disabled) return "not_configured";
  const first = await dueRow(db, reservationId, now);
  if (!first) return "not_due";
  const holder = await takePropertyLease(db, first.propertyId, now);
  if (!holder) return "busy";
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (step > 0 && !await renewPropertyLease(db, first.propertyId, holder, now)) return "busy";
      const res = await dueRow(db, reservationId, now);
      if (!res) return "not_due";
      const outcome = await syncStep(deps, res, now);
      if (outcome !== "more") return outcome;
    }
    return "retry"; // still due: the retry job carries on
  } finally {
    await releasePropertyLease(db, first.propertyId, holder);
  }
}

/**
 * Run syncWithChannel for a booking just handed off (confirmed, modified, cancelled, or retried by staff): in the
 * background when the request can carry on without it (`deps.defer`), else inline. Never throws: the booking's
 * own change has committed, and the retry job is the safety net.
 */
export async function kickChannelSync(deps: Deps, reservationId: string, now: Date): Promise<void> {
  const run = syncWithChannel(deps, reservationId, now).then(
    () => undefined,
    (e: unknown) => log.error(`channel sync failed for reservation ${reservationId}`, e),
  );
  if (deps.defer) deps.defer(run);
  else await run;
}

async function dueRow(db: Db, reservationId: string, now: Date): Promise<Reservation | undefined> {
  const [res] = await db.select().from(reservations).where(and(
    eq(reservations.id, reservationId), inArray(reservations.status, [...CHANNEL_SYNC_STATUSES]),
    eq(reservations.syncState, "pending"), or(isNull(reservations.nextSyncAt), lte(reservations.nextSyncAt, now.getTime())),
  ));
  return res;
}

type Action = "push" | "modify" | "cancel" | "none";

function actionFor(res: Reservation): Action {
  if (res.status === "confirmed") return res.smConfirmation ? "modify" : "push";
  // Cancelled (or refunded): cancel what the channel holds. Without its smConfirmation, a push that may have landed
  // (its answer lost) is sent again first, which returns it (SITEMINDER-OPEN-Q1); a booking never pushed needs nothing.
  if (res.smConfirmation) return "cancel";
  return res.channelPushedAt != null ? "push" : "none";
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One channel call for `res` (read under the lease) and its result written back. "more" = another call follows now. */
async function syncStep(deps: Deps, res: Reservation, now: Date): Promise<SyncOutcome | "more"> {
  const { db } = deps;
  const at = now.getTime();
  const pending = and(eq(reservations.id, res.id), eq(reservations.status, res.status), eq(reservations.syncState, "pending"));
  const action = actionFor(res);

  if (action === "none") {
    // A cancelled booking the channel never got: nothing to send. (A refunded one keeps its failure reason.)
    const cancelled = res.status === "cancelled";
    await db.update(reservations)
      .set({ syncState: cancelled ? "not_required" : "synced", syncAttempts: 0, nextSyncAt: null, ...(cancelled ? { lastSyncError: null } : {}) })
      .where(pending);
    return cancelled ? "not_required" : "synced";
  }

  if (action === "push") {
    // Marked before the call: from now on the channel may hold it, whatever becomes of the answer.
    await db.update(reservations).set({ channelPushedAt: at }).where(and(eq(reservations.id, res.id), isNull(reservations.channelPushedAt)));
  }

  let r: PushResult | CancelResult;
  try {
    if (action === "cancel") r = await deps.channel.cancelReservation(res.code, res.smConfirmation!);
    else {
      const body = await toChannelReservation(db, res.id);
      r = action === "push" ? await deps.channel.pushReservation(body) : await deps.channel.modifyReservation(body, res.smConfirmation!);
    }
  } catch (e) {
    r = { ok: false, retryable: true, error: errorText(e) };
  }

  // Sync writes leave updatedAt alone: it is the optimistic lock of modifications and the lease of cancellations.
  // A success clears the channel error but keeps a modification-refund failure; a refunded booking keeps its reason.
  const keptError = res.status === "confirm_failed_refunded"
    ? sql`${reservations.lastSyncError}`
    : sql`case when ${reservations.lastSyncError} like ${`${MODIFY_REFUND_FAILED}%`} then ${reservations.lastSyncError} else null end`;
  if (r.ok) {
    const sm = "smConfirmation" in r ? r.smConfirmation : undefined;
    // The channel holds it under this smConfirmation from now on, whatever changed here meanwhile.
    if (sm && action === "push")
      await db.update(reservations).set({ smConfirmation: sm }).where(and(eq(reservations.id, res.id), isNull(reservations.smConfirmation)));
    if (sm && action === "modify") await db.update(reservations).set({ smConfirmation: sm }).where(eq(reservations.id, res.id));
    // Done only if what was sent is still the booking as it is: same status (a push of a cancelled booking is
    // followed by its cancel) and, for a live one, no modification since it was read.
    const sentIsCurrent = res.status === "confirmed" || action === "cancel";
    if (sentIsCurrent) {
      const done = await db.update(reservations)
        .set({ syncState: "synced", syncAttempts: 0, nextSyncAt: null, lastSyncError: keptError })
        .where(and(pending, eq(reservations.modCount, res.modCount))).returning({ id: reservations.id });
      if (done.length) return "synced";
    }
    // Something is still to send (the change or cancel made while this call ran, or the cancel after a re-push).
    await db.update(reservations).set({ syncAttempts: 0, nextSyncAt: at, lastSyncError: keptError })
      .where(and(eq(reservations.id, res.id), eq(reservations.syncState, "pending")));
    return "more";
  }

  const error = r.error ?? "CHANNEL_CALL_FAILED";
  const attempts = res.syncAttempts + 1;
  if (r.retryable) {
    await db.update(reservations)
      .set({ syncAttempts: attempts, nextSyncAt: at + retryDelayMs(attempts), lastSyncError: error })
      .where(pending);
    return "retry";
  }
  // Not retryable (our message or our credentials are wrong): stop until staff retry it (doc §5.1). The retry job
  // alerts them, at once and then daily.
  await db.update(reservations)
    .set({ syncState: "failed", syncAttempts: attempts, nextSyncAt: null, lastSyncError: error })
    .where(pending);
  return "failed";
}
