import { and, eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import type { StaffContext } from "@/lib/admin/auth";
import { applyModification, previewModification } from "@/lib/admin/modify";
import { retryChannelSync, unsyncedWithChannel } from "@/lib/admin/channel-sync";
import { getDashboard } from "@/lib/admin/dashboard";
import {
  CHANNEL_ALERT_AFTER, releasePropertyLease, renewPropertyLease, resendAnswer, retryDelayMs, SYNC_LEASE_MS, syncWithChannel,
  takePropertyLease,
} from "@/lib/booking/channel-sync";
import { cancelReservation } from "@/lib/booking/manage";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { MockChannelManager } from "@/lib/channel/mock";
import { CHANNEL_MAX_TIMEOUT_MS, type CancelResult, type ChannelReservation, type PushResult } from "@/lib/channel/types";
import { notifications, payments, reservations, staff } from "@/lib/db/schema";
import { runSyncRetry, SYNC_RUN_BUDGET_MS } from "@/lib/jobs/sync-retry";
import { bookingSetup, minutes, PAY_NOW, STAFF } from "@/tests/helpers/booking";

const GUEST = "mei@example.com";
const tick = () => new Promise((r) => setImmediate(r));

/** A channel whose pushes wait until the test lets them answer; it counts how many calls are in flight at once. */
class GatedChannel extends MockChannelManager {
  gates: ((r?: PushResult) => void)[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private async gated<T>(run: () => Promise<T>): Promise<T> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const override = await new Promise<PushResult | undefined>((resolve) => this.gates.push(resolve));
    try {
      return override ? (override as T) : await run();
    } finally {
      this.inFlight--;
    }
  }
  override pushReservation(r: ChannelReservation) {
    return this.gated(() => super.pushReservation(r));
  }
  override cancelReservation(r: ChannelReservation, sm: string): Promise<CancelResult> {
    return this.gated(() => super.cancelReservation(r, sm));
  }
  /** Let the oldest waiting call answer (as the mock would, or with `r`). */
  async open(r?: PushResult) {
    while (this.gates.length === 0) await tick();
    this.gates.shift()!(r);
  }
}

const staffSyncAlerts = (db: Awaited<ReturnType<typeof bookingSetup>>["db"], reservationId: string) =>
  db.select().from(notifications).where(and(eq(notifications.reservationId, reservationId), eq(notifications.kind, "staff_sync_failed")));

test("a paid booking is confirmed at once, emails go out, and a failed hand-off neither refunds nor un-confirms it", async () => {
  const { db, deps, gateway, email, book, reservation, notice } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 1, retryable: true }),
  });
  const refund = vi.spyOn(gateway, "refund");
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(2));

  const res = await reservation(code);
  expect(res).toMatchObject({
    status: "confirmed", syncState: "pending", smConfirmation: null, syncAttempts: 1, lastSyncError: "MOCK_FAILURE",
    nextSyncAt: minutes(2).getTime() + retryDelayMs(1),
  });
  expect(email.sent.map((e) => e.to).sort()).toEqual([GUEST, STAFF]); // booking_confirmed + staff_new_booking
  expect(refund).not.toHaveBeenCalled();
  expect(await db.select().from(payments).where(eq(payments.kind, "refund"))).toEqual([]);
});

test("a non-retryable hand-off error keeps the booking confirmed, stops retrying and is never refunded", async () => {
  const { deps, gateway, channel, book, reservation, notice } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 1, retryable: false }),
  });
  const refund = vi.spyOn(gateway, "refund");
  const push = vi.spyOn(channel, "pushReservation");
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(2));
  expect(await reservation(code)).toMatchObject({ status: "confirmed", syncState: "failed", nextSyncAt: null, lastSyncError: "MOCK_FAILURE" });

  await runSyncRetry(deps, minutes(60));
  expect(push).toHaveBeenCalledTimes(1);
  expect(refund).not.toHaveBeenCalled();
});

test("the retry job backs off 5, 10, 20, 40 minutes, then hourly, and never gives up", async () => {
  expect([1, 2, 3, 4, 5, 6, 20].map((n) => retryDelayMs(n) / 60_000)).toEqual([5, 10, 20, 40, 60, 60, 60]);

  const { deps, channel, book, reservation, notice } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 12, retryable: true }),
  });
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(0));
  let at = minutes(0).getTime();
  for (let attempt = 1; attempt <= 12; attempt++) {
    const res = await reservation(code);
    expect(res).toMatchObject({ status: "confirmed", syncState: "pending", syncAttempts: attempt });
    expect(res.nextSyncAt).toBe(at + retryDelayMs(attempt));
    // Not before it is due.
    expect((await runSyncRetry(deps, new Date(res.nextSyncAt! - 1))).attempted).toBe(0);
    at = res.nextSyncAt!;
    expect((await runSyncRetry(deps, new Date(at))).attempted).toBe(1);
  }
  const res = await reservation(code);
  expect(res).toMatchObject({ status: "confirmed", syncState: "synced", syncAttempts: 0, lastSyncError: null });
  expect(res.smConfirmation).toBe(channel.records[0].smConfirmation);
});

test("staff are alerted after 3 failures in a row, once that day, then again each day it stays unsynced", async () => {
  const { db, deps, book, reservation, notice } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 100, retryable: true }),
  });
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(0));
  const { id } = await reservation(code);

  expect(await runSyncRetry(deps, minutes(5))).toEqual({ attempted: 1 }); // 2nd failure: no alert yet
  expect(await staffSyncAlerts(db, id)).toHaveLength(0);
  expect(CHANNEL_ALERT_AFTER).toBe(3);
  expect(await runSyncRetry(deps, minutes(15))).toEqual({ attempted: 1, alerted: [code] }); // 3rd
  expect(await staffSyncAlerts(db, id)).toMatchObject([{ to: STAFF, status: "sent" }]);
  expect(await runSyncRetry(deps, minutes(35))).toEqual({ attempted: 1 }); // 4th, same Taipei day
  expect(await runSyncRetry(deps, minutes(75))).toEqual({ attempted: 1 });
  expect(await staffSyncAlerts(db, id)).toHaveLength(1);

  // The next Taipei day, still failing: another alert.
  const nextDay = minutes(24 * 60);
  expect(await runSyncRetry(deps, nextDay)).toEqual({ attempted: 1, alerted: [code] });
  expect(await staffSyncAlerts(db, id)).toHaveLength(2);
  expect((await reservation(code)).status).toBe("confirmed");
});

test("a booking that stopped retrying (non-retryable) is alerted at the next run and daily, until staff retry it", async () => {
  const { db, deps, channel, book, reservation, notice, propertyId } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 1, retryable: false }),
  });
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(0));
  const { id } = await reservation(code);
  expect(await runSyncRetry(deps, minutes(5))).toEqual({ attempted: 0, alerted: [code] });
  expect(await runSyncRetry(deps, minutes(10))).toEqual({ attempted: 0 });
  expect(await runSyncRetry(deps, minutes(24 * 60 + 5))).toEqual({ attempted: 0, alerted: [code] });
  expect(await staffSyncAlerts(db, id)).toHaveLength(2);

  // Manual retry (staff fixed the cause).
  const row = { id: "s-fd", email: "fd@nk.test", name: "fd", role: "front_desk" as const, propertyIds: [propertyId], active: true };
  await db.insert(staff).values(row);
  const ctx: StaffContext = { staff: row, email: row.email };
  expect(await retryChannelSync(deps, ctx, id, minutes(24 * 60 + 10))).toEqual({ ok: true, syncState: "synced", outcome: "synced" });
  expect(await reservation(code)).toMatchObject({ syncState: "synced", smConfirmation: channel.records[0].smConfirmation });
  expect(await runSyncRetry(deps, minutes(48 * 60))).toEqual({ attempted: 0 });

  // Other property's staff cannot.
  const other = { ...row, id: "s-other", email: "o@nk.test", propertyIds: ["prop-other"] };
  await db.insert(staff).values(other);
  expect(await retryChannelSync(deps, { staff: other, email: other.email }, id, minutes(48 * 60))).toEqual({ ok: false, error: "NOT_FOUND" });
  expect(await retryChannelSync(deps, ctx, id, minutes(48 * 60))).toEqual({ ok: false, error: "NOT_UNSYNCED" });
});

test("one channel call in flight per property: a second booking waits for the first push, then goes oldest first", async () => {
  const channel = new GatedChannel();
  const { deps, book, reservation, notice } = await bookingSetup({ channel });
  const a = await book({ idempotencyKey: "key-aaaa-000001" });
  const b = await book({ idempotencyKey: "key-bbbb-000002" });
  const payingA = handlePaymentNotice(deps, await notice(a), minutes(1));
  while (channel.inFlight === 0) await tick();
  // B is paid while A's push is in flight: B is confirmed, its push waits.
  await handlePaymentNotice(deps, await notice(b), minutes(1));
  expect(await reservation(b)).toMatchObject({ status: "confirmed", syncState: "pending", syncAttempts: 0, smConfirmation: null });
  expect(channel.inFlight).toBe(1);

  // A retry run meanwhile does not call the channel either.
  expect(await runSyncRetry(deps, minutes(2))).toEqual({ attempted: 0 });
  await channel.open();
  await payingA;
  expect(await reservation(a)).toMatchObject({ syncState: "synced" });

  const run = runSyncRetry(deps, minutes(3));
  await channel.open();
  expect(await run).toEqual({ attempted: 1 });
  expect(await reservation(b)).toMatchObject({ syncState: "synced" });
  expect(channel.maxInFlight).toBe(1);
  expect(channel.records.map((r) => r.code)).toEqual([a, b]);
});

test("the property lease: one holder at a time, taken over once it lapses, released only by its holder", async () => {
  const { db, propertyId } = await bookingSetup();
  expect(SYNC_LEASE_MS).toBeGreaterThanOrEqual(CHANNEL_MAX_TIMEOUT_MS + 30_000);
  const at = (d: Date) => () => d.getTime();
  const h1 = await takePropertyLease(db, propertyId, at(minutes(0)));
  expect(h1).toEqual(expect.any(String));
  expect(await takePropertyLease(db, propertyId, at(minutes(1)))).toBeNull();
  expect(await takePropertyLease(db, "prop-other", at(minutes(1)))).toEqual(expect.any(String)); // another hotel is not blocked
  await releasePropertyLease(db, propertyId, "someone-else");
  expect(await takePropertyLease(db, propertyId, at(minutes(1)))).toBeNull();
  const h2 = await takePropertyLease(db, propertyId, at(new Date(minutes(0).getTime() + SYNC_LEASE_MS)));
  expect(h2).toEqual(expect.any(String));
  expect(h2).not.toBe(h1);
  await releasePropertyLease(db, propertyId, h2!);
  expect(await takePropertyLease(db, propertyId, at(minutes(4)))).toEqual(expect.any(String));
});

test("a cancel of a booking never pushed sends nothing to the channel", async () => {
  const channel = new GatedChannel();
  const { deps, book, reservation, notice } = await bookingSetup({ channel });
  const a = await book({ idempotencyKey: "key-aaaa-000001" });
  const b = await book({ idempotencyKey: "key-bbbb-000002" });
  const payingA = handlePaymentNotice(deps, await notice(a), minutes(1));
  while (channel.inFlight === 0) await tick();
  await handlePaymentNotice(deps, await notice(b), minutes(1)); // B's push waits behind A's
  const push = vi.spyOn(channel, "pushReservation");
  const cancel = vi.spyOn(channel, "cancelReservation");

  expect(await cancelReservation(deps, b, GUEST, minutes(2))).toMatchObject({ ok: true });
  await channel.open();
  await payingA;
  expect(await runSyncRetry(deps, minutes(3))).toEqual({ attempted: 1 });

  expect(push).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  expect(await reservation(b)).toMatchObject({ status: "cancelled", syncState: "not_required", nextSyncAt: null, smConfirmation: null });
  expect(channel.records.map((r) => r.code)).toEqual([a]);
  expect(await runSyncRetry(deps, minutes(60))).toEqual({ attempted: 0 });
});

test("a cancel after a push whose answer was lost re-sends the same code first, then cancels it", async () => {
  const channel = new MockChannelManager({ timeoutNext: 1 });
  const { deps, book, reservation, notice } = await bookingSetup({ channel });
  const push = vi.spyOn(channel, "pushReservation");
  const cancel = vi.spyOn(channel, "cancelReservation");
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(1));
  expect(await reservation(code)).toMatchObject({ status: "confirmed", syncState: "pending", lastSyncError: "TIMEOUT", smConfirmation: null });

  expect(await cancelReservation(deps, code, GUEST, minutes(2))).toMatchObject({ ok: true });
  const sm = channel.records[0].smConfirmation;
  expect(push).toHaveBeenCalledTimes(2);
  expect(push.mock.calls[1][0].code).toBe(code);
  expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ code }), sm);
  expect(await reservation(code)).toMatchObject({ status: "cancelled", syncState: "synced", smConfirmation: sm });
  expect(channel.records).toEqual([{ code, smConfirmation: sm, state: "cancelled" }]);
});

test("a staff change before the first push goes out with that push (Commit); a modify only ever follows a successful push", async () => {
  const { db, deps, channel, book, reservation, notice, propertyId } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 1, retryable: true }),
  });
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(1));
  const { id } = await reservation(code);
  const row = { id: "s-fd", email: "fd@nk.test", name: "fd", role: "front_desk" as const, propertyIds: [propertyId], active: true };
  await db.insert(staff).values(row);
  const ctx: StaffContext = { staff: row, email: row.email };
  const push = vi.spyOn(channel, "pushReservation");
  const modify = vi.spyOn(channel, "modifyReservation");

  const c = { checkIn: "2026-12-01", checkOut: "2026-12-04", adults: 2, children: 0 };
  const p = await previewModification(db, ctx, id, c, minutes(2));
  if (!p.ok) throw new Error(p.error);
  expect(await applyModification(deps, ctx, id, c, { expectedDifference: p.difference, reason: "改期" }, minutes(2))).toMatchObject({ ok: true });
  // The push goes first, with the new stay. The first attempt's outcome is unknown to us, so this push is a resend
  // and a modify follows it (only once the push has succeeded and returned its smConfirmation).
  expect(push).toHaveBeenCalledWith(expect.objectContaining({ code, checkOut: "2026-12-04" }));
  expect(modify).toHaveBeenCalledTimes(1);
  expect(push.mock.invocationCallOrder[0]).toBeLessThan(modify.mock.invocationCallOrder[0]);
  expect(modify.mock.calls[0][1]).toBe(channel.records[0].smConfirmation);
  const res = await reservation(code);
  expect(res).toMatchObject({ syncState: "synced", smConfirmation: channel.records[0].smConfirmation });

  // A later change, now that the channel holds it, is a modify.
  const c2 = { ...c, checkOut: "2026-12-05" };
  const p2 = await previewModification(db, ctx, id, c2, minutes(3));
  if (!p2.ok) throw new Error(p2.error);
  await applyModification(deps, ctx, id, c2, { expectedDifference: p2.difference, reason: "再改" }, minutes(3));
  expect(modify).toHaveBeenCalledWith(expect.objectContaining({ code, checkOut: "2026-12-05" }), res.smConfirmation);
});

test("a staff change while the first push is in flight waits for it, then follows it as a modify", async () => {
  const channel = new GatedChannel();
  const { db, deps, book, reservation, notice, propertyId } = await bookingSetup({ channel });
  const code = await book();
  const paying = handlePaymentNotice(deps, await notice(code), minutes(1));
  while (channel.inFlight === 0) await tick();
  const { id } = await reservation(code);
  const row = { id: "s-fd", email: "fd@nk.test", name: "fd", role: "front_desk" as const, propertyIds: [propertyId], active: true };
  await db.insert(staff).values(row);
  const ctx: StaffContext = { staff: row, email: row.email };
  const modify = vi.spyOn(channel, "modifyReservation");

  const c = { checkIn: "2026-12-01", checkOut: "2026-12-04", adults: 2, children: 0 };
  const p = await previewModification(db, ctx, id, c, minutes(2));
  if (!p.ok) throw new Error(p.error);
  await applyModification(deps, ctx, id, c, { expectedDifference: p.difference, reason: "改期" }, minutes(2));
  expect(modify).not.toHaveBeenCalled(); // the push still holds the property

  await channel.open();
  await paying;
  // The push carried the old stay: right after it, under the same lease, the change goes out as a modify.
  const sm = channel.records[0].smConfirmation;
  expect(modify).toHaveBeenCalledWith(expect.objectContaining({ code, checkOut: "2026-12-04" }), sm);
  expect(await reservation(code)).toMatchObject({ syncState: "synced", smConfirmation: sm });
  expect(channel.records[0]).toMatchObject({ code, state: "active" });
  expect(await runSyncRetry(deps, minutes(3))).toEqual({ attempted: 0 });
  expect(channel.maxInFlight).toBe(1);
});

test("a cancel while the first push is in flight is sent after it, under the push's smConfirmation", async () => {
  const channel = new GatedChannel();
  const { deps, book, reservation, notice } = await bookingSetup({ channel });
  const code = await book();
  const paying = handlePaymentNotice(deps, await notice(code), minutes(1));
  while (channel.inFlight === 0) await tick();
  expect(await cancelReservation(deps, code, GUEST, minutes(2))).toMatchObject({ ok: true });
  expect(channel.inFlight).toBe(1);
  await channel.open(); // the push
  await channel.open(); // then, under the same lease, the cancel
  await paying;
  const sm = channel.records[0].smConfirmation;
  expect(channel.records).toEqual([{ code, smConfirmation: sm, state: "cancelled" }]);
  expect(await reservation(code)).toMatchObject({ status: "cancelled", syncState: "synced", smConfirmation: sm });
  expect(await runSyncRetry(deps, minutes(3))).toEqual({ attempted: 0 });
  expect(channel.maxInFlight).toBe(1);
});

test("once cancelled at the channel, nothing more is ever sent for the code", async () => {
  const { deps, channel, book, reservation, notice } = await bookingSetup();
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(1));
  await cancelReservation(deps, code, GUEST, minutes(2));
  expect(await reservation(code)).toMatchObject({ status: "cancelled", syncState: "synced" });
  const calls = [vi.spyOn(channel, "pushReservation"), vi.spyOn(channel, "modifyReservation"), vi.spyOn(channel, "cancelReservation")];
  const { id } = await reservation(code);
  expect(await syncWithChannel(deps, id, minutes(3))).toBe("not_due");
  await runSyncRetry(deps, minutes(10));
  for (const c of calls) expect(c).not.toHaveBeenCalled();
});

test("a run stops starting channel calls once its time budget is spent", async () => {
  const { deps, book, notice } = await bookingSetup({
    available: 10, channel: new MockChannelManager({ failNext: 3, retryable: true }),
  });
  for (let i = 0; i < 3; i++) {
    const code = await book({ idempotencyKey: `key-budget-${String(i).padStart(4, "0")}` });
    await handlePaymentNotice(deps, await notice(code), minutes(0));
  }
  let t = 0;
  const clock = () => (t += SYNC_RUN_BUDGET_MS / 2);
  expect((await runSyncRetry(deps, minutes(10), { clock })).attempted).toBe(1);
});

test("leases go by the real clock: a run's old business time cannot take a lease a call is holding", async () => {
  const channel = new GatedChannel();
  const { deps, book, reservation, notice, db, propertyId } = await bookingSetup({ channel });
  const a = await book({ idempotencyKey: "key-aaaa-000001" });
  // A cron run whose scheduled `now` is long past (it reached this booking late) is pushing A...
  const payingA = handlePaymentNotice(deps, await notice(a), minutes(1));
  while (channel.inFlight === 0) await tick();
  // ...while a request at a business time far beyond the old lease's expiry kicks the same property: still busy.
  const b = await book({ idempotencyKey: "key-bbbb-000002" });
  await handlePaymentNotice(deps, await notice(b), minutes(60));
  expect(channel.inFlight).toBe(1);
  expect(await reservation(b)).toMatchObject({ syncState: "pending", syncAttempts: 0 });
  expect(await takePropertyLease(db, propertyId)).toBeNull();
  await channel.open();
  await payingA;
  expect(channel.maxInFlight).toBe(1);
});

test("a lease renewed between steps runs from the real time of the renewal; one already lapsed cannot be renewed", async () => {
  const { db, propertyId } = await bookingSetup();
  let t = 1_000_000;
  const clock = () => t;
  const h = (await takePropertyLease(db, propertyId, clock))!;
  t += 150_000; // a 120 s call and our own work
  expect(await renewPropertyLease(db, propertyId, h, clock)).toBe(true);
  t += SYNC_LEASE_MS - 1; // the second step is still inside the renewed lease: nobody else can take it
  expect(await takePropertyLease(db, propertyId, clock)).toBeNull();
  t += 1; // lapsed
  expect(await renewPropertyLease(db, propertyId, h, clock)).toBe(false);
  const other = await takePropertyLease(db, propertyId, clock);
  expect(other).toEqual(expect.any(String));
  expect(await renewPropertyLease(db, propertyId, h, clock)).toBe(false); // two holders never both hold it
});

test("a push that landed but timed out, then a staff change: the resend is followed by a modify, so the channel has the new stay", async () => {
  const channel = new MockChannelManager({ timeoutNext: 1 });
  const { db, deps, book, reservation, notice, propertyId } = await bookingSetup({ channel });
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(1));
  expect(await reservation(code)).toMatchObject({ syncState: "pending", smConfirmation: null, lastSyncError: "TIMEOUT" });
  expect(channel.pushed[0]).toMatchObject({ checkOut: "2026-12-03" }); // it landed, answer lost
  const { id } = await reservation(code);
  const row = { id: "s-fd", email: "fd@nk.test", name: "fd", role: "front_desk" as const, propertyIds: [propertyId], active: true };
  await db.insert(staff).values(row);
  const ctx: StaffContext = { staff: row, email: row.email };
  const modify = vi.spyOn(channel, "modifyReservation");

  const c = { checkIn: "2026-12-01", checkOut: "2026-12-04", adults: 2, children: 0 };
  const p = await previewModification(db, ctx, id, c, minutes(2));
  if (!p.ok) throw new Error(p.error);
  await applyModification(deps, ctx, id, c, { expectedDifference: p.difference, reason: "改期" }, minutes(2));
  // The resend of the same code is answered with what the channel holds (the old stay); a modify follows at once.
  const sm = channel.records[0].smConfirmation;
  expect(modify).toHaveBeenCalledWith(expect.objectContaining({ code, checkOut: "2026-12-04" }), sm);
  expect(channel.pushed).toMatchObject([{ code, checkOut: "2026-12-04" }]);
  expect(await reservation(code)).toMatchObject({ syncState: "synced", smConfirmation: sm });
});

test("a resend answered 'already exists' without a confirmation stops for staff (SITEMINDER-OPEN-Q1)", () => {
  expect(resendAnswer({ ok: true, smConfirmation: "SM-1" })).toEqual({ ok: true, smConfirmation: "SM-1" });
  expect(resendAnswer({ ok: false, retryable: true, error: "TIMEOUT" })).toEqual({ ok: false, retryable: true, error: "TIMEOUT" });
  // Read from the adapter's structured detail, never from the error text.
  const http409 = { ok: false as const, retryable: false, error: "SITEMINDER_HTTP_409", detail: { kind: "http" as const, httpStatus: 409 } };
  expect(resendAnswer(http409)).toEqual({ ...http409, error: "RESEND_ALREADY_HELD_NO_CONFIRMATION: SITEMINDER_HTTP_409" });
  expect(resendAnswer({ ok: false, retryable: false, error: "HTTP 409 ALREADY_EXISTS DUPLICATE" }))
    .toEqual({ ok: false, retryable: false, error: "HTTP 409 ALREADY_EXISTS DUPLICATE" });
  const http503 = { ok: false as const, retryable: true, error: "SITEMINDER_HTTP_503", detail: { kind: "http" as const, httpStatus: 503 } };
  expect(resendAnswer(http503)).toEqual(http503);
  const ota = { ok: false as const, retryable: false, error: "SITEMINDER_ERROR type=6: Hotel not found", detail: { kind: "ota" as const, type: 6 } };
  expect(resendAnswer(ota)).toEqual(ota);
});

test("a first push refused outright is not counted as pushed: a later cancel sends nothing", async () => {
  const { deps, channel, book, reservation, notice } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 1, retryable: false }),
  });
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(1));
  expect(await reservation(code)).toMatchObject({ syncState: "failed", channelPushedAt: null, lastSyncAt: minutes(1).getTime() });
  const push = vi.spyOn(channel, "pushReservation");
  const cancel = vi.spyOn(channel, "cancelReservation");
  expect(await cancelReservation(deps, code, GUEST, minutes(2))).toMatchObject({ ok: true });
  expect(push).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  expect(await reservation(code)).toMatchObject({ status: "cancelled", syncState: "not_required" });
});

test("the dashboard's sync_failed alert is dated from the failure, not from later edits of the booking", async () => {
  const { db, deps, book, reservation, notice, propertyId } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 1, retryable: false }),
  });
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(1));
  const { id } = await reservation(code);
  await db.update(reservations).set({ updatedAt: minutes(30).getTime() }).where(eq(reservations.id, id));
  const { alerts } = await getDashboard(db, propertyId, minutes(40));
  expect(alerts.filter((a) => a.kind === "sync_failed")).toMatchObject([{ reservationId: id, since: minutes(1).getTime() }]);
});

test("a refunded booking the earlier design had pushed, still unsynced, is alerted and offered for retry", async () => {
  const { db, deps, book, reservation, notice } = await bookingSetup();
  const code = await book();
  await handlePaymentNotice(deps, await notice(code, { amount: PAY_NOW - 1 }), minutes(1)); // refunded, never pushed
  const { id } = await reservation(code);
  expect(await runSyncRetry(deps, minutes(5))).toEqual({ attempted: 0 }); // nothing of it is at the channel
  expect(unsyncedWithChannel(await reservation(code))).toBe(false);
  await db.update(reservations).set({ channelPushedAt: minutes(0).getTime() }).where(eq(reservations.id, id)); // as a legacy row
  expect(unsyncedWithChannel(await reservation(code))).toBe(true);
  expect(await runSyncRetry(deps, minutes(10))).toEqual({ attempted: 0, alerted: [code] });
});
