import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
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

/** The shortest wait a Retry-After (or a 429 without one) imposes: the channel asked us to slow down. */
export const MIN_RETRY_AFTER_MS = 60_000;

/**
 * How long the channel asked the whole property to wait, or undefined: its Retry-After (between MIN_RETRY_AFTER_MS
 * and MAX_RETRY_MS), or MIN_RETRY_AFTER_MS for an HTTP 429 without one.
 */
export function channelCooldownMs(r: { detail?: { retryAfterMs?: number; httpStatus?: number } }): number | undefined {
  const ra = r.detail?.retryAfterMs;
  if (ra !== undefined && Number.isFinite(ra) && ra >= 0) return Math.min(Math.max(ra, MIN_RETRY_AFTER_MS), MAX_RETRY_MS);
  return r.detail?.httpStatus === 429 ? MIN_RETRY_AFTER_MS : undefined;
}

/** The wait before the next attempt after a retryable failure: the channel's cooldown when it asked for one, else the backoff. */
export function nextRetryMs(r: { detail?: { retryAfterMs?: number; httpStatus?: number } }, attempts: number): number {
  return channelCooldownMs(r) ?? retryDelayMs(attempts);
}

/** The statuses whose channel copy the sync keeps: live bookings, cancelled ones, and (legacy) refunded ones. */
export const CHANNEL_SYNC_STATUSES = ["confirmed", "cancelled", "confirm_failed_refunded"] as const;

/** lastSyncError prefix of a modification refund that did not go through; a later channel success keeps it. */
export const MODIFY_REFUND_FAILED = "MODIFY_REFUND_FAILED";

/** The real clock (epoch ms). Leases always use it, never a job's business `now` (a scheduled time, fixed for a whole run). */
export type Clock = () => number;

/**
 * Take `propertyId`'s channel lease until clock() + SYNC_LEASE_MS, unless another holder's lease is still running,
 * or the property is cooling down (the channel asked us to wait: setPropertyCooldown), by the same real clock.
 */
export async function takePropertyLease(db: Db, propertyId: string, clock: Clock = Date.now): Promise<string | null> {
  const holder = crypto.randomUUID();
  const t = clock();
  const until = t + SYNC_LEASE_MS;
  const rows = await db.insert(channelLeases).values({ propertyId, holder, until })
    .onConflictDoUpdate({
      target: channelLeases.propertyId, set: { holder, until },
      setWhere: and(lte(channelLeases.until, t), or(isNull(channelLeases.cooldownUntil), lte(channelLeases.cooldownUntil, t))),
    })
    .returning({ holder: channelLeases.holder });
  return rows[0]?.holder === holder ? holder : null;
}

/** No call starts for the property before clock() + ms (a later cooldown already set is kept). */
export async function setPropertyCooldown(db: Db, propertyId: string, ms: number, clock: Clock = Date.now): Promise<void> {
  const until = clock() + ms;
  await db.update(channelLeases)
    .set({ cooldownUntil: sql`max(coalesce(${channelLeases.cooldownUntil}, 0), ${until})` })
    .where(eq(channelLeases.propertyId, propertyId));
}

/**
 * Extend a lease this worker still holds and that has not lapsed by the real clock; false otherwise (it may already
 * be someone else's, so no further call may be made under it).
 */
export async function renewPropertyLease(db: Db, propertyId: string, holder: string, clock: Clock = Date.now): Promise<boolean> {
  const t = clock();
  const rows = await db.update(channelLeases).set({ until: t + SYNC_LEASE_MS })
    .where(and(eq(channelLeases.propertyId, propertyId), eq(channelLeases.holder, holder), gt(channelLeases.until, t)))
    .returning({ h: channelLeases.holder });
  return rows.length === 1;
}

/** Give the lease back, if this worker still holds it. The row stays (until = 0), keeping any cooldown. */
export async function releasePropertyLease(db: Db, propertyId: string, holder: string): Promise<void> {
  await db.update(channelLeases).set({ until: 0 }).where(and(eq(channelLeases.propertyId, propertyId), eq(channelLeases.holder, holder)));
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
  const clock = deps.clock ?? Date.now;
  const holder = await takePropertyLease(db, first.propertyId, clock);
  if (!holder) return "busy";
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (step > 0 && !await renewPropertyLease(db, first.propertyId, holder, clock)) return "busy";
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
  // Cancelled (or refunded): cancel what the channel holds; without its smConfirmation, a push that may have landed
  // is sent again first (isResend); a booking never pushed needs nothing.
  if (res.smConfirmation) return "cancel";
  return mayBeAtChannel(res) ? "push" : "none";
}

// ---- SITEMINDER-OPEN-Q1 decisions (what re-sending a UniqueID means), in one place ----

/** SITEMINDER-OPEN-Q1: the channel may hold this booking although we have no smConfirmation (a push answer was lost). */
const mayBeAtChannel = (res: Reservation) => res.channelPushedAt != null;

/** SITEMINDER-OPEN-Q1: this push re-sends a UniqueID already sent once (recovery by resend: there is no lookup). */
const isResend = (res: Reservation, action: Action) => action === "push" && mayBeAtChannel(res);

/**
 * SITEMINDER-OPEN-Q1: after a successful resend, is the live booking current at the channel? Assumed not: the
 * channel may have kept the first version and ignored this one, so a modify carrying the current stay follows.
 */
const resendLeavesStayCurrent = false;

// ---- end of SITEMINDER-OPEN-Q1 decisions (also RESEND_ALREADY_HELD / resendAnswer below) ----

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One channel call for `res` (read under the lease) and its result written back. "more" = another call follows now. */
async function syncStep(deps: Deps, res: Reservation, now: Date): Promise<SyncOutcome | "more"> {
  const { db } = deps;
  const at = now.getTime();
  const clock = deps.clock ?? Date.now;
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

  // A push of a booking already pushed once (its answer lost, or before a cancel) is a resend of the same UniqueID.
  const resend = isResend(res, action);
  if (action === "push" && !resend) {
    // Marked before the call: from now on the channel may hold it, whatever becomes of the answer.
    await db.update(reservations).set({ channelPushedAt: at }).where(and(eq(reservations.id, res.id), isNull(reservations.channelPushedAt)));
  }

  let r: PushResult | CancelResult;
  try {
    const body = await toChannelReservation(db, res.id);
    if (action === "cancel") r = await deps.channel.cancelReservation(body, res.smConfirmation!);
    else r = action === "push" ? await deps.channel.pushReservation(body) : await deps.channel.modifyReservation(body, res.smConfirmation!);
  } catch (e) {
    r = { ok: false, retryable: true, error: errorText(e) };
  }
  if (resend) r = resendAnswer(r as PushResult);

  // Sync writes leave updatedAt alone: it is the optimistic lock of modifications and the lease of cancellations.
  // A success clears the channel error but keeps a modification-refund failure; a refunded booking keeps its reason.
  const keptError = res.status === "confirm_failed_refunded"
    ? sql`${reservations.lastSyncError}`
    : sql`case when ${reservations.lastSyncError} like ${`${MODIFY_REFUND_FAILED}%`} then ${reservations.lastSyncError} else null end`;
  if (r.ok) {
    const sm = "smConfirmation" in r ? r.smConfirmation : undefined;
    // When the channel acknowledged this booking's rooms (the real time the call returned, not this step's start):
    // ARI generated before then (minus a margin) does not count them yet, so lib/db/ari-sync.ts keeps them out of
    // SiteMinder's BookingLimit.
    if (action === "push" || action === "modify")
      await db.update(reservations).set({ channelSyncedAt: clock() }).where(eq(reservations.id, res.id));
    // The channel holds it under this smConfirmation from now on, whatever changed here meanwhile.
    if (sm && action === "push")
      await db.update(reservations).set({ smConfirmation: sm }).where(and(eq(reservations.id, res.id), isNull(reservations.smConfirmation)));
    if (sm && action === "modify") await db.update(reservations).set({ smConfirmation: sm }).where(eq(reservations.id, res.id));
    // Done only if what was sent is still the booking as it is: same status (a push of a cancelled booking is
    // followed by its cancel) and, for a live one, no modification since it was read.
    // A resend proves only that the channel holds the code, not which version (resendLeavesStayCurrent).
    const sentIsCurrent = (res.status === "confirmed" && (!resend || resendLeavesStayCurrent)) || action === "cancel";
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
  // A first push that certainly did not reach the channel is not a push: a refusal is atomic (nothing was taken,
  // doc §3.1), and a failure of our own config (hotel code unset or ambiguous) never sent anything. channelPushedAt
  // is a fact about the channel, so it is cleared whatever happened to the booking meanwhile (e.g. a cancel), but
  // only if this step set it.
  if (action === "push" && !resend && (!r.retryable || r.detail?.kind === "config"))
    await db.update(reservations).set({ channelPushedAt: null })
      .where(and(eq(reservations.id, res.id), eq(reservations.channelPushedAt, at)));
  if (r.retryable) {
    // The channel asked the whole hotel to wait (429 / Retry-After): no call starts for it before then.
    const cooldown = channelCooldownMs(r);
    if (cooldown !== undefined) await setPropertyCooldown(db, res.propertyId, cooldown, clock);
    await db.update(reservations)
      .set({ syncAttempts: attempts, nextSyncAt: at + nextRetryMs(r, attempts), lastSyncError: error, lastSyncAt: at })
      .where(pending);
    return "retry";
  }
  // Not retryable (our message or our credentials are wrong): stop until staff retry it (doc §5.1). The retry job
  // alerts them, at once and then daily.
  await db.update(reservations)
    .set({ syncState: "failed", syncAttempts: attempts, nextSyncAt: null, lastSyncError: error, lastSyncAt: at })
    .where(pending);
  return "failed";
}

/**
 * SITEMINDER-OPEN-Q1: the channel answers that would mean "this UniqueID is already held" when a push is resent.
 * The docs say only that a UniqueID sent again is ignored ([REQ][RES]); [HTTP] reads 409 as a duplicate. When
 * SiteMinder answers Q1, put its HTTP status or OTA Error Code here (matched on the adapter's structured detail).
 */
export const RESEND_ALREADY_HELD: { readonly httpStatuses: readonly number[]; readonly otaCodes: readonly number[] } = {
  httpStatuses: [409],
  otaCodes: [],
};

/**
 * SITEMINDER-OPEN-Q1, in one place: what the channel's answer to a resent push (the same UniqueID again) means.
 * Assumed now: a success carries the smConfirmation of the reservation the channel already holds (possibly an older
 * version: the caller follows a live booking with a modify), and any error is taken as it comes, except an
 * "already held" answer (RESEND_ALREADY_HELD, read from the adapter's structured `detail`, never from the error
 * text): it carries no smConfirmation, so it becomes the refusal below (staff then check SiteMinder by hand).
 */
export function resendAnswer(r: PushResult): PushResult {
  if (r.ok) return r;
  const d = r.detail;
  const held = d !== undefined && (
    (d.httpStatus !== undefined && RESEND_ALREADY_HELD.httpStatuses.includes(d.httpStatus))
    || (d.kind === "ota" && d.code !== undefined && RESEND_ALREADY_HELD.otaCodes.includes(d.code)));
  if (held) return { ...r, retryable: false, error: `RESEND_ALREADY_HELD_NO_CONFIRMATION: ${r.error}` };
  return r;
}
