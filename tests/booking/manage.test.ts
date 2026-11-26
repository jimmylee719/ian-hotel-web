import { and, eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { refundOnce } from "@/lib/booking/confirm";
import { cancelReservation, findReservation } from "@/lib/booking/manage";
import { refundableCharges } from "@/lib/booking/notify";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { MockChannelManager } from "@/lib/channel/mock";
import { inventoryDaily, notifications, payments } from "@/lib/db/schema";
import { runSyncRetry } from "@/lib/jobs/sync-retry";
import { fillAri } from "@/tests/helpers/ari";
import { bookingSetup, minutes, STAFF } from "@/tests/helpers/booking";
import { rawSqlite } from "@/tests/helpers/test-db";

const PAID = 4960; // 2 nights × 2480
const GUEST = "mei@example.com";
const EARLY = new Date("2026-12-06T16:00:00Z"); // 2026-12-07 Taipei: 3 days before check-in → 100%
const LATE = new Date("2026-12-09T16:00:00Z"); // 2026-12-10 Taipei: check-in day → 0%

/** A confirmed booking for 2026-12-10 → 12-12, paid 4960 with the seed's direct-flex plan. */
async function confirmedBooking(o: { channel?: MockChannelManager; failRefund?: boolean } = {}) {
  const s = await bookingSetup(o);
  await fillAri(s.db, s.propertyId, "2026-12-10", 2, { available: 3, price: 2480 });
  const code = await s.book({ checkIn: "2026-12-10", checkOut: "2026-12-12" });
  await handlePaymentNotice(s.deps, await s.notice(code, { amount: PAID }), minutes(2));
  expect((await s.reservation(code)).status).toBe("confirmed");
  const avail10 = async () =>
    (await s.db.select().from(inventoryDaily)
      .where(and(eq(inventoryDaily.unitTypeId, s.ids.unitTypeId), eq(inventoryDaily.date, "2026-12-10"))))[0].available;
  return { ...s, code, avail10 };
}

test("lookup needs the code (any case) and the guest's email (any case)", async () => {
  const { db, code } = await confirmedBooking();
  const v = await findReservation(db, code.toLowerCase(), "MEI@Example.com", EARLY);
  expect(v).toMatchObject({
    code, status: "confirmed", checkIn: "2026-12-10", checkOut: "2026-12-12",
    roomTypeName: { en: "MIXED CUBE", "zh-TW": "男.女混合雙人旅艙" },
    ratePlanName: { en: "Direct Exclusive · Flexible" },
    paid: PAID, refunded: 0, refundIfCancelledNow: PAID, canCancel: true,
  });
  expect(v!.quote).toMatchObject({ payNow: PAID });
  expect((await findReservation(db, code, GUEST, new Date("2026-12-08T16:00:00Z")))!.refundIfCancelledNow).toBe(PAID / 2);
  expect((await findReservation(db, code, GUEST, LATE))!.refundIfCancelledNow).toBe(0);
});

test("cancelling 3 days ahead refunds in full, removes it from the channel, frees the rooms and emails the guest", async () => {
  const { db, deps, gateway, channel, email, code, reservation, avail10 } = await confirmedBooking();
  const refund = vi.spyOn(gateway, "refund");
  expect(channel.pushed.map((p) => p.code)).toEqual([code]);
  expect(await avail10()).toBe(2);

  expect(await cancelReservation(deps, code, GUEST, EARLY)).toEqual({ ok: true, refunded: PAID, alreadyCancelled: false });

  const res = await reservation(code);
  expect(res.status).toBe("cancelled");
  expect(res.refundedAmount).toBe(PAID);
  expect(res.cancelledAt).toBe(EARLY.getTime());
  expect(res.syncState).toBe("synced");
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ providerRef: `REF-${code}`, amount: PAID }));
  const [charge] = await db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "charge")));
  expect(await db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund"))))
    .toMatchObject([{ amount: PAID, status: "succeeded", refundOf: charge.id }]);
  expect(channel.pushed).toEqual([]);
  expect(await avail10()).toBe(3);
  const mail = email.sent.filter((e) => e.subject.includes("cancelled"));
  expect(mail.map((e) => e.to)).toEqual([GUEST]);
  expect(mail[0].text).toContain("4,960");
  expect(await db.select().from(notifications).where(and(eq(notifications.reservationId, res.id), eq(notifications.kind, "cancelled"))))
    .toHaveLength(2); // guest and staff

  const v = await findReservation(db, code, GUEST, EARLY);
  expect(v).toMatchObject({ status: "cancelled", paid: 0, refunded: PAID, refundIfCancelledNow: 0, canCancel: false });
});

test("cancelling on check-in day refunds nothing but still cancels and tells SiteMinder", async () => {
  const { deps, gateway, channel, code, reservation, avail10 } = await confirmedBooking();
  const refund = vi.spyOn(gateway, "refund");
  const cancel = vi.spyOn(channel, "cancelReservation");

  expect(await cancelReservation(deps, code, GUEST, LATE)).toEqual({ ok: true, refunded: 0, alreadyCancelled: false });
  const res = await reservation(code);
  expect(res.status).toBe("cancelled");
  expect(res.refundedAmount).toBe(0);
  expect(refund).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ code }), res.smConfirmation); // the confirmation its push returned
  expect(res.smConfirmation).toMatch(/^SM-/);
  expect(channel.pushed).toEqual([]);
  expect(await avail10()).toBe(3);
});

test("after check-in day the booking cannot be cancelled: nothing is refunded, released or sent to SiteMinder", async () => {
  const { db, deps, gateway, channel, code, reservation, avail10 } = await confirmedBooking();
  const refund = vi.spyOn(gateway, "refund");
  const cancel = vi.spyOn(channel, "cancelReservation");
  const DAY_AFTER = new Date("2026-12-10T16:00:00Z"); // 2026-12-11 Taipei: night 2
  const AFTER_CHECKOUT = new Date("2026-12-12T16:00:00Z"); // 2026-12-13 Taipei
  expect(await avail10()).toBe(2);

  for (const at of [DAY_AFTER, AFTER_CHECKOUT]) {
    expect(await findReservation(db, code, GUEST, at)).toMatchObject({ status: "confirmed", canCancel: false, refundIfCancelledNow: 0 });
    expect(await cancelReservation(deps, code, GUEST, at)).toEqual({ ok: false, error: "NOT_CANCELLABLE" });
  }
  const res = await reservation(code);
  expect(res.status).toBe("confirmed");
  expect(res.cancelledAt).toBeNull();
  expect(refund).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  expect(channel.pushed.map((p) => p.code)).toEqual([code]);
  expect(await avail10()).toBe(2);
  expect((await findReservation(db, code, GUEST, LATE))!.canCancel).toBe(true);
});

test("cancelling twice refunds once", async () => {
  const { deps, gateway, code, avail10 } = await confirmedBooking();
  const refund = vi.spyOn(gateway, "refund");
  expect(await cancelReservation(deps, code, GUEST, EARLY)).toEqual({ ok: true, refunded: PAID, alreadyCancelled: false });
  expect(await cancelReservation(deps, code, GUEST, EARLY)).toEqual({ ok: true, refunded: PAID, alreadyCancelled: true });
  expect(refund).toHaveBeenCalledTimes(1);
  expect(await avail10()).toBe(3);
});

test("two concurrent cancels refund once", async () => {
  const { deps, gateway, code, reservation } = await confirmedBooking();
  const refund = vi.spyOn(gateway, "refund");
  const rs = await Promise.all([cancelReservation(deps, code, GUEST, EARLY), cancelReservation(deps, code, GUEST, EARLY)]);
  expect(rs.filter((r) => r.ok && !r.alreadyCancelled)).toHaveLength(1);
  expect(refund).toHaveBeenCalledTimes(1);
  expect((await reservation(code)).refundedAmount).toBe(PAID);
});

test("a wrong email finds nothing and cancels nothing", async () => {
  const { db, deps, gateway, code, reservation } = await confirmedBooking();
  const refund = vi.spyOn(gateway, "refund");
  expect(await findReservation(db, code, "someone@example.com", EARLY)).toBeNull();
  expect(await findReservation(db, "NK-XXXXXX", GUEST, EARLY)).toBeNull();
  expect(await cancelReservation(deps, code, "someone@example.com", EARLY)).toEqual({ ok: false, error: "NOT_FOUND" });
  expect((await reservation(code)).status).toBe("confirmed");
  expect(refund).not.toHaveBeenCalled();
});

test("an unpaid booking cannot be cancelled", async () => {
  const s = await bookingSetup();
  const code = await s.book();
  expect(await cancelReservation(s.deps, code, GUEST, EARLY)).toEqual({ ok: false, error: "NOT_CANCELLABLE" });
  expect(await findReservation(s.db, code, GUEST, EARLY)).toMatchObject({ canCancel: false, refundIfCancelledNow: 0 });
});

test("a failed refund leaves the booking confirmed and alerts staff; a later try can still cancel", async () => {
  const { db, deps, gateway, channel, email, code, reservation, avail10 } = await confirmedBooking({ failRefund: true });
  expect(await cancelReservation(deps, code, GUEST, EARLY)).toEqual({ ok: false, error: "REFUND_FAILED" });

  const res = await reservation(code);
  expect(res.status).toBe("confirmed");
  expect(res.refundedAmount).toBe(0);
  expect(res.cancelledAt).toBeNull();
  expect(channel.pushed.map((p) => p.code)).toEqual([code]);
  expect(await avail10()).toBe(2);
  expect(await db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund"))))
    .toMatchObject([{ status: "failed", amount: PAID }]);
  expect(email.sent.filter((e) => e.to === STAFF && e.subject.includes("付款異常"))).toHaveLength(1);
  expect(email.sent.filter((e) => e.to === GUEST && e.subject.includes("cancelled"))).toHaveLength(0);

  vi.spyOn(gateway, "refund").mockResolvedValueOnce({ ok: true, refundRef: "R-2" });
  expect(await cancelReservation(deps, code, GUEST, EARLY)).toEqual({ ok: true, refunded: PAID, alreadyCancelled: false });
});

test("a retryable channel cancel failure is retried by the sync job", async () => {
  const { deps, channel, code, reservation } = await confirmedBooking();
  const cancel = vi.spyOn(channel, "cancelReservation")
    .mockResolvedValueOnce({ ok: false, retryable: true, error: "MOCK_FAILURE" });
  const push = vi.spyOn(channel, "pushReservation");

  expect(await cancelReservation(deps, code, GUEST, EARLY)).toEqual({ ok: true, refunded: PAID, alreadyCancelled: false });
  let res = await reservation(code);
  expect(res.status).toBe("cancelled");
  expect(res.syncState).toBe("pending");
  expect(res.lastSyncError).toBe("MOCK_FAILURE");
  expect(channel.pushed.map((p) => p.code)).toEqual([code]);

  const later = new Date(EARLY.getTime() + 5 * 60_000);
  expect(await runSyncRetry(deps, later)).toEqual({ attempted: 1 });
  res = await reservation(code);
  expect(res.syncState).toBe("synced");
  expect(cancel).toHaveBeenCalledTimes(2);
  expect(push).not.toHaveBeenCalled();
  expect(channel.pushed).toEqual([]);
});

test("a channel cancel refused (not retryable) stops retrying and alerts staff at the next run", async () => {
  const { deps, channel, email, code, reservation } = await confirmedBooking();
  vi.spyOn(channel, "cancelReservation").mockResolvedValue({ ok: false, retryable: false, error: "REJECTED" });
  await cancelReservation(deps, code, GUEST, EARLY);
  const res = await reservation(code);
  expect(res.status).toBe("cancelled");
  expect(res.syncState).toBe("failed");
  expect(await runSyncRetry(deps, new Date(EARLY.getTime() + 60 * 60_000))).toEqual({ attempted: 0, alerted: [code] });
  expect(email.sent.filter((e) => e.to === STAFF && e.subject.includes("同步"))).toHaveLength(1);
  expect(await runSyncRetry(deps, new Date(EARLY.getTime() + 65 * 60_000))).toEqual({ attempted: 0 });
});

test("a cancel that crashed after refunding is finished by a later request without refunding twice", async () => {
  const { db, deps, gateway, code, reservation, avail10 } = await confirmedBooking();
  const refund = vi.spyOn(gateway, "refund");
  rawSqlite(db).exec(`CREATE TRIGGER boom BEFORE UPDATE OF status ON reservations BEGIN SELECT RAISE(ABORT, 'crash'); END`);
  await expect(cancelReservation(deps, code, GUEST, EARLY)).rejects.toThrow();
  rawSqlite(db).exec(`DROP TRIGGER boom`);
  expect(refund).toHaveBeenCalledTimes(1);
  expect((await reservation(code)).status).toBe("confirmed");

  // Inside the lease another request backs off; after it (and a day later), it finishes at the original terms.
  expect(await cancelReservation(deps, code, GUEST, new Date(EARLY.getTime() + 60_000))).toEqual({ ok: false, error: "NOT_CANCELLABLE" });
  const later = new Date(EARLY.getTime() + 24 * 3600_000);
  expect(await cancelReservation(deps, code, GUEST, later)).toEqual({ ok: true, refunded: PAID, alreadyCancelled: false });
  expect(refund).toHaveBeenCalledTimes(1);
  const res = await reservation(code);
  expect(res).toMatchObject({ status: "cancelled", refundedAmount: PAID, cancelledAt: EARLY.getTime() });
  expect(await avail10()).toBe(3);
});

test("a refund whose outcome is unknown (gateway refunded, then the call failed) is never repeated", async () => {
  const { db, deps, gateway, email, code, reservation } = await confirmedBooking();
  const real = gateway.refund.bind(gateway);
  // The gateway refunds, then the call dies before we can record the result.
  vi.spyOn(gateway, "refund").mockImplementationOnce(async (r) => { await real(r); throw new Error("connection reset"); });
  vi.spyOn(gateway, "queryRefund").mockResolvedValueOnce({ error: "QUERY_DOWN" }); // and the gateway cannot say

  expect(await cancelReservation(deps, code, GUEST, EARLY)).toEqual({ ok: false, error: "REFUND_FAILED" });
  const res = await reservation(code);
  const [intent] = await db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund")));
  expect(intent).toMatchObject({ status: "pending", amount: PAID });
  expect(email.sent.filter((e) => e.to === STAFF && e.subject.includes("付款異常"))).toHaveLength(1);

  // Another try (after the lease, a day later) must not call the gateway again.
  const later = new Date(EARLY.getTime() + 24 * 3600_000);
  expect(await cancelReservation(deps, code, GUEST, later)).toEqual({ ok: false, error: "REFUND_FAILED" });
  expect(gateway.refunds).toHaveLength(1);
  expect(gateway.refund).toHaveBeenCalledTimes(1); // only the first attempt reached the gateway
  const after = await reservation(code);
  expect(after).toMatchObject({ status: "confirmed", refundedAmount: 0 });
  expect(await db.select().from(notifications).where(and(
    eq(notifications.reservationId, res.id), eq(notifications.kind, "staff_payment_alert"), eq(notifications.ref, intent.id),
  ))).toHaveLength(1);
});

test("a successful cancel refund goes pending → succeeded under the cancellation's idempotency key", async () => {
  const { db, deps, gateway, code, reservation } = await confirmedBooking();
  const refund = vi.spyOn(gateway, "refund");
  await cancelReservation(deps, code, GUEST, EARLY);
  const res = await reservation(code);
  const [row] = await db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund")));
  expect(row).toMatchObject({ status: "succeeded", amount: PAID, providerRef: gateway.refunds[0].refundRef });
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: `cancel:${res.id}` }));
  expect(res.refundedAmount).toBe(PAID);
});

const HALF = new Date("2026-12-08T16:00:00Z"); // 2026-12-09 Taipei: 1 day before check-in → 50%
const tick = () => new Promise((r) => setImmediate(r));

/** Hold the next gateway refund until `release()`; `started` resolves when the call reaches the gateway. */
function slowRefund(gateway: Awaited<ReturnType<typeof confirmedBooking>>["gateway"]) {
  const real = gateway.refund.bind(gateway);
  let release!: () => void;
  let reached = false;
  const gate = new Promise<void>((r) => { release = r; });
  vi.spyOn(gateway, "refund").mockImplementationOnce(async (r) => { reached = true; await gate; return real(r); });
  return { release: () => release(), started: async () => { while (!reached) await tick(); } };
}

test("R2: a slow refund that outlives the lease still completes the cancellation after a blocked takeover", async () => {
  const { db, deps, gateway, email, code, reservation, avail10 } = await confirmedBooking();
  const slow = slowRefund(gateway);
  const first = cancelReservation(deps, code, GUEST, HALF);
  await slow.started();

  // Past the lease, another request finds the refund in flight: it must not refund, and must not drop the claim.
  const takeover = new Date(HALF.getTime() + 3 * 60_000);
  expect(await cancelReservation(deps, code, GUEST, takeover)).toEqual({ ok: false, error: "REFUND_FAILED" });
  expect(await reservation(code)).toMatchObject({ status: "confirmed", cancelledAt: HALF.getTime() });
  expect(email.sent.filter((e) => e.to === STAFF && e.subject.includes("付款異常"))).toHaveLength(1);

  slow.release();
  expect(await first).toEqual({ ok: true, refunded: PAID / 2, alreadyCancelled: false });
  const res = await reservation(code);
  expect(res).toMatchObject({ status: "cancelled", refundedAmount: PAID / 2 });
  expect(await avail10()).toBe(3);
  expect(await cancelReservation(deps, code, GUEST, new Date(HALF.getTime() + 3600_000)))
    .toEqual({ ok: true, refunded: PAID / 2, alreadyCancelled: true });
  expect(gateway.refunds).toHaveLength(1);
  expect(await db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund"))))
    .toMatchObject([{ status: "succeeded", amount: PAID / 2, idempotencyKey: `cancel:${res.id}` }]);
});

test("R1: however a takeover interleaves with a slow refund finishing, the guest is refunded once", async () => {
  // The takeover starts first; the slow refund is released k microtasks into it, so across k the
  // first attempt's row turns succeeded at every point of the takeover (before, during, after its reads).
  for (let k = 0; k < 60; k += 2) {
    const { db, deps, gateway, code, reservation } = await confirmedBooking();
    const slow = slowRefund(gateway);
    const first = cancelReservation(deps, code, GUEST, HALF);
    await slow.started();
    const second = cancelReservation(deps, code, GUEST, new Date(HALF.getTime() + 3 * 60_000));
    for (let i = 0; i < k; i++) await Promise.resolve();
    slow.release();
    await Promise.all([first, second]);

    const res = await reservation(code);
    expect(gateway.refunds, `k=${k}`).toHaveLength(1);
    expect(res, `k=${k}`).toMatchObject({ status: "cancelled", refundedAmount: PAID / 2 });
    expect(await db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund"))), `k=${k}`)
      .toHaveLength(1);
  }
});

test("a failed refund row is retried by exactly one attempt", async () => {
  const { db, deps, gateway, code, reservation } = await confirmedBooking({ failRefund: true });
  expect(await cancelReservation(deps, code, GUEST, EARLY)).toEqual({ ok: false, error: "REFUND_FAILED" });
  const res = await reservation(code);
  const [row] = await db.select().from(payments).where(eq(payments.idempotencyKey, `cancel:${res.id}`));
  expect(row.status).toBe("failed");

  const refund = vi.spyOn(gateway, "refund").mockImplementation(async (r) => {
    await tick();
    return { ok: true, refundRef: `R-${r.idempotencyKey}` };
  });
  const [charge] = (await refundableCharges(db, res.id));
  const rs = await Promise.all([1, 2].map(() => refundOnce(deps, row.idempotencyKey!, charge, 1, "RETRY", EARLY, { countsAsBookingRefund: true })));
  expect(refund).toHaveBeenCalledTimes(1);
  expect(rs.filter((r) => r.ok)).toEqual([{ ok: true, amount: PAID }]); // the row's amount, not the one passed in
  expect(rs.filter((r) => !r.ok)).toMatchObject([{ pendingRefundId: row.id }]);
  expect((await reservation(code)).refundedAmount).toBe(PAID);

  // The cancellation then completes on the succeeded row without another refund.
  expect(await cancelReservation(deps, code, GUEST, EARLY)).toEqual({ ok: true, refunded: PAID, alreadyCancelled: false });
  expect(refund).toHaveBeenCalledTimes(1);
});
