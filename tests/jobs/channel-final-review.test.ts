import { and, eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import {
  channelCooldownMs, MIN_RETRY_AFTER_MS, nextRetryMs, syncWithChannel, takePropertyLease,
} from "@/lib/booking/channel-sync";
import { cancelReservation } from "@/lib/booking/manage";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { MockChannelManager } from "@/lib/channel/mock";
import type { CancelResult, ChannelReservation, PushResult } from "@/lib/channel/types";
import { channelLeases, notifications, reservations } from "@/lib/db/schema";
import { runChannelReconcile } from "@/lib/jobs/reconcile-channel";
import { runSyncRetry } from "@/lib/jobs/sync-retry";
import { buildScheduledDeps } from "@/lib/runtime/deps";
import { bookingSetup, minutes, NOW, STAFF } from "@/tests/helpers/booking";

const GUEST = "mei@example.com";
const DAY = 86_400_000;
const tick = () => new Promise((r) => setImmediate(r));

// ---- 1. The preview's per-request mock must not make staff alerts loop for ever ----

test("preview: a fresh lenient mock per request still takes the cancel, and nobody is alerted day after day", async () => {
  const s = await bookingSetup();
  const code = await s.book();
  await handlePaymentNotice(s.deps, await s.notice(code), minutes(1));
  expect(await s.reservation(code)).toMatchObject({ status: "confirmed", syncState: "synced" });

  // As on the preview: every request and cron run gets a new mock that remembers nothing.
  const preview = () => buildScheduledDeps({
    ENVIRONMENT: "preview", PAYMENT_MODE: "mock", CHANNEL_MODE: "mock", MOCK_PAYMENT_SECRET: "x", BASE_URL: "https://preview.test",
  }, s.db).channel;
  expect(preview()).toMatchObject({ quiet: true });
  expect(await cancelReservation({ ...s.deps, channel: preview() }, code, GUEST, minutes(2))).toMatchObject({ ok: true });
  expect(await s.reservation(code)).toMatchObject({ status: "cancelled", syncState: "synced" });

  // Even a row left failed (as preview rows from before this fix are) is never alerted there.
  const { id } = await s.reservation(code);
  await s.db.update(reservations).set({ syncState: "failed", lastSyncError: "UNKNOWN_RESERVATION" }).where(eq(reservations.id, id));
  s.email.sent.length = 0;
  for (let d = 1; d <= 3; d++)
    expect(await runSyncRetry({ ...s.deps, channel: preview() }, new Date(NOW.getTime() + d * DAY))).toEqual({ attempted: 0 });
  expect(s.email.sent.filter((e) => e.to === STAFF)).toEqual([]);
});

test("local dev and tests keep the strict mock: a modify or cancel of an unknown code is refused", async () => {
  const s = await bookingSetup();
  const local = buildScheduledDeps({ ENVIRONMENT: "local", PAYMENT_MODE: "mock", CHANNEL_MODE: "mock" }, s.db).channel;
  expect(local.quiet).toBeFalsy();
  const r = { code: "NK-ZZ0001" } as ChannelReservation;
  expect(await local.cancelReservation(r, "SM-1")).toMatchObject({ ok: false, retryable: false, error: "UNKNOWN_RESERVATION" });
  const lenient = new MockChannelManager({ lenient: true });
  expect(await lenient.modifyReservation(r, "SM-1")).toEqual({ ok: true, smConfirmation: "SM-1" });
  expect(await lenient.cancelReservation(r, "SM-1")).toEqual({ ok: true, retryable: false });
  expect(lenient.records).toEqual([{ code: "NK-ZZ0001", smConfirmation: "SM-1", state: "cancelled" }]);
});

test("a stay that has ended is neither retried nor alerted about", async () => {
  const s = await bookingSetup({ channel: new MockChannelManager({ failNext: 100, retryable: true }) });
  const code = await s.book(); // 2026-12-01 → 12-03
  await handlePaymentNotice(s.deps, await s.notice(code), minutes(0));
  const { id } = await s.reservation(code);
  await s.db.update(reservations).set({ syncAttempts: 5, nextSyncAt: null }).where(eq(reservations.id, id));
  const push = vi.spyOn(s.channel, "pushReservation");

  // Check-out day itself (Taipei 12-03) still counts.
  const checkOutDay = new Date("2026-12-03T02:00:00Z");
  expect(await runSyncRetry(s.deps, checkOutDay)).toEqual({ attempted: 1, alerted: [code] });
  const after = new Date("2026-12-04T02:00:00Z");
  push.mockClear();
  expect(await runSyncRetry(s.deps, after)).toEqual({ attempted: 0 });
  expect(push).not.toHaveBeenCalled();
  await s.db.update(reservations).set({ syncState: "failed" }).where(eq(reservations.id, id));
  expect(await runSyncRetry(s.deps, new Date("2026-12-05T02:00:00Z"))).toEqual({ attempted: 0 });
  const alerts = await s.db.select().from(notifications)
    .where(and(eq(notifications.reservationId, id), eq(notifications.kind, "staff_sync_failed")));
  expect(alerts).toHaveLength(1);
});

// ---- 2. Property cooldown on 429 / Retry-After ----

test("Retry-After is floored at 60 s and capped at 1 h; a 429 without one waits 60 s; other failures set no cooldown", () => {
  expect(channelCooldownMs({ detail: { retryAfterMs: 5_000 } })).toBe(MIN_RETRY_AFTER_MS);
  expect(channelCooldownMs({ detail: { retryAfterMs: 120_000 } })).toBe(120_000);
  expect(channelCooldownMs({ detail: { retryAfterMs: 5 * 3600_000 } })).toBe(3600_000);
  expect(channelCooldownMs({ detail: { httpStatus: 429 } })).toBe(MIN_RETRY_AFTER_MS);
  expect(channelCooldownMs({ detail: { httpStatus: 503 } })).toBeUndefined();
  expect(nextRetryMs({ detail: { retryAfterMs: 1_000 } }, 1)).toBe(MIN_RETRY_AFTER_MS);
});

test("a 429 cools the whole property down: the same run and later kicks send nothing until it has passed", async () => {
  let t = 1_000_000;
  const clock = () => t;
  const s = await bookingSetup({ available: 5 });
  const deps = { ...s.deps, clock };
  const push = vi.spyOn(s.channel, "pushReservation").mockResolvedValueOnce({
    ok: false, retryable: true, error: "SITEMINDER_HTTP_429", detail: { kind: "http", httpStatus: 429, retryAfterMs: 5_000 },
  });
  const a = await s.book({ idempotencyKey: "key-aaaa-000001" });
  await handlePaymentNotice(deps, await s.notice(a), minutes(1));
  expect(await s.reservation(a)).toMatchObject({ syncState: "pending", nextSyncAt: minutes(1).getTime() + MIN_RETRY_AFTER_MS });
  const [lease] = await s.db.select().from(channelLeases);
  expect(lease.cooldownUntil).toBe(t + MIN_RETRY_AFTER_MS); // released (until 0), cooldown kept

  // Another booking paid 30 s later: confirmed, but its push waits for the cooldown.
  t += 30_000;
  const b = await s.book({ idempotencyKey: "key-bbbb-000002" });
  await handlePaymentNotice(deps, await s.notice(b), minutes(1));
  expect(push).toHaveBeenCalledTimes(1);
  expect(await s.reservation(b)).toMatchObject({ status: "confirmed", syncState: "pending", syncAttempts: 0 });
  expect(await runSyncRetry(deps, minutes(5), { clock })).toEqual({ attempted: 0 });
  expect(await takePropertyLease(s.db, s.propertyId, clock)).toBeNull();

  t += 31_000; // past the cooldown
  expect(await runSyncRetry(deps, minutes(5), { clock })).toEqual({ attempted: 2 });
  expect(await s.reservation(a)).toMatchObject({ syncState: "synced" });
  expect(await s.reservation(b)).toMatchObject({ syncState: "synced" });
});

// ---- 3. SITEMINDER-OPEN-Q1 placeholder (client tests: tests/channel/siteminder-client.test.ts) ----

test("a modify answered with SiteMinder's real id replaces the placeholder we held", async () => {
  const s = await bookingSetup();
  const code = await s.book();
  await handlePaymentNotice(s.deps, await s.notice(code), minutes(1));
  const { id } = await s.reservation(code);
  const placeholder = code.replace(/[^A-Za-z0-9]/g, "");
  await s.db.update(reservations).set({ smConfirmation: placeholder, syncState: "pending", nextSyncAt: null }).where(eq(reservations.id, id));
  vi.spyOn(s.channel, "modifyReservation").mockResolvedValueOnce({ ok: true, smConfirmation: "SM-REAL-7" });
  expect(await syncWithChannel(s.deps, id, minutes(2))).toBe("synced");
  expect(await s.reservation(code)).toMatchObject({ smConfirmation: "SM-REAL-7", syncState: "synced" });
});

// ---- 4, 5. channelPushedAt means "may be at the channel" ----

test("a push that failed on our own config is not a push: a later cancel sends nothing", async () => {
  const s = await bookingSetup();
  vi.spyOn(s.channel, "pushReservation").mockResolvedValueOnce({
    ok: false, retryable: true, error: "SITEMINDER_HOTEL_CODE_NOT_SET", detail: { kind: "config" },
  });
  const code = await s.book();
  await handlePaymentNotice(s.deps, await s.notice(code), minutes(1));
  expect(await s.reservation(code)).toMatchObject({ syncState: "pending", channelPushedAt: null, syncAttempts: 1 });
  const push = vi.spyOn(s.channel, "pushReservation");
  const cancel = vi.spyOn(s.channel, "cancelReservation");
  push.mockClear();
  await cancelReservation(s.deps, code, GUEST, minutes(2));
  expect(push).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  expect(await s.reservation(code)).toMatchObject({ status: "cancelled", syncState: "not_required" });
});

test("a cancel during a first push that is then refused outright: never pushed, so no Commit then Cancel", async () => {
  let answer!: (r: PushResult) => void;
  class Slow extends MockChannelManager {
    override pushReservation(): Promise<PushResult> {
      return new Promise((resolve) => { answer = resolve; });
    }
    override cancelReservation(r: ChannelReservation, sm: string): Promise<CancelResult> {
      return super.cancelReservation(r, sm);
    }
  }
  const channel = new Slow();
  const s = await bookingSetup({ channel });
  const code = await s.book();
  const paying = handlePaymentNotice(s.deps, await s.notice(code), minutes(1));
  while (!answer) await tick();
  expect((await s.reservation(code)).channelPushedAt).toBe(minutes(1).getTime());
  expect(await cancelReservation(s.deps, code, GUEST, minutes(2))).toMatchObject({ ok: true }); // the property is busy
  answer({ ok: false, retryable: false, error: "SITEMINDER_ERROR type=10", detail: { kind: "ota", type: 10 } });
  await paying;
  expect(await s.reservation(code)).toMatchObject({ status: "cancelled", syncState: "pending", channelPushedAt: null });

  const push = vi.spyOn(channel, "pushReservation");
  const cancel = vi.spyOn(channel, "cancelReservation");
  expect(await runSyncRetry(s.deps, minutes(3))).toEqual({ attempted: 1 });
  expect(push).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  expect(await s.reservation(code)).toMatchObject({ syncState: "not_required" });
});

// ---- 6. Reconcile stamps channelSyncedAt from the real clock ----

test("a reconcile re-push stamps channelSyncedAt from the clock, not the run's scheduled time", async () => {
  const s = await bookingSetup();
  const code = await s.book();
  await handlePaymentNotice(s.deps, await s.notice(code), minutes(1));
  const channel = new MockChannelManager(); // never got it
  const RUN = new Date("2026-11-24T20:00:00Z");
  expect(await runChannelReconcile({ ...s.deps, channel, clock: () => 42_000 }, RUN)).toMatchObject({ repushed: 1 });
  expect((await s.reservation(code)).channelSyncedAt).toBe(42_000);
});
