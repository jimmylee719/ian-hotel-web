import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { getDashboard } from "@/lib/admin/dashboard";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { reservations } from "@/lib/db/schema";
import { CHANNEL_RECONCILE_JOB, recordJob } from "@/lib/jobs/cron";
import { runChannelReconcile } from "@/lib/jobs/reconcile-channel";
import { bookingSetup, minutes, NOW } from "@/tests/helpers/booking";

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
