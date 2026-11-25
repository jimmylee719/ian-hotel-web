import { and, eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import type { StaffContext } from "@/lib/admin/auth";
import { listPendingRefunds, reconcileRefund } from "@/lib/admin/reconcile";
import { moneyOf } from "@/lib/admin/money-metrics";
import { cancelReservation, findReservation } from "@/lib/booking/manage";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { auditLog, inventoryDaily, notifications, payments, reservations, staff } from "@/lib/db/schema";
import { fillAri } from "@/tests/helpers/ari";
import { bookingSetup, minutes, PAY_NOW } from "@/tests/helpers/booking";
import { AT, ONE_NIGHT, tenK } from "@/tests/helpers/money";

const PAID = 4960;
const GUEST = "mei@example.com";
const EARLY = new Date("2026-12-06T16:00:00Z"); // 3 days before check-in → 100%
const LATER = new Date(EARLY.getTime() + 24 * 3600_000);

async function setup(o: { failRefund?: boolean } = {}) {
  const s = await bookingSetup(o);
  await fillAri(s.db, s.propertyId, "2026-12-10", 2, { available: 3, price: 2480 });
  const mk = async (role: "front_desk" | "manager", propertyIds = [s.propertyId]): Promise<StaffContext> => {
    const row = { id: `s-${role}-${propertyIds.join()}`, email: `${role}@nk.test`, name: role, role, propertyIds, active: true };
    await s.db.insert(staff).values(row).onConflictDoNothing();
    return { staff: row, email: row.email };
  };
  const avail = async (date: string) =>
    (await s.db.select().from(inventoryDaily)
      .where(and(eq(inventoryDaily.unitTypeId, s.ids.unitTypeId), eq(inventoryDaily.date, date))))[0].available;
  const refundRows = (reservationId: string) =>
    s.db.select().from(payments).where(and(eq(payments.reservationId, reservationId), eq(payments.kind, "refund")));
  return { ...s, manager: await mk("manager"), frontDesk: await mk("front_desk"), mk, avail, refundRows };
}

/** A confirmed booking whose cancellation refund reached the gateway but whose outcome was lost (row stuck pending). */
async function stuckCancellation() {
  const s = await setup();
  const code = await s.book({ checkIn: "2026-12-10", checkOut: "2026-12-12" });
  await handlePaymentNotice(s.deps, await s.notice(code, { amount: PAID }), minutes(2));
  const real = s.gateway.refund.bind(s.gateway);
  vi.spyOn(s.gateway, "refund").mockImplementationOnce(async (r) => { await real(r); throw new Error("connection reset"); });
  expect(await cancelReservation(s.deps, code, GUEST, EARLY)).toEqual({ ok: false, error: "REFUND_FAILED" });
  const res = await s.reservation(code);
  const [row] = await s.refundRows(res.id);
  expect(row).toMatchObject({ status: "pending", amount: PAID, idempotencyKey: `cancel:${res.id}` });
  expect(res).toMatchObject({ status: "confirmed", cancelledAt: EARLY.getTime() });
  return { ...s, code, id: res.id, row };
}

test("pending refunds are listed per property with code, amount, time and key", async () => {
  const { db, propertyId, code, row } = await stuckCancellation();
  expect(await listPendingRefunds(db, propertyId)).toEqual([
    { id: row.id, reservationId: row.reservationId, code, amount: PAID, createdAt: row.createdAt, idempotencyKey: row.idempotencyKey },
  ]);
  expect(await listPendingRefunds(db, "prop-other")).toEqual([]);
});

test("mark_succeeded on a stuck cancellation refund finishes the cancellation; a second call changes nothing", async () => {
  const { db, deps, email, manager, code, id, row, reservation, avail, refundRows } = await stuckCancellation();
  expect(await avail("2026-12-10")).toBe(2);
  expect(await reconcileRefund(deps, manager, row.id, { kind: "mark_succeeded", providerRef: "BANK-123" }, LATER))
    .toEqual({ ok: true, status: "succeeded", completed: "cancellation", reservationStatus: "cancelled" });

  expect(await reservation(code)).toMatchObject({ status: "cancelled", refundedAmount: PAID, cancelledAt: EARLY.getTime() });
  expect(await refundRows(id)).toMatchObject([{ status: "succeeded", providerRef: "BANK-123", amount: PAID }]);
  expect(await avail("2026-12-10")).toBe(3);
  expect(email.sent.filter((e) => e.to === GUEST && e.subject.includes("cancelled"))).toHaveLength(1);
  expect(await db.select().from(auditLog).where(eq(auditLog.entityId, row.id)))
    .toMatchObject([{ action: "payment.reconcile", entity: "payment", staffEmail: manager.email, after: expect.objectContaining({ kind: "mark_succeeded" }) }]);

  expect(await reconcileRefund(deps, manager, row.id, { kind: "mark_succeeded", providerRef: "BANK-123" }, LATER))
    .toEqual({ ok: false, error: "ALREADY_RESOLVED" });
  expect((await reservation(code)).refundedAmount).toBe(PAID);
});

test("mark_failed only marks it failed; retry then calls the gateway with the same idempotency key", async () => {
  const { deps, gateway, manager, code, id, row, reservation, refundRows } = await stuckCancellation();
  const refund = vi.spyOn(gateway, "refund");
  refund.mockClear(); // forget the original attempt's call
  expect(await reconcileRefund(deps, manager, row.id, { kind: "mark_failed" }, LATER)).toEqual({ ok: true, status: "failed", completed: null, reservationStatus: "confirmed" });
  expect(await refundRows(id)).toMatchObject([{ status: "failed" }]);
  expect(refund).not.toHaveBeenCalled();
  expect(await reconcileRefund(deps, manager, row.id, { kind: "mark_failed" }, LATER)).toEqual({ ok: false, error: "ALREADY_RESOLVED" });

  expect(await reconcileRefund(deps, manager, row.id, { kind: "retry" }, LATER)).toEqual({ ok: true, status: "succeeded", completed: "cancellation", reservationStatus: "cancelled" });
  expect(refund).toHaveBeenCalledTimes(1);
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: `cancel:${id}`, amount: PAID }));
  expect(await reservation(code)).toMatchObject({ status: "cancelled", refundedAmount: PAID });
  expect(await reconcileRefund(deps, manager, row.id, { kind: "retry" }, LATER)).toEqual({ ok: false, error: "ALREADY_RESOLVED" });
  expect(refund).toHaveBeenCalledTimes(1);
  expect((await reservation(code)).refundedAmount).toBe(PAID);
});

/** A guest cancel whose refund the gateway refused: the intent row is failed and the claim was dropped (cancelledAt null). */
async function droppedClaim() {
  const s = await setup({ failRefund: true });
  const code = await s.book({ checkIn: "2026-12-10", checkOut: "2026-12-12" });
  await handlePaymentNotice(s.deps, await s.notice(code, { amount: PAID }), minutes(2));
  expect(await cancelReservation(s.deps, code, GUEST, EARLY)).toEqual({ ok: false, error: "REFUND_FAILED" });
  const res = await s.reservation(code);
  expect(res).toMatchObject({ status: "confirmed", cancelledAt: null });
  const [row] = await s.refundRows(res.id);
  expect(row.status).toBe("failed");
  return { ...s, code, id: res.id, row };
}

test("a successful retry of a cancel refund whose claim was dropped completes the cancellation at the refund's time", async () => {
  const s = await droppedClaim();
  const cancel = vi.spyOn(s.channel, "cancelReservation");
  const refund = vi.spyOn(s.gateway, "refund").mockResolvedValueOnce({ ok: true, refundRef: "R-RETRY" });
  expect(await s.avail("2026-12-10")).toBe(2);
  expect(await reconcileRefund(s.deps, s.manager, s.row.id, { kind: "retry" }, LATER))
    .toEqual({ ok: true, status: "succeeded", completed: "cancellation", reservationStatus: "cancelled" });
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: `cancel:${s.id}` }));
  expect(await s.reservation(s.code)).toMatchObject({ status: "cancelled", refundedAmount: PAID, cancelledAt: s.row.createdAt, syncState: "synced" });
  expect(cancel).toHaveBeenCalledWith(s.code);
  expect(await s.avail("2026-12-10")).toBe(3);
  expect(await s.avail("2026-12-11")).toBe(3);
  expect(s.email.sent.filter((e) => e.to === GUEST && e.subject.includes("cancelled"))).toHaveLength(1);

  expect(await reconcileRefund(s.deps, s.manager, s.row.id, { kind: "retry" }, LATER)).toEqual({ ok: false, error: "ALREADY_RESOLVED" });
  expect(await reconcileRefund(s.deps, s.manager, s.row.id, { kind: "mark_succeeded", providerRef: "X" }, LATER)).toEqual({ ok: false, error: "ALREADY_RESOLVED" });
  expect(refund).toHaveBeenCalledTimes(1);
  expect((await s.reservation(s.code)).refundedAmount).toBe(PAID);
});

test("mark_succeeded on a pending cancel refund whose claim is gone also completes the cancellation", async () => {
  const s = await stuckCancellation();
  await s.db.update(reservations).set({ cancelledAt: null }).where(eq(reservations.id, s.id)); // the claim was lost
  expect(await reconcileRefund(s.deps, s.manager, s.row.id, { kind: "mark_succeeded", providerRef: "BANK-7" }, LATER))
    .toEqual({ ok: true, status: "succeeded", completed: "cancellation", reservationStatus: "cancelled" });
  expect(await s.reservation(s.code)).toMatchObject({ status: "cancelled", refundedAmount: PAID, cancelledAt: s.row.createdAt });
  expect(await s.avail("2026-12-10")).toBe(3);
  expect(await reconcileRefund(s.deps, s.manager, s.row.id, { kind: "mark_succeeded", providerRef: "BANK-7" }, LATER))
    .toEqual({ ok: false, error: "ALREADY_RESOLVED" });
  expect((await s.reservation(s.code)).refundedAmount).toBe(PAID);
});

test("mark_succeeded inside the original request's lease still completes the cancellation", async () => {
  const s = await stuckCancellation();
  const soon = new Date(EARLY.getTime() + 30_000); // well within CANCEL_LEASE_MS of the claim
  expect(await reconcileRefund(s.deps, s.manager, s.row.id, { kind: "mark_succeeded", providerRef: "BANK-8" }, soon))
    .toEqual({ ok: true, status: "succeeded", completed: "cancellation", reservationStatus: "cancelled" });
  expect(await s.reservation(s.code)).toMatchObject({ status: "cancelled", refundedAmount: PAID, cancelledAt: EARLY.getTime() });
  expect(await s.avail("2026-12-10")).toBe(3);
});

test("settling a cancel refund on a booking that is no longer confirmed only reports its status", async () => {
  const s = await stuckCancellation();
  await s.db.update(reservations).set({ status: "cancelled" }).where(eq(reservations.id, s.id));
  expect(await reconcileRefund(s.deps, s.manager, s.row.id, { kind: "mark_succeeded", providerRef: "BANK-9" }, LATER))
    .toEqual({ ok: true, status: "succeeded", completed: null, reservationStatus: "cancelled" });
});

test("reconciling needs payments.reconcile and the payment's property", async () => {
  const { deps, frontDesk, mk, row, refundRows, id } = await stuckCancellation();
  expect(await reconcileRefund(deps, frontDesk, row.id, { kind: "mark_failed" }, LATER)).toEqual({ ok: false, error: "FORBIDDEN" });
  const elsewhere = await mk("manager", ["prop-other"]);
  expect(await reconcileRefund(deps, elsewhere, row.id, { kind: "mark_failed" }, LATER)).toEqual({ ok: false, error: "NOT_FOUND" });
  expect(await reconcileRefund(deps, elsewhere, "nope", { kind: "mark_failed" }, LATER)).toEqual({ ok: false, error: "NOT_FOUND" });
  expect(await refundRows(id)).toMatchObject([{ status: "pending" }]);
});

test("an amount mismatch refund emails the guest", async () => {
  const { deps, email, book, notice, reservation } = await setup();
  const code = await book();
  await handlePaymentNotice(deps, await notice(code, { amount: PAY_NOW - 1 }), minutes(2));
  expect((await reservation(code)).status).toBe("confirm_failed_refunded");
  const mail = email.sent.filter((e) => e.to === GUEST);
  expect(mail).toHaveLength(1);
  expect(mail[0].subject).toContain(code);
  expect(mail[0].text).toContain("NT$3,999");
});

test("mark_succeeded on a stuck fail: refund finishes the failed booking and emails the guest", async () => {
  const { db, deps, gateway, email, manager, book, notice, reservation, refundRows, avail } = await setup();
  const code = await book();
  vi.spyOn(gateway, "refund").mockRejectedValueOnce(new Error("timeout"));
  await handlePaymentNotice(deps, await notice(code, { amount: PAY_NOW - 1 }), minutes(2)); // AMOUNT_MISMATCH, refund outcome unknown
  const res = await reservation(code);
  expect(res).toMatchObject({ status: "paid_pending_confirm", syncState: "failed" });
  const [row] = await refundRows(res.id);
  expect(row.status).toBe("pending");
  expect(await avail("2026-12-01")).toBe(2);

  expect(await reconcileRefund(deps, manager, row.id, { kind: "mark_succeeded", providerRef: "BANK-9" }, minutes(60)))
    .toEqual({ ok: true, status: "succeeded", completed: "refund_and_fail", reservationStatus: "confirm_failed_refunded" });
  expect(await reservation(code)).toMatchObject({ status: "confirm_failed_refunded", refundedAmount: PAY_NOW - 1 });
  expect(await avail("2026-12-01")).toBe(3);
  expect(email.sent.filter((e) => e.to === GUEST)).toHaveLength(1);
  expect(await db.select().from(notifications).where(and(eq(notifications.reservationId, res.id), eq(notifications.kind, "payment_refunded"))))
    .toHaveLength(1);
});

test("a reconcile that hits a second refund failure keeps the mismatch reason, so the guest still gets the mismatch email", async () => {
  const { db, deps, gateway, email, manager, book, notice, reservation, refundRows } = await setup();
  const code = await book();
  const res0 = await reservation(code);
  // A second succeeded charge on the booking, so refundAndFail has two refunds to make.
  await db.insert(payments).values({
    id: "extra-charge", reservationId: res0.id, kind: "charge", method: "sinopac_online", amount: 100, status: "succeeded",
    providerRef: "REF-EXTRA", createdAt: minutes(1).getTime(),
  });
  vi.spyOn(gateway, "refund").mockRejectedValueOnce(new Error("timeout")); // first refund: outcome unknown
  await handlePaymentNotice(deps, await notice(code, { amount: PAY_NOW - 1 }), minutes(2)); // AMOUNT_MISMATCH
  const [first] = await refundRows(res0.id);
  expect(first.status).toBe("pending");

  vi.spyOn(gateway, "refund").mockResolvedValueOnce({ ok: false, error: "DECLINED" }); // the other refund fails during completion
  expect(await reconcileRefund(deps, manager, first.id, { kind: "mark_succeeded", providerRef: "BANK-1" }, minutes(60)))
    .toEqual({ ok: true, status: "succeeded", completed: null, reservationStatus: "paid_pending_confirm" });
  const after = await reservation(code);
  expect(after.lastSyncError).toContain("AMOUNT_MISMATCH");
  const second = (await refundRows(res0.id)).find((r) => r.id !== first.id)!;
  expect(second.status).toBe("failed");

  expect(await reconcileRefund(deps, manager, second.id, { kind: "retry" }, minutes(61)))
    .toEqual({ ok: true, status: "succeeded", completed: "refund_and_fail", reservationStatus: "confirm_failed_refunded" });
  const kinds = (await db.select().from(notifications).where(eq(notifications.reservationId, res0.id))).map((n) => n.kind);
  expect(kinds).toContain("payment_refunded");
  expect(kinds).not.toContain("booking_failed_refunded");
  expect(email.sent.filter((e) => e.to === GUEST)).toHaveLength(1);
});

describe("settle_offline: a refund the gateway will not take, paid back by the hotel itself (I-3)", () => {
  const OFFLINE = { kind: "settle_offline" as const, reference: "匯款 0123-4567 末五碼 88123", method: "transfer" as const };

  test("a failed cancel: row settled offline cancels the booking and gives its nights back; a second settle is ALREADY_RESOLVED", async () => {
    const s = await droppedClaim();
    const refund = vi.spyOn(s.gateway, "refund");
    refund.mockClear();
    expect(await s.avail("2026-12-10")).toBe(2);
    expect(await reconcileRefund(s.deps, s.manager, s.row.id, OFFLINE, LATER))
      .toEqual({ ok: true, status: "succeeded", completed: "cancellation", reservationStatus: "cancelled" });
    expect(refund).not.toHaveBeenCalled(); // the money moved by bank transfer, not through the gateway
    expect(await s.refundRows(s.id)).toMatchObject([{
      status: "succeeded", amount: PAID, method: "sinopac_online", providerRef: `offline:${OFFLINE.reference}`,
      note: expect.stringContaining("匯款"),
    }]);
    expect(await s.reservation(s.code)).toMatchObject({ status: "cancelled", refundedAmount: PAID, frontDeskRefundDue: 0, cancelledAt: s.row.createdAt });
    expect(await s.avail("2026-12-10")).toBe(3);
    expect(await s.avail("2026-12-11")).toBe(3);
    // Still an online refund: it reverses the online charge, so nothing is left online and the desk owes nothing.
    expect(await moneyOf(s.db, s.id)).toMatchObject({ onlineNet: 0, frontDeskNet: 0, received: 0, refunded: PAID });
    expect(await s.db.select().from(auditLog).where(eq(auditLog.entityId, s.row.id))).toMatchObject([{
      action: "payment.reconcile", entity: "payment", staffEmail: s.manager.email,
      before: { status: "failed" },
      after: { kind: "settle_offline", method: "transfer", reference: OFFLINE.reference, providerRef: `offline:${OFFLINE.reference}` },
    }]);

    expect(await reconcileRefund(s.deps, s.manager, s.row.id, OFFLINE, LATER)).toEqual({ ok: false, error: "ALREADY_RESOLVED" });
    expect((await s.reservation(s.code)).refundedAmount).toBe(PAID);
    expect(await s.db.select().from(auditLog).where(eq(auditLog.entityId, s.row.id))).toHaveLength(1);
  });

  test("a pending (outcome unknown) row can be settled offline too", async () => {
    const s = await stuckCancellation();
    expect(await reconcileRefund(s.deps, s.manager, s.row.id, { ...OFFLINE, method: "cash" }, LATER))
      .toEqual({ ok: true, status: "succeeded", completed: "cancellation", reservationStatus: "cancelled" });
    expect(await s.reservation(s.code)).toMatchObject({ status: "cancelled", refundedAmount: PAID });
  });

  test("a failed modify: row settled offline lets the guest cancel again", async () => {
    const s = await tenK();
    vi.spyOn(s.gateway, "refund").mockResolvedValueOnce({ ok: false, error: "REFUND_WINDOW_CLOSED" });
    expect(await s.modify(ONE_NIGHT)).toMatchObject({ ok: true, refundFailed: true });
    expect(await findReservation(s.db, s.code, GUEST, AT)).toMatchObject({ canCancel: false, changePending: true });
    const [row] = await s.refunds();
    expect(await reconcileRefund(s.deps, s.manager, row.id, { ...OFFLINE, method: "edc" }, minutes(20)))
      .toEqual({ ok: true, status: "succeeded", completed: null, reservationStatus: "confirmed" });
    expect(await findReservation(s.db, s.code, GUEST, minutes(21))).toMatchObject({ canCancel: true, changePending: false, paid: 4000, refunded: 6000 });
    expect((await s.row()).refundedAmount).toBe(0); // a modification refund never counted toward refundedAmount
    expect(await cancelReservation(s.deps, s.code, GUEST, minutes(22))).toEqual({ ok: true, refunded: 4000, alreadyCancelled: false });
  });

  test("the reference is required, at most 200 characters and never a card number; staff need payments.reconcile", async () => {
    const s = await droppedClaim();
    const settle = (reference: string, who = s.manager) => reconcileRefund(s.deps, who, s.row.id, { ...OFFLINE, reference }, LATER);
    expect(await settle("  ")).toEqual({ ok: false, error: "REFERENCE_REQUIRED" });
    expect(await settle("x".repeat(201))).toEqual({ ok: false, error: "INVALID_REFERENCE" });
    expect(await settle("退卡 4111 1111 1111 1111")).toEqual({ ok: false, error: "LOOKS_LIKE_CARD_NUMBER" });
    expect(await settle("ok", s.frontDesk)).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(await s.refundRows(s.id)).toMatchObject([{ status: "failed" }]);
    expect((await s.reservation(s.code)).status).toBe("confirmed");
  });
});
