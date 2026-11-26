import { and, eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { notifyStaff, onlineNetAmount } from "@/lib/booking/notify";
import { handlePaymentNotice, refundStray } from "@/lib/booking/payment-notice";
import { MockChannelManager } from "@/lib/channel/mock";
import type { ChannelReservation } from "@/lib/channel/types";
import { notifications, paymentEvents, payments, reservations } from "@/lib/db/schema";
import { bookingSetup, minutes, PAY_NOW, STAFF } from "@/tests/helpers/booking";
import { rawSqlite } from "@/tests/helpers/test-db";

test("a paid booking is confirmed here before it is handed to the channel", async () => {
  const seenAtPush: string[] = [];
  const channel = new MockChannelManager();
  const { db, deps, book, reservation, notice } = await bookingSetup({ channel });
  const push = channel.pushReservation.bind(channel);
  channel.pushReservation = async (r: ChannelReservation) => {
    seenAtPush.push((await db.select().from(reservations).where(eq(reservations.code, r.code)))[0].status);
    return push(r);
  };
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(2));
  expect(seenAtPush).toEqual(["confirmed"]);
  expect((await reservation(code)).status).toBe("confirmed");
});

test("a second, different charge on a confirmed booking is refunded against its own ref and alerted", async () => {
  const { db, deps, gateway, channel, email, book, reservation, notice } = await bookingSetup();
  const refund = vi.spyOn(gateway, "refund");
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(2));
  const res = await reservation(code);

  expect(await handlePaymentNotice(deps, await notice(code, { providerRef: "REF-STRAY-1" }), minutes(3)))
    .toEqual({ status: 200, verdict: "stray_charge" });
  expect(refund).toHaveBeenCalledTimes(1);
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ providerRef: "REF-STRAY-1", amount: PAY_NOW }));
  const [stray] = await db.select().from(payments).where(eq(payments.providerRef, "REF-STRAY-1"));
  expect(await db.select().from(payments).where(eq(payments.refundOf, stray.id)))
    .toMatchObject([{ kind: "refund", status: "succeeded", amount: PAY_NOW }]);
  expect(await onlineNetAmount(db, res.id)).toBe(PAY_NOW);
  expect((await reservation(code)).status).toBe("confirmed");
  expect((await reservation(code)).refundedAmount).toBe(0);
  expect(channel.pushed).toHaveLength(1);
  expect(email.sent.filter((e) => e.to === STAFF && e.subject.includes("付款異常"))).toHaveLength(1);
  expect((await db.select().from(paymentEvents)).map((e) => e.verdict)).toEqual(["accepted", "stray_charge"]);

  // A second stray gets its own alert; the unique index does not swallow it.
  await handlePaymentNotice(deps, await notice(code, { providerRef: "REF-STRAY-2", amount: 50 }), minutes(4));
  expect(refund).toHaveBeenLastCalledWith(expect.objectContaining({ providerRef: "REF-STRAY-2", amount: 50 }));
  expect(email.sent.filter((e) => e.to === STAFF && e.subject.includes("付款異常"))).toHaveLength(2);
  expect(await onlineNetAmount(db, res.id)).toBe(PAY_NOW);
});

test("a stray charge whose refund fails stays recorded, flagged and alerted", async () => {
  const { db, deps, email, book, reservation, notice } = await bookingSetup({ failRefund: true });
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(2));
  expect(await handlePaymentNotice(deps, await notice(code, { providerRef: "REF-STRAY" }), minutes(3)))
    .toEqual({ status: 200, verdict: "stray_charge" });
  const res = await reservation(code);
  expect(res.status).toBe("confirmed");
  expect(res.lastSyncError).toContain("STRAY_REFUND_FAILED");
  expect(await db.select().from(payments).where(eq(payments.providerRef, "REF-STRAY"))).toMatchObject([{ status: "succeeded" }]);
  expect(email.sent.some((e) => e.to === STAFF && e.subject.includes("付款異常"))).toBe(true);
});

test("a stray charge on a refunded booking is refunded too", async () => {
  const { deps, gateway, book, reservation, notice } = await bookingSetup();
  const refund = vi.spyOn(gateway, "refund");
  const code = await book();
  await handlePaymentNotice(deps, await notice(code, { amount: PAY_NOW - 1 }), minutes(2)); // refunded: wrong amount
  expect((await reservation(code)).status).toBe("confirm_failed_refunded");
  expect(await handlePaymentNotice(deps, await notice(code, { providerRef: "REF-LATE" }), minutes(3)))
    .toEqual({ status: 200, verdict: "stray_charge" });
  expect(refund).toHaveBeenLastCalledWith(expect.objectContaining({ providerRef: "REF-LATE", amount: PAY_NOW }));
  expect((await reservation(code)).refundedAmount).toBe(PAY_NOW - 1); // the stray refund is not the booking's own
});

test("a guest email that throws does not stop the booking or the staff email", async () => {
  const { deps, email, book, reservation, notice } = await bookingSetup();
  const send = email.send.bind(email);
  const attempted: string[] = [];
  email.send = async (e) => {
    attempted.push(e.to);
    if (e.to === "mei@example.com") throw new Error("smtp down");
    return send(e);
  };
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(2));
  expect((await reservation(code)).status).toBe("confirmed");
  expect(attempted).toContain(STAFF);
});

test("a database error while emailing the guest is logged and the staff email still goes out", async () => {
  const { db, deps, email, book, reservation, notice } = await bookingSetup();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  rawSqlite(db).exec(`CREATE TRIGGER boom BEFORE INSERT ON notifications WHEN NEW."to" = 'mei@example.com'
    BEGIN SELECT RAISE(ABORT, 'notifications down'); END`);
  const code = await book();
  expect(await handlePaymentNotice(deps, await notice(code), minutes(2))).toEqual({ status: 200, verdict: "accepted" });
  const res = await reservation(code);
  expect(res.status).toBe("confirmed");
  expect(email.sent.map((e) => e.to)).toEqual([STAFF]);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining(res.id), expect.anything());
  errors.mockRestore();
});

test("a resend of the paying charge on a cancelled, partly refunded booking is a duplicate and refunds nothing", async () => {
  const { db, deps, gateway, book, reservation, notice } = await bookingSetup();
  const code = await book();
  const n = await notice(code);
  await handlePaymentNotice(deps, n, minutes(2));
  const res = await reservation(code);
  const [paying] = await db.select().from(payments).where(eq(payments.providerRef, `REF-${code}`));
  // What Task 6 leaves behind: a partial refund, the rest kept by the hotel.
  await db.insert(payments).values({
    id: "partial", reservationId: res.id, kind: "refund", method: "sinopac_online", amount: 1000,
    status: "succeeded", providerRef: "RFD-1", refundOf: paying.id, createdAt: minutes(60).getTime(),
  });
  await db.update(reservations).set({ status: "cancelled", refundedAmount: 1000 }).where(eq(reservations.id, res.id));
  const refund = vi.spyOn(gateway, "refund");

  expect(await handlePaymentNotice(deps, n, minutes(61))).toEqual({ status: 200, verdict: "duplicate" });
  expect(refund).not.toHaveBeenCalled();
  expect((await reservation(code)).status).toBe("cancelled");
  expect(await onlineNetAmount(db, res.id)).toBe(PAY_NOW - 1000);
});

test("refundStray does nothing when the stray charge is already refunded", async () => {
  const { db, deps, gateway, email, book, reservation, notice } = await bookingSetup();
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(2));
  await handlePaymentNotice(deps, await notice(code, { providerRef: "REF-STRAY" }), minutes(3));
  const refund = vi.spyOn(gateway, "refund");
  const mails = email.sent.length;
  const [stray] = await db.select().from(payments).where(eq(payments.providerRef, "REF-STRAY"));

  await refundStray(deps, (await reservation(code)).id, stray, minutes(4));
  expect(refund).not.toHaveBeenCalled();
  expect(email.sent).toHaveLength(mails);
});

test("a definitive refund failure alerts staff under the refund row's id, so an earlier alert cannot swallow it", async () => {
  const { db, deps, email, book, reservation, notice } = await bookingSetup({ failRefund: true });
  const code = await book();
  const res = await reservation(code);
  // Another payment alert for this booking, sent earlier with the default (empty) ref.
  await notifyStaff(deps, res.id, "staff_payment_alert", minutes(1));
  email.sent.length = 0;

  await handlePaymentNotice(deps, await notice(code, { amount: PAY_NOW - 1 }), minutes(2)); // AMOUNT_MISMATCH → refund fails
  expect((await reservation(code)).lastSyncError).toContain("REFUND_FAILED");
  const [refundRow] = await db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund")));
  expect(refundRow.status).toBe("failed");
  const alerts = await db.select().from(notifications)
    .where(and(eq(notifications.reservationId, res.id), eq(notifications.kind, "staff_payment_alert")));
  expect(alerts.map((a) => a.ref).sort()).toEqual(["", refundRow.id].sort());
  expect(email.sent.filter((e) => e.to === STAFF && e.subject.includes("付款異常"))).toHaveLength(1);
});
