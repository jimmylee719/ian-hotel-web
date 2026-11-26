import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { MockChannelManager } from "@/lib/channel/mock";
import { jobRuns, notifications, opsAlerts, rateLimits, reservations } from "@/lib/db/schema";
import { runExpireHolds } from "@/lib/jobs/expire-holds";
import { pruneRateLimits } from "@/lib/jobs/rate-limits";
import { buildScheduledDeps } from "@/lib/runtime/deps";
import { runCron } from "@/lib/jobs/cron";
import { runScheduled } from "@/lib/jobs/scheduled";
import { bookingSetup, NOW, STAFF } from "@/tests/helpers/booking";

vi.mock("@/lib/jobs/expire-holds", async (orig) => {
  const m = await orig<typeof import("@/lib/jobs/expire-holds")>();
  return { ...m, runExpireHolds: vi.fn(m.runExpireHolds) };
});

// Taipei 2026-11-28 10:00, so check-in 2026-12-01 is exactly 3 days away.
const RUN = new Date("2026-11-28T02:00:00Z");

/** A: unpaid, hold lapsed. B: paid and confirmed, channel push failed once (due for retry). C: confirmed, checks in 12-01. */
async function scenario() {
  const s = await bookingSetup({ channel: new MockChannelManager({ failNext: 1, retryable: true }) });
  await s.book({ idempotencyKey: "key-aaaa-000001" });
  const b = await s.book({ idempotencyKey: "key-bbbb-000002", checkIn: "2026-12-02", checkOut: "2026-12-04" });
  await handlePaymentNotice(s.deps, await s.notice(b, { amount: 4000 }), NOW);
  const c = await s.book({ idempotencyKey: "key-cccc-000003" });
  await handlePaymentNotice(s.deps, await s.notice(c), NOW);
  expect(await s.reservation(b)).toMatchObject({ status: "confirmed", syncState: "pending" });
  expect((await s.reservation(c)).status).toBe("confirmed");
  s.email.sent.length = 0;
  return { ...s, b, c };
}

test("runScheduled expires the hold, retries the sync and sends the pre-arrival email; a second run does nothing", async () => {
  const { deps, email, reservation, b, c } = await scenario();
  expect(await runScheduled(deps, RUN)).toEqual({ expired: 1, attempted: 1, preArrival: 1 });
  expect(await reservation(b)).toMatchObject({ status: "confirmed", syncState: "synced" });
  expect(email.sent.filter((e) => e.to === "mei@example.com" && e.subject.includes((c as string)))).toHaveLength(1);

  email.sent.length = 0;
  expect(await runScheduled(deps, RUN)).toEqual({ expired: 0, attempted: 0, preArrival: 0 });
  expect(await runScheduled(deps, new Date(RUN.getTime() + 5 * 60_000))).toEqual({ expired: 0, attempted: 0, preArrival: 0 });
  expect(email.sent).toHaveLength(0);
});

test("one job throwing does not stop the other two", async () => {
  const { deps } = await scenario();
  vi.mocked(runExpireHolds).mockRejectedValueOnce(new Error("boom"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await runScheduled(deps, RUN)).toEqual({ expired: 0, attempted: 1, preArrival: 1 });
  expect(error).toHaveBeenCalledWith(expect.stringContaining("expire"), expect.any(Error));
  error.mockRestore();
});

test("pruneRateLimits deletes counters older than a day and keeps the rest", async () => {
  const { db } = await bookingSetup();
  const day = 24 * 3600_000;
  await db.insert(rateLimits).values([
    { key: "create:old", windowStart: RUN.getTime() - day - 60_000, count: 3 },
    { key: "create:edge", windowStart: RUN.getTime() - day, count: 1 },
    { key: "create:new", windowStart: RUN.getTime() - 60_000, count: 2 },
  ]);
  expect(await pruneRateLimits(db, RUN)).toEqual({ pruned: 1 });
  expect((await db.select().from(rateLimits)).map((r) => r.key).sort()).toEqual(["create:edge", "create:new"]);
  expect(await pruneRateLimits(db, RUN)).toEqual({ pruned: 0 });
});

test("the staff address is untouched by pre-arrival", async () => {
  const { deps, db } = await scenario();
  await runScheduled(deps, RUN);
  const rows = await db.select().from(notifications).where(eq(notifications.kind, "pre_arrival"));
  expect(rows.map((r) => r.to)).toEqual(["mei@example.com"]);
  expect(rows[0].to).not.toBe(STAFF);
});

test("the cron with no channel configured still expires holds and sends pre-arrival, and skips the sync", async () => {
  const { db, reservation, b } = await scenario();
  const sched = buildScheduledDeps({ PAYMENT_MODE: "mock", ENVIRONMENT: "local" }, db);
  expect(sched.syncSkipReason).toBe("CHANNEL_MODE_NOT_SET");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await runScheduled(sched, RUN, { skipSyncReason: sched.syncSkipReason })).toEqual({ expired: 1, attempted: 0, preArrival: 1 });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("CHANNEL_MODE_NOT_SET"));
  expect(await reservation(b)).toMatchObject({ status: "confirmed", syncState: "pending" });
  warn.mockRestore();
});

test("runCron survives a channel builder that throws: expiry and pre-arrival still run, sync is skipped", async () => {
  const { db, reservation, b } = await scenario();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await runCron({ PAYMENT_MODE: "mock", CHANNEL_MODE: "bogus", ENVIRONMENT: "local" } as never, RUN, db);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("expired=1 attempted=0 preArrival=1"));
  expect(await reservation(b)).toMatchObject({ status: "confirmed", syncState: "pending" });
  expect(error).toHaveBeenCalled();
  log.mockRestore(); warn.mockRestore(); error.mockRestore();
});

test("in production without BASE_URL the cron still expires holds but sends no email (no localhost links)", async () => {
  const { db, email, reservation, b } = await scenario();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await runCron({ ENVIRONMENT: "production", PAYMENT_MODE: "sinopac", CHANNEL_MODE: "siteminder" } as never, RUN, db);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("expired=1 attempted=0 preArrival=0"));
  expect(error).toHaveBeenCalledWith(expect.stringContaining("BASE_URL_NOT_SET"));
  expect(email.sent).toHaveLength(0);
  expect(await db.select().from(notifications).where(eq(notifications.kind, "pre_arrival"))).toHaveLength(0);
  expect(await reservation(b)).toMatchObject({ status: "confirmed", syncState: "pending" });
  log.mockRestore(); warn.mockRestore(); error.mockRestore();
});

test("a cron run that alerts staff about bookings not on the channel also alerts ops (at most hourly)", async () => {
  const s = await bookingSetup();
  const code = await s.book();
  await handlePaymentNotice(s.deps, await s.notice(code), NOW);
  const { id } = await s.reservation(code);
  // The hand-off stopped on an error that is not retried (e.g. SiteMinder refused our credentials).
  await s.db.update(reservations).set({ syncState: "failed", lastSyncError: "AUTH" }).where(eq(reservations.id, id));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const env = { ENVIRONMENT: "local", PAYMENT_MODE: "mock", CHANNEL_MODE: "mock", STAFF_EMAILS: STAFF, OPS_EMAILS: "ops@nk.test" } as never;
  await runCron(env, RUN, s.db);
  const staffRows = await s.db.select().from(notifications).where(eq(notifications.kind, "staff_sync_failed"));
  expect(staffRows).toMatchObject([{ reservationId: id, to: STAFF, ref: "channel-unsynced:2026-11-28" }]);
  expect(await s.db.select().from(opsAlerts)).toMatchObject([{ key: "channel_sync_failed", status: "sent" }]);
  const [run] = await s.db.select().from(jobRuns);
  expect(run.result).toMatchObject({ unsynced: [code] });
  // The same day: staff were told already, ops are not alerted again.
  await runCron(env, new Date(RUN.getTime() + 5 * 60_000), s.db);
  expect(await s.db.select().from(opsAlerts)).toHaveLength(1);
  log.mockRestore();
});
