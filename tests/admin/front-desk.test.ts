import { and, eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import type { StaffContext } from "@/lib/admin/auth";
import { balanceDueOf, recordFrontDeskPayment, voidFrontDeskPayment } from "@/lib/admin/front-desk";
import { reconcileRefund } from "@/lib/admin/reconcile";
import { staffCancel, staffCancelPreview } from "@/lib/admin/staff-cancel";
import { cancelReservation, findReservation } from "@/lib/booking/manage";
import { emailContext, onlineNetAmount, receivedAmount } from "@/lib/booking/notify";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { toChannelReservation } from "@/lib/booking/to-channel";
import { auditLog, payments, ratePlans, reservations, staff } from "@/lib/db/schema";
import { fillAri } from "@/tests/helpers/ari";
import { BASE, bookingSetup, minutes, STAFF } from "@/tests/helpers/booking";

const TOTAL = 4960; // 2 nights × 2480
const DEPOSIT = 2480; // 50% paid online
const GUEST = "mei@example.com";
const EARLY = new Date("2026-12-06T16:00:00Z"); // 2026-12-07 Taipei: 3 days before → 100%
const HALF = new Date("2026-12-08T16:00:00Z"); // 2026-12-09 Taipei: 1 day before → 50%
const DAY = new Date("2026-12-01T03:00:00Z"); // 2026-12-01 11:00 Taipei
const SAME_DAY_LATER = new Date("2026-12-01T15:30:00Z"); // 2026-12-01 23:30 Taipei
const NEXT_DAY = new Date("2026-12-01T16:30:00Z"); // 2026-12-02 00:30 Taipei

/** A confirmed booking for 2026-12-10 → 12-12, total 4960, 2480 paid online (50% deposit), 2480 still due. */
async function depositBooking(o: { failRefund?: boolean } = {}) {
  const s = await bookingSetup(o);
  await fillAri(s.db, s.propertyId, "2026-12-10", 2, { available: 3, price: 2480 });
  await s.db.update(ratePlans).set({ paymentMode: "deposit", depositPct: 50 }).where(eq(ratePlans.id, s.ids.ratePlanId));
  const code = await s.book({ checkIn: "2026-12-10", checkOut: "2026-12-12" });
  await handlePaymentNotice(s.deps, await s.notice(code, { amount: DEPOSIT }), minutes(2));
  const res = await s.reservation(code);
  expect(res).toMatchObject({ status: "confirmed", totalAmount: TOTAL });
  const mk = async (role: "front_desk" | "manager" | "owner" | "marketing", propertyIds = [s.propertyId]): Promise<StaffContext> => {
    const row = { id: `s-${role}-${propertyIds.join()}`, email: `${role}@nk.test`, name: role, role, propertyIds, active: true };
    await s.db.insert(staff).values(row).onConflictDoNothing();
    return { staff: row, email: row.email };
  };
  const payment = async (id: string) => (await s.db.select().from(payments).where(eq(payments.id, id)))[0];
  const refunds = () => s.db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund")));
  const auditsOf = (entityId: string) => s.db.select().from(auditLog).where(eq(auditLog.entityId, entityId));
  return {
    ...s, code, id: res.id, mk, payment, refunds, auditsOf,
    frontDesk: await mk("front_desk"), manager: await mk("manager"),
    balance: () => balanceDueOf(s.db, res.id),
  };
}

const cash = (amount: number, note?: string) => ({ method: "cash" as const, amount, ...(note ? { note } : {}) });

test("the amount must be a positive whole number", async () => {
  const { db, frontDesk, id, balance } = await depositBooking();
  for (const amount of [-100, 0, 1.5, Number.NaN])
    expect(await recordFrontDeskPayment(db, frontDesk, id, cash(amount), DAY)).toEqual({ ok: false, error: "INVALID_AMOUNT" });
  expect(await balance()).toBe(DEPOSIT);
});

test("taking more than the balance due is OVERPAY", async () => {
  const { db, frontDesk, id, balance } = await depositBooking();
  expect(await recordFrontDeskPayment(db, frontDesk, id, cash(DEPOSIT + 1), DAY)).toEqual({ ok: false, error: "OVERPAY" });
  expect(await balance()).toBe(DEPOSIT);
});

test("a card-terminal payment needs four digits and the authorisation code", async () => {
  const { db, frontDesk, id } = await depositBooking();
  const edc = (o: { last4?: string; authCode?: string }) => ({ method: "edc" as const, amount: 1000, ...o });
  expect(await recordFrontDeskPayment(db, frontDesk, id, edc({ authCode: "A1B2C3" }), DAY)).toEqual({ ok: false, error: "INVALID_LAST4" });
  expect(await recordFrontDeskPayment(db, frontDesk, id, edc({ last4: "12a4", authCode: "A1B2C3" }), DAY)).toEqual({ ok: false, error: "INVALID_LAST4" });
  expect(await recordFrontDeskPayment(db, frontDesk, id, edc({ last4: "12345", authCode: "A1B2C3" }), DAY)).toEqual({ ok: false, error: "INVALID_LAST4" });
  expect(await recordFrontDeskPayment(db, frontDesk, id, edc({ last4: "1234" }), DAY)).toEqual({ ok: false, error: "AUTH_CODE_REQUIRED" });
  expect(await recordFrontDeskPayment(db, frontDesk, id, { method: "cash", amount: 1000, last4: "12a4" }, DAY))
    .toEqual({ ok: false, error: "INVALID_LAST4" });
});

test("recording a payment lowers the balance due and is audited in the same batch", async () => {
  const { db, frontDesk, id, balance, payment, auditsOf } = await depositBooking();
  const r = await recordFrontDeskPayment(db, frontDesk, id, cash(1000, "  找零 0  "), DAY);
  expect(r).toEqual({ ok: true, paymentId: expect.any(String), balanceDue: DEPOSIT - 1000 });
  if (!r.ok) return;
  expect(await payment(r.paymentId)).toMatchObject({
    reservationId: id, kind: "front_desk", method: "cash", amount: 1000, status: "succeeded", note: "找零 0", createdAt: DAY.getTime(),
  });
  expect(await auditsOf(r.paymentId)).toMatchObject([{
    action: "payment.front_desk", entity: "payment", staffEmail: frontDesk.email,
    after: { reservationId: id, method: "cash", amount: 1000, balanceDue: DEPOSIT - 1000 },
  }]);

  const card = await recordFrontDeskPayment(db, frontDesk, id, { method: "edc", amount: DEPOSIT - 1000, last4: "4242", authCode: "A1B2C3" }, DAY);
  expect(card).toMatchObject({ ok: true, balanceDue: 0 });
  if (card.ok) expect(await payment(card.paymentId)).toMatchObject({ method: "edc", last4: "4242", authCode: "A1B2C3" });
  expect(await balance()).toBe(0);
  expect(await recordFrontDeskPayment(db, frontDesk, id, cash(1), DAY)).toEqual({ ok: false, error: "OVERPAY" });
});

test("two desks taking the whole balance at once: only one is recorded", async () => {
  const { db, frontDesk, manager, id, balance } = await depositBooking();
  const [a, b] = await Promise.all([
    recordFrontDeskPayment(db, frontDesk, id, cash(DEPOSIT), DAY),
    recordFrontDeskPayment(db, manager, id, { method: "transfer", amount: DEPOSIT }, DAY),
  ]);
  expect([a, b].filter((r) => r.ok)).toHaveLength(1);
  expect([a, b].filter((r) => !r.ok)).toEqual([{ ok: false, error: "OVERPAY" }]);
  expect(await balance()).toBe(0);
  expect(await db.select().from(auditLog).where(eq(auditLog.action, "payment.front_desk"))).toHaveLength(1);
});

test("who may record: marketing is FORBIDDEN, another property's booking is NOT_FOUND, a closed booking is NOT_PAYABLE", async () => {
  const { db, deps, mk, frontDesk, id, code } = await depositBooking();
  expect(await recordFrontDeskPayment(db, await mk("marketing"), id, cash(100), DAY)).toEqual({ ok: false, error: "FORBIDDEN" });
  expect(await recordFrontDeskPayment(db, await mk("manager", ["prop-other"]), id, cash(100), DAY)).toEqual({ ok: false, error: "NOT_FOUND" });
  expect(await recordFrontDeskPayment(db, frontDesk, "no-such-id", cash(100), DAY)).toEqual({ ok: false, error: "NOT_FOUND" });
  expect(await cancelReservation(deps, code, GUEST, HALF)).toMatchObject({ ok: true });
  expect(await recordFrontDeskPayment(db, frontDesk, id, cash(100), HALF)).toEqual({ ok: false, error: "NOT_PAYABLE" });
});

test("voiding: front desk is FORBIDDEN; a manager voids a same-day payment, which restores the balance", async () => {
  const { db, frontDesk, manager, mk, id, balance, payment, auditsOf } = await depositBooking();
  const r = await recordFrontDeskPayment(db, frontDesk, id, cash(1000), DAY);
  if (!r.ok) throw new Error(r.error);
  expect(await voidFrontDeskPayment(db, frontDesk, r.paymentId, "收錯金額", SAME_DAY_LATER)).toEqual({ ok: false, error: "FORBIDDEN" });
  expect(await voidFrontDeskPayment(db, await mk("manager", ["prop-other"]), r.paymentId, "收錯金額", SAME_DAY_LATER))
    .toEqual({ ok: false, error: "NOT_FOUND" });
  expect(await voidFrontDeskPayment(db, manager, r.paymentId, "  ", SAME_DAY_LATER)).toEqual({ ok: false, error: "REASON_REQUIRED" });

  expect(await voidFrontDeskPayment(db, manager, r.paymentId, "收錯金額", SAME_DAY_LATER)).toEqual({ ok: true, balanceDue: DEPOSIT });
  expect(await payment(r.paymentId)).toMatchObject({ status: "failed", amount: 1000 }); // kept, not deleted
  expect(await balance()).toBe(DEPOSIT);
  expect((await auditsOf(r.paymentId)).map((a) => a.action)).toEqual(["payment.front_desk", "payment.void"]);
  expect((await auditsOf(r.paymentId))[1]).toMatchObject({
    staffEmail: manager.email, before: { status: "succeeded" }, after: { status: "failed", reason: "收錯金額" },
  });
  expect(await voidFrontDeskPayment(db, manager, r.paymentId, "再一次", SAME_DAY_LATER)).toEqual({ ok: false, error: "ALREADY_VOIDED" });
});

test("only a payment taken today (Taipei) can be voided, and only a front-desk one", async () => {
  const { db, frontDesk, mk, id, payment, refunds, deps, code } = await depositBooking();
  const owner = await mk("owner");
  const r = await recordFrontDeskPayment(db, frontDesk, id, cash(1000), DAY);
  if (!r.ok) throw new Error(r.error);
  expect(await voidFrontDeskPayment(db, owner, r.paymentId, "隔天才發現", NEXT_DAY)).toEqual({ ok: false, error: "NOT_SAME_DAY" });
  expect((await payment(r.paymentId)).status).toBe("succeeded");
  const [charge] = await db.select().from(payments).where(and(eq(payments.reservationId, id), eq(payments.kind, "charge")));
  expect(await voidFrontDeskPayment(db, owner, charge.id, "不行", NEXT_DAY)).toEqual({ ok: false, error: "NOT_FOUND" });
  expect(await cancelReservation(deps, code, GUEST, HALF)).toMatchObject({ ok: true });
  expect(await voidFrontDeskPayment(db, owner, (await refunds())[0].id, "不行", HALF)).toEqual({ ok: false, error: "NOT_FOUND" });
});

test("one money vocabulary: online net for the gateway, total received for emails, SiteMinder and the guest page", async () => {
  const { db, deps, frontDesk, id, code } = await depositBooking();
  await recordFrontDeskPayment(db, frontDesk, id, cash(1000), DAY);
  expect(await onlineNetAmount(db, id)).toBe(DEPOSIT);
  expect(await receivedAmount(db, id)).toBe(DEPOSIT + 1000);
  expect((await emailContext({ db, baseUrl: BASE }, id)).data.paid).toBe(DEPOSIT + 1000);
  expect((await toChannelReservation(db, id)).paidAmount).toBe(DEPOSIT + 1000);
  expect(await findReservation(db, code, GUEST, DAY)).toMatchObject({ paid: DEPOSIT + 1000 });
  void deps;
});

test("a guest cancel refunds the policy share of everything received: online part by the gateway, the rest due at the desk", async () => {
  const { db, deps, gateway, email, frontDesk, id, code, reservation, refunds } = await depositBooking();
  await recordFrontDeskPayment(db, frontDesk, id, cash(DEPOSIT), DAY);
  expect(await findReservation(db, code, GUEST, EARLY)).toMatchObject({ refundIfCancelledNow: TOTAL });
  const refund = vi.spyOn(gateway, "refund");

  expect(await cancelReservation(deps, code, GUEST, EARLY))
    .toEqual({ ok: true, refunded: DEPOSIT, frontDeskRefundDue: DEPOSIT, alreadyCancelled: false });
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ amount: DEPOSIT, idempotencyKey: `cancel:${id}` }));
  expect(await refunds()).toMatchObject([{ status: "succeeded", amount: DEPOSIT }]);
  expect(await reservation(code)).toMatchObject({ status: "cancelled", refundedAmount: DEPOSIT, frontDeskRefundDue: DEPOSIT });
  // Staff are alerted to hand the cash back; the guest's email says the rest comes from the desk.
  const alert = email.sent.find((e) => e.to === STAFF && e.subject.includes("付款異常"));
  expect(alert?.text).toContain("需由櫃檯退款：NT$2,480");
  expect(email.sent.find((e) => e.to === GUEST && e.subject.includes("cancelled"))?.text).toContain("Returned at the front desk: NT$2,480");
  // Asking again reports the same split.
  expect(await cancelReservation(deps, code, GUEST, EARLY))
    .toEqual({ ok: true, refunded: DEPOSIT, frontDeskRefundDue: DEPOSIT, alreadyCancelled: true });
});

test("when the policy refund fits in the online money, it all goes back through the gateway", async () => {
  const { db, deps, frontDesk, id, code, reservation } = await depositBooking();
  await recordFrontDeskPayment(db, frontDesk, id, cash(DEPOSIT), DAY);
  // 50% of 4960 received = 2480 = the online net: nothing for the desk to hand back.
  expect(await staffCancel(deps, frontDesk, id, { reason: "旅客來電", notifyGuest: true }, HALF))
    .toEqual({ ok: true, refunded: DEPOSIT, alreadyCancelled: false });
  expect(await reservation(code)).toMatchObject({ status: "cancelled", refundedAmount: DEPOSIT, frontDeskRefundDue: 0 });
});

test("a staff cancel reports the desk's share, audits it, and an override may cover everything received", async () => {
  const { db, deps, gateway, frontDesk, manager, id, code, reservation, auditsOf } = await depositBooking();
  await recordFrontDeskPayment(db, frontDesk, id, cash(DEPOSIT), DAY);
  expect(await staffCancelPreview(db, id, HALF)).toEqual({ refund: DEPOSIT, frontDeskRefundDue: 0, maxOverride: TOTAL });
  expect(await staffCancel(deps, manager, id, { reason: "x", notifyGuest: false, refundOverride: TOTAL + 1 }, HALF))
    .toEqual({ ok: false, error: "OVERRIDE_EXCEEDS_PAID" });
  const refund = vi.spyOn(gateway, "refund");

  expect(await staffCancel(deps, manager, id, { reason: "颱風", notifyGuest: false, refundOverride: 4000 }, HALF))
    .toEqual({ ok: true, refunded: DEPOSIT, frontDeskRefundDue: 4000 - DEPOSIT, alreadyCancelled: false });
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ amount: DEPOSIT }));
  expect(await reservation(code)).toMatchObject({ status: "cancelled", refundedAmount: DEPOSIT, frontDeskRefundDue: 4000 - DEPOSIT });
  const [audit] = (await auditsOf(id)).filter((a) => a.action === "reservation.cancel");
  expect(audit.after).toMatchObject({ refundOverride: 4000, refunded: DEPOSIT, frontDeskRefundDue: 4000 - DEPOSIT });
});

test("the desk's share is fixed with the refund intent: a retry after a failed refund reports the same split", async () => {
  const { db, deps, gateway, frontDesk, manager, id, code, reservation } = await depositBooking({ failRefund: true });
  await recordFrontDeskPayment(db, frontDesk, id, cash(DEPOSIT), DAY);
  expect(await staffCancel(deps, manager, id, { reason: "a", notifyGuest: false, refundOverride: 3000 }, HALF))
    .toEqual({ ok: false, error: "REFUND_FAILED" });
  vi.spyOn(gateway, "refund").mockResolvedValueOnce({ ok: true, refundRef: "R-2" });
  // The retry by the rules would give 2480 back, all online; the intent from the override fixes 2480 online + 520 at the desk.
  expect(await cancelReservation(deps, code, GUEST, HALF))
    .toEqual({ ok: true, refunded: DEPOSIT, frontDeskRefundDue: 3000 - DEPOSIT, alreadyCancelled: false });
  expect(await reservation(code)).toMatchObject({ status: "cancelled", frontDeskRefundDue: 3000 - DEPOSIT });
  void db;
});

test("reconciling a lost cancel refund completes the cancellation with the desk's share it was planned with", async () => {
  const { db, deps, gateway, email, frontDesk, manager, id, code, reservation, refunds } = await depositBooking();
  await recordFrontDeskPayment(db, frontDesk, id, cash(DEPOSIT), DAY);
  const real = gateway.refund.bind(gateway);
  vi.spyOn(gateway, "refund").mockImplementationOnce(async (r) => { await real(r); throw new Error("connection reset"); });
  expect(await cancelReservation(deps, code, GUEST, EARLY)).toEqual({ ok: false, error: "REFUND_FAILED" });
  const [row] = await refunds();
  expect(row).toMatchObject({ status: "pending", amount: DEPOSIT });
  expect(await reservation(code)).toMatchObject({ status: "confirmed", frontDeskRefundDue: DEPOSIT });

  expect(await reconcileRefund(deps, manager, row.id, { kind: "mark_succeeded", providerRef: "BANK-1" }, HALF))
    .toMatchObject({ ok: true, completed: "cancellation", reservationStatus: "cancelled" });
  expect(await reservation(code)).toMatchObject({ status: "cancelled", refundedAmount: DEPOSIT, frontDeskRefundDue: DEPOSIT });
  expect(email.sent.filter((e) => e.to === STAFF && e.text.includes("需由櫃檯退款：NT$2,480"))).not.toHaveLength(0);
});

// ── Fix round 1 ──────────────────────────────────────────────────────────────

test("no desk money moves while a cancellation claim is held", async () => {
  const { db, frontDesk, manager, id, balance } = await depositBooking();
  const r = await recordFrontDeskPayment(db, frontDesk, id, cash(1000), DAY);
  if (!r.ok) throw new Error(r.error);
  await db.update(reservations).set({ cancelledAt: DAY.getTime() }).where(eq(reservations.id, id)); // a cancel just claimed it
  expect(await recordFrontDeskPayment(db, frontDesk, id, cash(100), DAY)).toEqual({ ok: false, error: "CANCEL_IN_PROGRESS" });
  expect(await voidFrontDeskPayment(db, manager, r.paymentId, "收錯", DAY)).toEqual({ ok: false, error: "CANCEL_IN_PROGRESS" });
  expect(await balance()).toBe(DEPOSIT - 1000);
});

test("no desk money moves while a cancel refund row exists, even after its claim was dropped", async () => {
  const { db, deps, frontDesk, manager, id, code, reservation, refunds } = await depositBooking({ failRefund: true });
  const r = await recordFrontDeskPayment(db, frontDesk, id, cash(1000), DAY);
  if (!r.ok) throw new Error(r.error);
  expect(await cancelReservation(deps, code, GUEST, EARLY)).toEqual({ ok: false, error: "REFUND_FAILED" });
  expect(await reservation(code)).toMatchObject({ status: "confirmed", cancelledAt: null }); // claim dropped
  expect(await refunds()).toMatchObject([{ status: "failed", idempotencyKey: `cancel:${id}` }]); // intent stays
  expect(await recordFrontDeskPayment(db, frontDesk, id, cash(100), EARLY)).toEqual({ ok: false, error: "CANCEL_IN_PROGRESS" });
  expect(await voidFrontDeskPayment(db, manager, r.paymentId, "收錯", DAY)).toEqual({ ok: false, error: "CANCEL_IN_PROGRESS" });
});

test("a cancelled booking's desk payment is NOT_VOIDABLE and stays in the desk's refund", async () => {
  const { db, deps, frontDesk, manager, id, code, reservation, payment } = await depositBooking();
  const r = await recordFrontDeskPayment(db, frontDesk, id, cash(DEPOSIT), DAY);
  if (!r.ok) throw new Error(r.error);
  expect(await cancelReservation(deps, code, GUEST, DAY)).toMatchObject({ ok: true, frontDeskRefundDue: DEPOSIT });
  expect(await voidFrontDeskPayment(db, manager, r.paymentId, "收錯", DAY)).toEqual({ ok: false, error: "NOT_VOIDABLE" });
  expect((await payment(r.paymentId)).status).toBe("succeeded");
  expect(await reservation(code)).toMatchObject({ frontDeskRefundDue: DEPOSIT });
});

/** After a cancel at 100%, every dollar held must be accounted for: refunded online or due at the desk. */
async function expectNoOrphanedMoney(s: Awaited<ReturnType<typeof depositBooking>>) {
  const res = await s.reservation(s.code);
  expect(res.status).toBe("cancelled");
  const held = await receivedAmount(s.db, s.id) + res.refundedAmount; // received is net of the online refund
  expect(res.refundedAmount + res.frontDeskRefundDue).toBe(held);
}

test.each([["record first", true], ["cancel first", false]])("record racing a cancel (%s): refused, or included in the split", async (_, recordFirst) => {
  const s = await depositBooking();
  const record = () => recordFrontDeskPayment(s.db, s.frontDesk, s.id, cash(1000), EARLY);
  const cancel = () => cancelReservation(s.deps, s.code, GUEST, EARLY);
  const [rec, can] = recordFirst ? await Promise.all([record(), cancel()]) : (await Promise.all([cancel(), record()])).reverse() as [
    Awaited<ReturnType<typeof record>>, Awaited<ReturnType<typeof cancel>>];
  expect(can).toMatchObject({ ok: true });
  if (!rec.ok) expect(["CANCEL_IN_PROGRESS", "NOT_PAYABLE"]).toContain(rec.error);
  else expect(await s.reservation(s.code)).toMatchObject({ frontDeskRefundDue: 1000 });
  await expectNoOrphanedMoney(s);
});

test.each([["void first", true], ["cancel first", false]])("void racing a cancel (%s): refused, or left out of the split", async (_, voidFirst) => {
  const s = await depositBooking();
  const p = await recordFrontDeskPayment(s.db, s.frontDesk, s.id, cash(1000), DAY);
  if (!p.ok) throw new Error(p.error);
  const doVoid = () => voidFrontDeskPayment(s.db, s.manager, p.paymentId, "收錯", DAY);
  const cancel = () => cancelReservation(s.deps, s.code, GUEST, DAY);
  const [v, can] = voidFirst ? await Promise.all([doVoid(), cancel()]) : (await Promise.all([cancel(), doVoid()])).reverse() as [
    Awaited<ReturnType<typeof doVoid>>, Awaited<ReturnType<typeof cancel>>];
  expect(can).toMatchObject({ ok: true });
  const status = (await s.payment(p.paymentId)).status;
  if (v.ok) expect(status).toBe("failed");
  else { expect(["CANCEL_IN_PROGRESS", "NOT_VOIDABLE"]).toContain(v.error); expect(status).toBe("succeeded"); }
  await expectNoOrphanedMoney(s);
});

test("a guest cancel with a desk refund due is audited under the system actor", async () => {
  const { db, deps, frontDesk, id, code, auditsOf } = await depositBooking();
  await recordFrontDeskPayment(db, frontDesk, id, cash(DEPOSIT), DAY);
  await cancelReservation(deps, code, GUEST, EARLY);
  expect((await auditsOf(id)).filter((a) => a.action === "cancel.front_desk_refund_due")).toMatchObject([{
    staffEmail: "system:guest", entity: "reservation", after: { refunded: DEPOSIT, frontDeskRefundDue: DEPOSIT },
  }]);
  // No desk share, no row.
  const b = await depositBooking();
  await cancelReservation(b.deps, b.code, GUEST, EARLY);
  expect((await b.auditsOf(b.id)).filter((a) => a.action === "cancel.front_desk_refund_due")).toEqual([]);
});

test("the auth code and the note may not carry a card number; the auth code is 1–12 letters or digits", async () => {
  const { db, frontDesk, id, balance } = await depositBooking();
  const edc = (authCode: string, note?: string) => ({ method: "edc" as const, amount: 100, last4: "4242", authCode, ...(note ? { note } : {}) });
  expect(await recordFrontDeskPayment(db, frontDesk, id, edc("4111111111111111"), DAY)).toEqual({ ok: false, error: "LOOKS_LIKE_CARD_NUMBER" });
  expect(await recordFrontDeskPayment(db, frontDesk, id, edc("A1B2C3", "卡號 4111-1111-1111-1111"), DAY))
    .toEqual({ ok: false, error: "LOOKS_LIKE_CARD_NUMBER" });
  expect(await recordFrontDeskPayment(db, frontDesk, id, cash(100, "4111 1111 1111 1"), DAY)).toEqual({ ok: false, error: "LOOKS_LIKE_CARD_NUMBER" });
  expect(await recordFrontDeskPayment(db, frontDesk, id, edc("ABC-123"), DAY)).toEqual({ ok: false, error: "INVALID_AUTH_CODE" });
  expect(await recordFrontDeskPayment(db, frontDesk, id, edc("ABCDEFGHIJKLM"), DAY)).toEqual({ ok: false, error: "INVALID_AUTH_CODE" });
  expect(await balance()).toBe(DEPOSIT);
  // A 12-digit transfer reference is fine.
  expect(await recordFrontDeskPayment(db, frontDesk, id, cash(100, "匯款帳號末碼 123456789012"), DAY)).toMatchObject({ ok: true });
  expect(await recordFrontDeskPayment(db, frontDesk, id, edc("ABCDEF123456"), DAY)).toMatchObject({ ok: true });
});

test("a payment or void attempted while the cancel's refund is at the gateway is refused, and the split still holds", async () => {
  const s = await depositBooking();
  const p = await recordFrontDeskPayment(s.db, s.frontDesk, s.id, cash(1000), DAY);
  if (!p.ok) throw new Error(p.error);
  const real = s.gateway.refund.bind(s.gateway);
  const during: unknown[] = [];
  vi.spyOn(s.gateway, "refund").mockImplementationOnce(async (r) => {
    // The claim is taken and the split stored; the booking is still `confirmed`.
    during.push(await recordFrontDeskPayment(s.db, s.frontDesk, s.id, cash(500), DAY));
    during.push(await voidFrontDeskPayment(s.db, s.manager, p.paymentId, "收錯", DAY));
    return real(r);
  });
  expect(await cancelReservation(s.deps, s.code, GUEST, DAY)).toMatchObject({ ok: true, refunded: DEPOSIT, frontDeskRefundDue: 1000 });
  expect(during).toEqual([{ ok: false, error: "CANCEL_IN_PROGRESS" }, { ok: false, error: "CANCEL_IN_PROGRESS" }]);
  expect((await s.payment(p.paymentId)).status).toBe("succeeded");
  await expectNoOrphanedMoney(s);
});
