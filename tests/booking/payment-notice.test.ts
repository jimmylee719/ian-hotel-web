import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { sendOnce } from "@/lib/booking/notify";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { MockChannelManager } from "@/lib/channel/mock";
import { addons, notifications, paymentEvents, payments, promoCodes } from "@/lib/db/schema";
import { bookingSetup, minutes, NOW, PAY_NOW, STAFF } from "@/tests/helpers/booking";

test("a paid notice confirms the booking, pushes it to the channel and emails guest and staff", async () => {
  const { db, deps, channel, email, book, reservation, notice } = await bookingSetup();
  const code = await book();
  const r = await handlePaymentNotice(deps, await notice(code, { authCode: "A1", last4: "4242" }), minutes(2));
  expect(r).toEqual({ status: 200, verdict: "accepted" });

  const res = await reservation(code);
  expect(res.status).toBe("confirmed");
  expect(res.syncState).toBe("synced");
  expect(res.smConfirmation).toMatch(/^SM-1-/);

  expect(channel.pushed).toHaveLength(1);
  expect(channel.pushed[0]).toMatchObject({ code, paidAmount: PAY_NOW, total: PAY_NOW, checkIn: "2026-12-01", checkOut: "2026-12-03" });
  expect(channel.pushed[0].rooms).toEqual([{ smRoomCode: "", smRatePlanCode: "", nightlyPrices: [2000, 2000] }]);

  expect(email.sent.map((e) => e.to).sort()).toEqual(["mei@example.com", STAFF]);
  expect(email.sent.find((e) => e.to === "mei@example.com")!.subject).toContain("Booking confirmed");

  const pays = await db.select().from(payments).where(eq(payments.reservationId, res.id));
  expect(pays).toMatchObject([{ kind: "charge", status: "succeeded", amount: PAY_NOW, providerRef: `REF-${code}`, authCode: "A1", last4: "4242" }]);
  expect(await db.select().from(paymentEvents)).toMatchObject([{ verdict: "accepted", reservationCode: code, providerRef: `REF-${code}` }]);
});

test("the same notice twice is a duplicate: one push, two emails", async () => {
  const { deps, channel, email, book, notice } = await bookingSetup();
  const code = await book();
  const n = await notice(code);
  await handlePaymentNotice(deps, n, minutes(2));
  expect(await handlePaymentNotice(deps, n, minutes(3))).toEqual({ status: 200, verdict: "duplicate" });
  expect(channel.pushed).toHaveLength(1);
  expect(email.sent).toHaveLength(2);
});

test("concurrent duplicate notices confirm once", async () => {
  const { deps, channel, email, book, reservation, notice } = await bookingSetup();
  const code = await book();
  const n = await notice(code);
  const rs = await Promise.all([handlePaymentNotice(deps, n, minutes(2)), handlePaymentNotice(deps, n, minutes(2))]);
  expect(rs.map((r) => r.verdict).sort()).toEqual(["accepted", "duplicate"]);
  expect((await reservation(code)).status).toBe("confirmed");
  expect(channel.pushed).toHaveLength(1);
  expect(email.sent).toHaveLength(2);
});

test("a tampered signature is rejected with 400 and changes nothing", async () => {
  const { db, deps, book, reservation, notice } = await bookingSetup();
  const code = await book();
  const n = await notice(code);
  const tampered = { ...n, body: n.body.replace(`"amount":${PAY_NOW}`, `"amount":1`) };
  expect(await handlePaymentNotice(deps, tampered, minutes(2))).toEqual({ status: 400, verdict: "bad_signature" });
  expect((await reservation(code)).status).toBe("pending_payment");
  expect(await db.select().from(paymentEvents)).toMatchObject([{ verdict: "bad_signature", propertyId: null }]);
});

test("an unknown reservation is logged and answered with 200", async () => {
  const { db, deps, notice } = await bookingSetup();
  expect(await handlePaymentNotice(deps, await notice("NK-ZZZZZZ"), NOW)).toEqual({ status: 200, verdict: "unknown_reservation" });
  expect(await db.select().from(paymentEvents)).toMatchObject([{ verdict: "unknown_reservation", reservationCode: "NK-ZZZZZZ" }]);
});

test("a failed payment keeps the reservation payable", async () => {
  const { db, deps, channel, book, reservation, notice } = await bookingSetup();
  const code = await book();
  expect(await handlePaymentNotice(deps, await notice(code, { status: "failed", providerRef: "REF-F1" }), minutes(2)))
    .toEqual({ status: 200, verdict: "accepted" });
  const res = await reservation(code);
  expect(res.status).toBe("pending_payment");
  expect(channel.pushed).toHaveLength(0);
  expect(await db.select().from(payments).where(eq(payments.providerRef, "REF-F1"))).toMatchObject([{ status: "failed" }]);

  // The guest pays again with a new transaction.
  expect(await handlePaymentNotice(deps, await notice(code, { providerRef: "REF-OK" }), minutes(4))).toEqual({ status: 200, verdict: "accepted" });
  expect((await reservation(code)).status).toBe("confirmed");
  expect(channel.pushed[0].paidAmount).toBe(PAY_NOW);
});

test("an amount one dollar short is refunded in full and staff are alerted", async () => {
  const { db, deps, gateway, channel, email, book, reservation, notice, avail } = await bookingSetup();
  const refund = vi.spyOn(gateway, "refund");
  const code = await book();
  expect(await handlePaymentNotice(deps, await notice(code, { amount: PAY_NOW - 1 }), minutes(2)))
    .toEqual({ status: 200, verdict: "amount_mismatch" });

  const res = await reservation(code);
  expect(res.status).toBe("confirm_failed_refunded");
  expect(res.refundedAmount).toBe(PAY_NOW - 1);
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ providerRef: `REF-${code}`, amount: PAY_NOW - 1 }));
  expect(channel.pushed).toHaveLength(0);
  expect(await avail()).toBe(3);
  // The guest is told too (Plan 2 deferred item, done in Plan 3 Task 5).
  expect(email.sent.map((e) => e.to)).toEqual(["mei@example.com", STAFF]);
  expect(email.sent[1].subject).toContain("付款異常");
  const refunds = await db.select().from(payments).where(eq(payments.kind, "refund"));
  expect(refunds).toMatchObject([{ amount: PAY_NOW - 1, status: "succeeded", reservationId: res.id }]);
});

test("a non-retryable channel failure refunds, releases inventory and apologises", async () => {
  const { deps, gateway, email, book, reservation, notice, avail } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 1, retryable: false }),
  });
  const refund = vi.spyOn(gateway, "refund");
  const code = await book();
  expect(await avail()).toBe(2);
  await handlePaymentNotice(deps, await notice(code), minutes(2));

  const res = await reservation(code);
  expect(res.status).toBe("confirm_failed_refunded");
  expect(res.syncState).toBe("pending"); // the retry job checks the channel never kept it
  expect(res.refundedAmount).toBe(PAY_NOW);
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ providerRef: `REF-${code}`, amount: PAY_NOW }));
  expect(await avail()).toBe(3);
  const guestMail = email.sent.find((e) => e.to === "mei@example.com")!;
  expect(guestMail.subject).toContain("could not complete");
  expect(guestMail.text).toContain("NT$4,000");
  expect(email.sent.find((e) => e.to === STAFF)!.subject).toContain("通路同步失敗");
});

test("when the refund itself fails, the reservation is left for staff and never marked refunded", async () => {
  const { db, deps, email, book, reservation, notice, avail } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 1, retryable: false }),
    failRefund: true,
  });
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(2));

  const res = await reservation(code);
  expect(res.status).toBe("paid_pending_confirm");
  expect(res.syncState).toBe("failed");
  expect(res.refundedAmount).toBe(0);
  expect(res.lastSyncError).toContain("MOCK_REFUND_FAILED");
  expect(await avail()).toBe(2);
  // The refund intent is kept, marked failed; no money moved.
  expect(await db.select().from(payments).where(eq(payments.kind, "refund"))).toMatchObject([{ status: "failed", providerRef: null }]);
  expect(email.sent.map((e) => [e.to, e.subject.includes("付款異常")])).toEqual([[STAFF, true]]);
});

test("a promo code's use is counted once the booking is confirmed", async () => {
  const { db, propertyId, deps, book, notice } = await bookingSetup();
  await db.insert(promoCodes).values({ id: "p1", propertyId, code: "WELCOME10", kind: "percent", value: 10, active: true });
  const code = await book({ promoCode: "WELCOME10" });
  expect((await db.select().from(promoCodes))[0].usedCount).toBe(0);
  const n = await notice(code, { amount: 3600 });
  await handlePaymentNotice(deps, n, minutes(2));
  await handlePaymentNotice(deps, n, minutes(3));
  expect((await db.select().from(promoCodes))[0].usedCount).toBe(1);
});

test("the channel sees add-ons and the promo code", async () => {
  const { db, propertyId, deps, channel, book, notice } = await bookingSetup();
  await db.insert(addons).values({
    id: "a1", propertyId, slug: "breakfast", name: { "zh-TW": "早餐", en: "Breakfast", ja: "Breakfast", ko: "Breakfast" },
    price: 250, unit: "per_person_night", active: true,
  });
  await db.insert(promoCodes).values({ id: "p1", propertyId, code: "TENOFF", kind: "fixed", value: 100, active: true });
  const code = await book({ addons: [{ slug: "breakfast", qty: 1 }], promoCode: "TENOFF" });
  // rooms 4000 - 100 + breakfast 250 × 2 adults × 2 nights
  await handlePaymentNotice(deps, await notice(code, { amount: 4900 }), minutes(2));
  expect(channel.pushed[0]).toMatchObject({ total: 4900, paidAmount: 4900, promoCode: "TENOFF", addons: [{ name: "早餐", amount: 1000 }] });
});

test("sendOnce sends a given email to a given address only once", async () => {
  const { db, deps, email, book, reservation } = await bookingSetup();
  const res = await reservation(await book());
  const mail = { to: "x@example.com", subject: "s", html: "h", text: "t" };
  await sendOnce(deps, res.id, "pre_arrival", "x@example.com", mail, NOW);
  await sendOnce(deps, res.id, "pre_arrival", "x@example.com", mail, NOW);
  expect(email.sent).toHaveLength(1);
  expect(await db.select().from(notifications)).toMatchObject([{ status: "sent", providerId: "mock-1" }]);
});

test("sendOnce records a failed send without throwing", async () => {
  const { db, deps, email, book, reservation } = await bookingSetup();
  const res = await reservation(await book());
  vi.spyOn(email, "send").mockRejectedValueOnce(new Error("boom"));
  await sendOnce(deps, res.id, "pre_arrival", "x@example.com", { to: "x@example.com", subject: "s", html: "h", text: "t" }, NOW);
  expect(await db.select().from(notifications)).toMatchObject([{ status: "failed" }]);
});
