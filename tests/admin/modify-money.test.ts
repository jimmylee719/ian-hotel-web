import { eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { balanceDueOf, recordFrontDeskPayment, voidFrontDeskPayment } from "@/lib/admin/front-desk";
import { applyModification, previewModification } from "@/lib/admin/modify";
import { reconcileRefund } from "@/lib/admin/reconcile";
import { staffCancel } from "@/lib/admin/staff-cancel";
import { cancelReservation, findReservation } from "@/lib/booking/manage";
import { ratePlans, reservations } from "@/lib/db/schema";
import { minutes } from "@/tests/helpers/booking";
import { AT, ONE_NIGHT, REASON, TWO_NIGHTS, tenK } from "@/tests/helpers/money";

const GUEST = "mei@example.com";
const HALF = new Date("2026-11-29T16:00:00Z"); // 2026-11-30 Taipei: 1 day before → 50%

afterEach(() => {
  vi.restoreAllMocks();
});

test("a deposit booking lowered to a total still above the deposit refunds nothing: the balance due just shrinks", async () => {
  const s = await tenK({ deposit: true });
  const refund = vi.spyOn(s.gateway, "refund");
  expect(await previewModification(s.db, s.frontDesk, s.id, ONE_NIGHT, AT))
    .toMatchObject({ ok: true, difference: -6000, refundIfLower: 0, frontDeskRefundIfLower: 0, balanceDue: 1000 });
  expect(await s.modify(ONE_NIGHT)).toMatchObject({ ok: true, refunded: 0, frontDeskRefundDue: 0, balanceDue: 1000 });
  expect(refund).not.toHaveBeenCalled();
  expect(await s.refunds()).toEqual([]);
  expect(await s.row()).toMatchObject({ totalAmount: 4000, frontDeskRefundDue: 0 });
  expect(await balanceDueOf(s.db, s.id)).toBe(1000);
});

test("a fully paid booking lowered from 10000 to 4000 refunds the 6000 online", async () => {
  const s = await tenK();
  expect(await s.modify(ONE_NIGHT)).toMatchObject({ ok: true, refunded: 6000, frontDeskRefundDue: 0, balanceDue: 0 });
  expect(await s.refunds()).toMatchObject([{ status: "succeeded", amount: 6000, idempotencyKey: `modify:${s.id}:1` }]);
  expect(await s.row()).toMatchObject({ frontDeskRefundDue: 0 });
  expect(await balanceDueOf(s.db, s.id)).toBe(0);
});

test("paid 3000 online and 7000 at the desk, lowered to 4000: 3000 back online, 3000 owed by the desk; a raise brings it back to 0", async () => {
  const s = await tenK({ deposit: true, desk: 7000 });
  expect(await s.modify(ONE_NIGHT)).toMatchObject({ ok: true, refunded: 3000, frontDeskRefundDue: 3000, balanceDue: 0 });
  expect(await s.refunds()).toMatchObject([{ status: "succeeded", amount: 3000 }]);
  expect(await s.row()).toMatchObject({ totalAmount: 4000, frontDeskRefundDue: 3000 });

  // Back to two nights: the 3000 the desk owed is now part of what is due, and nothing more is refunded.
  expect(await s.modify(TWO_NIGHTS, minutes(20))).toMatchObject({ ok: true, difference: 6000, refunded: 0, frontDeskRefundDue: 0, balanceDue: 3000 });
  expect(await s.row()).toMatchObject({ totalAmount: 10000, frontDeskRefundDue: 0 });
  expect(await balanceDueOf(s.db, s.id)).toBe(3000);
  expect(await s.refunds()).toHaveLength(1);
});

test("an OTA booking is not modified here: NOT_MODIFIABLE, OTA_BOOKING", async () => {
  const s = await tenK();
  await s.db.update(reservations).set({ channel: "siteminder_ota" }).where(eq(reservations.id, s.id));
  expect(await previewModification(s.db, s.frontDesk, s.id, ONE_NIGHT, AT)).toEqual({ ok: false, error: "NOT_MODIFIABLE", detail: "OTA_BOOKING" });
  expect(await applyModification(s.deps, s.frontDesk, s.id, ONE_NIGHT, { expectedDifference: -6000, reason: REASON }, AT))
    .toEqual({ ok: false, error: "NOT_MODIFIABLE", detail: "OTA_BOOKING" });
  expect(await s.row()).toMatchObject({ totalAmount: 10000, modCount: 0 });
});

test("a desk payment or void between the preview and the apply makes the apply CONFLICT", async () => {
  const s = await tenK({ deposit: true });
  const p = await previewModification(s.db, s.frontDesk, s.id, ONE_NIGHT, AT);
  if (!p.ok) throw new Error("preview failed");
  const r = await recordFrontDeskPayment(s.db, s.frontDesk, s.id, { method: "cash", amount: 5000 }, minutes(11));
  if (!r.ok) throw new Error("desk payment failed");
  const apply = (expectedUpdatedAt: number) => applyModification(s.deps, s.frontDesk, s.id, ONE_NIGHT,
    { expectedDifference: p.difference, reason: REASON, expectedUpdatedAt }, minutes(12));
  expect(await apply(p.updatedAt)).toEqual({ ok: false, error: "CONFLICT" });
  expect(await s.row()).toMatchObject({ totalAmount: 10000, modCount: 0 });

  const p2 = await previewModification(s.db, s.frontDesk, s.id, ONE_NIGHT, minutes(13));
  if (!p2.ok) throw new Error("preview failed");
  expect(await voidFrontDeskPayment(s.db, s.manager, r.paymentId, "打錯金額", minutes(14))).toMatchObject({ ok: true });
  expect(await apply(p2.updatedAt)).toEqual({ ok: false, error: "CONFLICT" });
  expect(await s.row()).toMatchObject({ totalAmount: 10000, modCount: 0 });
});

test("while a modification refund is unsettled neither guests nor staff can cancel; once settled the cancel refunds the right amount", async () => {
  const s = await tenK();
  vi.spyOn(s.gateway, "refund").mockResolvedValueOnce({ ok: false, error: "GATEWAY_DOWN" });
  expect(await s.modify(ONE_NIGHT)).toMatchObject({ ok: true, refundFailed: true });

  expect(await cancelReservation(s.deps, s.code, GUEST, AT)).toEqual({ ok: false, error: "MODIFICATION_REFUND_PENDING" });
  expect(await staffCancel(s.deps, s.frontDesk, s.id, { reason: "x", notifyGuest: false }, AT))
    .toEqual({ ok: false, error: "MODIFICATION_REFUND_PENDING" });
  expect(await s.row()).toMatchObject({ status: "confirmed", cancelledAt: null });
  expect(await s.refunds()).toMatchObject([{ status: "failed", amount: 6000 }]);
  expect(await findReservation(s.db, s.code, GUEST, AT)).toMatchObject({ canCancel: false, changePending: true });

  const [row] = await s.refunds();
  expect(await reconcileRefund(s.deps, s.manager, row.id, { kind: "retry" }, minutes(20))).toMatchObject({ ok: true, status: "succeeded" });
  expect(await findReservation(s.db, s.code, GUEST, minutes(21))).toMatchObject({ canCancel: true, changePending: false, paid: 4000, refunded: 6000 });
  // 100% of what is left (4000), not of the 10000 first paid.
  expect(await cancelReservation(s.deps, s.code, GUEST, minutes(22))).toEqual({ ok: true, refunded: 4000, alreadyCancelled: false });
  expect((await s.refunds()).map((r) => [r.status, r.amount])).toEqual([["succeeded", 6000], ["succeeded", 4000]]);
});

test("a cancel keeps what the desk already owes from a modification: non-refundable plan", async () => {
  const s = await tenK({ deposit: true, desk: 7000 });
  expect(await s.modify(ONE_NIGHT)).toMatchObject({ ok: true, frontDeskRefundDue: 3000 });
  await s.db.update(reservations).set({ cancelPolicy: { rules: [] } }).where(eq(reservations.id, s.id));
  expect(await staffCancel(s.deps, s.frontDesk, s.id, { reason: "x", notifyGuest: false }, HALF))
    .toEqual({ ok: true, refunded: 0, frontDeskRefundDue: 3000, alreadyCancelled: false });
  expect(await s.row()).toMatchObject({ status: "cancelled", frontDeskRefundDue: 3000 });
});

test("a cancel applies its policy only to money not already owed back: 50% of 4000 plus the 3000 owed", async () => {
  const s = await tenK({ deposit: true, desk: 7000 });
  expect(await s.modify(ONE_NIGHT)).toMatchObject({ ok: true, frontDeskRefundDue: 3000 });
  // received 7000 = 4000 for the stay + 3000 owed back. 50% of 4000 = 2000, all at the desk (online net is 0).
  expect(await staffCancel(s.deps, s.frontDesk, s.id, { reason: "x", notifyGuest: false }, HALF))
    .toEqual({ ok: true, refunded: 0, frontDeskRefundDue: 5000, alreadyCancelled: false });
  expect(await s.row()).toMatchObject({ status: "cancelled", frontDeskRefundDue: 5000 });
});
