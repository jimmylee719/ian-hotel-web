import { and, eq, like } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { getDashboard } from "@/lib/admin/dashboard";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { notifications, reservations } from "@/lib/db/schema";
import { CHANNEL_RECONCILE_JOB, recordJob } from "@/lib/jobs/cron";
import { CHANNEL_LOOKUP_ERRORS_REF, CHANNEL_RECONCILE_BUDGET_MS, runChannelReconcile } from "@/lib/jobs/reconcile-channel";
import { bookingSetup, minutes, NOW, STAFF } from "@/tests/helpers/booking";

/** Taipei 04:00 on 2026-11-25. */
const RUN = new Date("2026-11-24T20:00:00Z");

/** A confirmed direct booking (pushed to the channel), checking in 2026-12-01. */
async function confirmed(over: Parameters<Awaited<ReturnType<typeof bookingSetup>>["book"]>[0] = {}) {
  const s = await bookingSetup();
  const code = await s.book(over);
  await handlePaymentNotice(s.deps, await s.notice(code), minutes(1));
  const res = await s.reservation(code);
  expect(res).toMatchObject({ status: "confirmed", syncState: "synced" });
  const set = (patch: Partial<typeof reservations.$inferInsert>) => s.db.update(reservations).set(patch).where(eq(reservations.id, res.id));
  return { ...s, code, id: res.id, sm: res.smConfirmation!, set };
}

test("a booking cancelled here but active on the channel is cancelled there, under the channel's smConfirmation", async () => {
  const { deps, channel, code, set, reservation } = await confirmed();
  // The local cancel never reached the channel (and gave up).
  await set({ status: "cancelled", syncState: "failed", lastSyncError: "CHANNEL_CANCEL_FAILED", smConfirmation: null });
  const cancel = vi.spyOn(channel, "cancelReservation");

  expect(await runChannelReconcile(deps, RUN)).toMatchObject({ checked: 1, cancelled: 1 });
  expect(cancel).toHaveBeenCalledWith(code, channel.records[0].smConfirmation);
  expect(channel.records).toMatchObject([{ code, state: "cancelled" }]);
  expect(await reservation(code)).toMatchObject({ status: "cancelled", syncState: "synced", lastSyncError: null });

  // Already cancelled there: nothing more to do.
  cancel.mockClear();
  expect(await runChannelReconcile(deps, RUN)).toMatchObject({ checked: 1, cancelled: 0 });
  expect(cancel).not.toHaveBeenCalled();
});

test("a smConfirmation mismatch is reported and shows on the dashboard as channel_mismatch", async () => {
  const { db, deps, propertyId, channel, code, id, sm, set } = await confirmed();
  await set({ smConfirmation: "SM-LOCAL-OTHER" });
  const r = await recordJob(db, CHANNEL_RECONCILE_JOB, RUN, () => runChannelReconcile(deps, RUN));
  expect(r).toMatchObject({ checked: 1, mismatches: [{ reservationId: id, code, propertyId, local: "SM-LOCAL-OTHER", channel: sm }] });
  expect(channel.records).toMatchObject([{ code, state: "active", smConfirmation: sm }]); // nothing changed there

  const { alerts } = await getDashboard(db, propertyId, RUN);
  expect(alerts.filter((a) => a.kind === "channel_mismatch")).toMatchObject([
    { reservationId: id, code, detail: expect.stringContaining(sm), since: RUN.getTime() },
  ]);
  expect((await getDashboard(db, "prop-other", RUN)).alerts.filter((a) => a.kind === "channel_mismatch")).toEqual([]);

  // Fixed by the next run: the alert goes away.
  await set({ smConfirmation: sm });
  const next = new Date(RUN.getTime() + 86_400_000);
  await recordJob(db, CHANNEL_RECONCILE_JOB, next, () => runChannelReconcile(deps, next));
  expect((await getDashboard(db, propertyId, next)).alerts.filter((a) => a.kind === "channel_mismatch")).toEqual([]);
});

test("a confirmed booking the channel does not hold is pushed again", async () => {
  const s = await bookingSetup();
  const code = await s.book();
  await handlePaymentNotice(s.deps, await s.notice(code), minutes(1));
  // A fresh channel that never got it (e.g. lost on their side).
  const { MockChannelManager } = await import("@/lib/channel/mock");
  const channel = new MockChannelManager();
  const deps = { ...s.deps, channel };
  expect(await runChannelReconcile(deps, RUN)).toMatchObject({ checked: 1, repushed: 1 });
  expect(channel.pushed.map((p) => p.code)).toEqual([code]);
  expect(await s.reservation(code)).toMatchObject({ status: "confirmed", syncState: "synced", smConfirmation: channel.records[0].smConfirmation });
});

test("lookup errors skip the booking and are counted", async () => {
  const { deps, channel, set } = await confirmed();
  await set({ status: "cancelled" });
  vi.spyOn(channel, "lookupReservation").mockResolvedValueOnce({ error: "DOWN", retryable: true });
  const cancel = vi.spyOn(channel, "cancelReservation");
  expect(await runChannelReconcile(deps, RUN)).toMatchObject({ checked: 1, lookupErrors: 1, cancelled: 0 });
  vi.spyOn(channel, "lookupReservation").mockRejectedValueOnce(new Error("socket"));
  expect(await runChannelReconcile(deps, RUN)).toMatchObject({ checked: 1, lookupErrors: 1 });
  expect(cancel).not.toHaveBeenCalled();
});

test("only direct bookings staying within the next 60 days and not owned by the sync job are looked up", async () => {
  const s = await confirmed();
  const lookup = vi.spyOn(s.channel, "lookupReservation");
  // Owned by the sync-retry job right now.
  await s.set({ syncState: "pending", nextSyncAt: NOW.getTime() });
  expect(await runChannelReconcile(s.deps, RUN)).toMatchObject({ checked: 0 });
  await s.set({ syncState: "synced", nextSyncAt: null });
  // Already checked out by then.
  expect(await runChannelReconcile(s.deps, new Date("2026-12-03T20:00:00Z"))).toMatchObject({ checked: 0 });
  // Checks in more than 60 days later (Taipei 2026-09-30 + 60 = 11-29 < 12-01).
  expect(await runChannelReconcile(s.deps, new Date("2026-09-29T20:00:00Z"))).toMatchObject({ checked: 0 });
  // Day 60 itself counts (Taipei 10-02 + 60 = 12-01).
  expect(await runChannelReconcile(s.deps, new Date("2026-10-01T20:00:00Z"))).toMatchObject({ checked: 1 });
  // A channel (OTA) booking is the channel's own.
  await s.set({ channel: "siteminder_ota" });
  expect(await runChannelReconcile(s.deps, RUN)).toMatchObject({ checked: 0 });
  // An unpaid booking was never pushed.
  await s.set({ channel: "direct", status: "pending_payment" });
  expect(await runChannelReconcile(s.deps, RUN)).toMatchObject({ checked: 0 });
  expect(lookup).toHaveBeenCalledTimes(1);
});

test("confirmed here, missing at the channel and the re-push fails: sync_failed (CHANNEL_MISSING) with staff told; a later run fixes it", async () => {
  const s = await bookingSetup();
  const code = await s.book();
  await handlePaymentNotice(s.deps, await s.notice(code), minutes(1));
  const { MockChannelManager } = await import("@/lib/channel/mock");
  const channel = new MockChannelManager(); // never got it
  const deps = { ...s.deps, channel };
  const push = vi.spyOn(channel, "pushReservation").mockResolvedValueOnce({ ok: false, retryable: true, error: "SM 503" });
  expect(await runChannelReconcile(deps, RUN)).toMatchObject({ checked: 1, repushed: 0, failed: 1 });
  const res = await s.reservation(code);
  expect(res).toMatchObject({ status: "confirmed", syncState: "failed", lastSyncError: "CHANNEL_MISSING: SM 503" });
  const told = () => s.db.select().from(notifications).where(and(eq(notifications.kind, "staff_sync_failed"), like(notifications.ref, "channel-missing:%")));
  expect(await told()).toMatchObject([{ reservationId: res.id, to: STAFF }]);
  expect((await getDashboard(s.db, s.propertyId, RUN)).alerts.filter((a) => a.kind === "sync_failed"))
    .toMatchObject([{ reservationId: res.id, detail: "CHANNEL_MISSING: SM 503" }]);

  // A push that throws is the same failure; the same day's alert is not sent twice.
  push.mockRejectedValueOnce(new Error("socket hang up"));
  expect(await runChannelReconcile(deps, RUN)).toMatchObject({ checked: 1, failed: 1 });
  expect(await s.reservation(code)).toMatchObject({ syncState: "failed", lastSyncError: "CHANNEL_MISSING: socket hang up" });
  expect(await told()).toHaveLength(1);

  // The next day's run checks it again (failed rows are included) and the push lands.
  const next = new Date(RUN.getTime() + 86_400_000);
  expect(await runChannelReconcile(deps, next)).toMatchObject({ checked: 1, repushed: 1 });
  expect(await s.reservation(code)).toMatchObject({ status: "confirmed", syncState: "synced", lastSyncError: null });
  expect((await getDashboard(s.db, s.propertyId, next)).alerts.filter((a) => a.kind === "sync_failed")).toEqual([]);
});

test("a run with lookup errors tells staff once a day and changes no row", async () => {
  const { db, deps, channel, id, reservation, code } = await confirmed();
  const lookup = vi.spyOn(channel, "lookupReservation").mockResolvedValue({ error: "DOWN", retryable: true });
  const before = await reservation(code);
  expect(await runChannelReconcile(deps, RUN)).toMatchObject({ checked: 1, lookupErrors: 1 });
  expect(await runChannelReconcile(deps, RUN)).toMatchObject({ lookupErrors: 1 });
  expect(await reservation(code)).toEqual(before);
  const told = () => db.select().from(notifications).where(like(notifications.ref, `${CHANNEL_LOOKUP_ERRORS_REF}%`));
  expect(await told()).toMatchObject([{ kind: "staff_sync_failed", reservationId: id, to: STAFF, ref: `${CHANNEL_LOOKUP_ERRORS_REF}2026-11-25` }]);
  await runChannelReconcile(deps, new Date(RUN.getTime() + 86_400_000));
  expect(await told()).toHaveLength(2);
  lookup.mockRestore();
  // A clean run tells no one.
  await runChannelReconcile(deps, new Date(RUN.getTime() + 2 * 86_400_000));
  expect(await told()).toHaveLength(2);
});

/** `n` confirmed direct bookings, pushed. */
async function manyConfirmed(n: number) {
  const s = await bookingSetup({ available: n + 1 });
  for (let i = 0; i < n; i++) {
    const code = await s.book({ idempotencyKey: `key-many-${String(i).padStart(4, "0")}` });
    await handlePaymentNotice(s.deps, await s.notice(code), minutes(1));
  }
  return s;
}

test("the run stops calling the channel after 5 consecutive errors, and records that it stopped early", async () => {
  const s = await manyConfirmed(7);
  const lookup = vi.spyOn(s.channel, "lookupReservation").mockResolvedValue({ error: "DOWN", retryable: true });
  const r = await recordJob(s.db, CHANNEL_RECONCILE_JOB, RUN, () => runChannelReconcile(s.deps, RUN));
  expect(r).toMatchObject({ checked: 5, lookupErrors: 5, stoppedEarly: "errors" });
  expect(lookup).toHaveBeenCalledTimes(5);
  lookup.mockReset();
  lookup.mockRejectedValueOnce(new Error("x")).mockResolvedValue({ found: false } as never);
  vi.spyOn(s.channel, "pushReservation");
  const again = await runChannelReconcile(s.deps, RUN);
  expect(again).toMatchObject({ checked: 7, lookupErrors: 1 });
  expect(again.stoppedEarly).toBeUndefined();
});

test("the run stops issuing channel calls once its wall-clock budget is spent", async () => {
  const s = await manyConfirmed(3);
  let t = 0;
  const real = s.channel.lookupReservation.bind(s.channel);
  vi.spyOn(s.channel, "lookupReservation").mockImplementation(async (code) => { t += 11 * 60_000; return real(code); });
  expect(CHANNEL_RECONCILE_BUDGET_MS).toBeLessThanOrEqual(20 * 60_000);
  expect(await runChannelReconcile(s.deps, RUN, { clock: () => t })).toMatchObject({ checked: 2, stoppedEarly: "deadline" });
});

test("a channel without lookup (SiteMinder) is not reconciled: nothing is looked up, pushed or cancelled", async () => {
  const s = await confirmed();
  const { MockChannelManager } = await import("@/lib/channel/mock");
  const inner = new MockChannelManager();
  const push = vi.spyOn(inner, "pushReservation");
  const channel = {
    timeoutMs: inner.timeoutMs,
    pushReservation: inner.pushReservation.bind(inner),
    modifyReservation: inner.modifyReservation.bind(inner),
    cancelReservation: inner.cancelReservation.bind(inner),
  };
  expect(await runChannelReconcile({ ...s.deps, channel }, RUN)).toEqual({
    checked: 0, repushed: 0, cancelled: 0, lookupErrors: 0, failed: 0, mismatches: [], unsupported: "NO_LOOKUP",
  });
  expect(push).not.toHaveBeenCalled();
});

test("a re-push or cancel waits while another call holds the property's channel lease", async () => {
  const s = await bookingSetup();
  const code = await s.book();
  await handlePaymentNotice(s.deps, await s.notice(code), minutes(1));
  const { MockChannelManager } = await import("@/lib/channel/mock");
  const { takePropertyLease } = await import("@/lib/booking/channel-sync");
  const channel = new MockChannelManager(); // never got it
  const push = vi.spyOn(channel, "pushReservation");
  await takePropertyLease(s.db, s.propertyId); // held now, by the real clock
  expect(await runChannelReconcile({ ...s.deps, channel }, RUN)).toMatchObject({ checked: 1, repushed: 0, deferred: 1 });
  expect(push).not.toHaveBeenCalled();
  expect(await s.reservation(code)).toMatchObject({ syncState: "synced" });
});
