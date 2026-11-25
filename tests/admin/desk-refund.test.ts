import { and, eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { getDashboard } from "@/lib/admin/dashboard";
import { balanceDueOf, recordFrontDeskRefund } from "@/lib/admin/front-desk";
import { moneyOf } from "@/lib/admin/money-metrics";
import { previewModification } from "@/lib/admin/modify";
import { staffCancel } from "@/lib/admin/staff-cancel";
import { auditLog, payments } from "@/lib/db/schema";
import { minutes } from "@/tests/helpers/booking";
import { AT, ONE_NIGHT, TWO_NIGHTS, tenK } from "@/tests/helpers/money";

const DAY_MS = 86_400_000;
const cash = (amount: number, note?: string) => ({ method: "cash" as const, amount, ...(note ? { note } : {}) });

afterEach(() => {
  vi.restoreAllMocks();
});

/** 3000 online + 7000 at the desk for a 10000 stay, lowered to 4000: 3000 back online, 3000 owed by the desk. */
async function owing() {
  const s = await tenK({ deposit: true, desk: 7000 });
  expect(await s.modify(ONE_NIGHT)).toMatchObject({ ok: true, refunded: 3000, frontDeskRefundDue: 3000 });
  return s;
}

test("a desk payout is a succeeded refund row: desk-due and received go down, the booking's version moves, it is audited", async () => {
  const s = await owing();
  const before = await s.row();
  expect(await moneyOf(s.db, s.id)).toMatchObject({ onlineNet: 0, frontDeskNet: 7000, received: 7000 });

  const r = await recordFrontDeskRefund(s.db, s.frontDesk, s.id, cash(1000, "現金退還"), minutes(30));
  expect(r).toMatchObject({ ok: true, frontDeskRefundDue: 2000 });
  if (!r.ok) throw new Error("payout failed");
  const [row] = await s.db.select().from(payments).where(eq(payments.id, r.paymentId));
  expect(row).toMatchObject({ kind: "refund", method: "cash", amount: 1000, status: "succeeded", refundOf: null, note: "現金退還" });
  expect(await s.row()).toMatchObject({ frontDeskRefundDue: 2000, updatedAt: minutes(30).getTime() });
  expect((await s.row()).updatedAt).not.toBe(before.updatedAt);
  expect(await moneyOf(s.db, s.id)).toEqual({ onlineNet: 0, frontDeskNet: 6000, received: 6000, grossReceived: 10000, refunded: 4000 });
  expect(await s.db.select().from(auditLog).where(and(eq(auditLog.entityId, r.paymentId), eq(auditLog.action, "payment.front_desk_refund"))))
    .toMatchObject([{ staffEmail: s.frontDesk.email, after: expect.objectContaining({ amount: 1000, frontDeskRefundDue: 2000 }) }]);
});

test("a payout must be a positive whole amount no larger than the desk-due, with the desk entry rules", async () => {
  const s = await owing();
  for (const amount of [0, -5, 1.5])
    expect(await recordFrontDeskRefund(s.db, s.frontDesk, s.id, cash(amount), AT)).toEqual({ ok: false, error: "INVALID_AMOUNT" });
  expect(await recordFrontDeskRefund(s.db, s.frontDesk, s.id, cash(3001), AT)).toEqual({ ok: false, error: "EXCEEDS_DESK_DUE" });
  expect(await recordFrontDeskRefund(s.db, s.frontDesk, s.id, { method: "edc", amount: 100, authCode: "A1" }, AT)).toEqual({ ok: false, error: "INVALID_LAST4" });
  expect(await recordFrontDeskRefund(s.db, s.frontDesk, s.id, { method: "edc", amount: 100, last4: "1234" }, AT)).toEqual({ ok: false, error: "AUTH_CODE_REQUIRED" });
  expect(await recordFrontDeskRefund(s.db, s.frontDesk, s.id, cash(100, "4111 1111 1111 1111"), AT)).toEqual({ ok: false, error: "LOOKS_LIKE_CARD_NUMBER" });
  expect(await recordFrontDeskRefund(s.db, s.marketing, s.id, cash(100), AT)).toEqual({ ok: false, error: "FORBIDDEN" });
  expect(await s.row()).toMatchObject({ frontDeskRefundDue: 3000 });

  // Two desks paying out the same 3000 at once: one wins.
  const [a, b] = await Promise.all([
    recordFrontDeskRefund(s.db, s.frontDesk, s.id, cash(3000), AT),
    recordFrontDeskRefund(s.db, s.frontDesk, s.id, cash(3000), AT),
  ]);
  expect([a, b].filter((r) => r.ok)).toHaveLength(1);
  expect([a, b].filter((r) => !r.ok)).toEqual([{ ok: false, error: "EXCEEDS_DESK_DUE" }]);
  expect(await s.row()).toMatchObject({ frontDeskRefundDue: 0 });
  expect(await moneyOf(s.db, s.id)).toMatchObject({ received: 4000 });
});

test("10000 paid, lowered to 4000, the desk pays out, then cancelled at 100%: everything goes back exactly once", async () => {
  const s = await owing();
  expect(await recordFrontDeskRefund(s.db, s.frontDesk, s.id, cash(3000), minutes(30))).toMatchObject({ ok: true, frontDeskRefundDue: 0 });
  // 100%: the 4000 still held, all of it at the desk (nothing is left online).
  expect(await staffCancel(s.deps, s.frontDesk, s.id, { reason: "x", notifyGuest: false }, minutes(40)))
    .toEqual({ ok: true, refunded: 0, frontDeskRefundDue: 4000, alreadyCancelled: false });
  expect(await s.row()).toMatchObject({ status: "cancelled", frontDeskRefundDue: 4000 });
  // The desk hands the rest back after the cancel.
  expect(await recordFrontDeskRefund(s.db, s.frontDesk, s.id, cash(4000), minutes(50))).toMatchObject({ ok: true, frontDeskRefundDue: 0 });
  expect(await recordFrontDeskRefund(s.db, s.frontDesk, s.id, cash(1), minutes(51))).toEqual({ ok: false, error: "EXCEEDS_DESK_DUE" });

  const money = await moneyOf(s.db, s.id);
  expect(money).toMatchObject({ received: 0, refunded: 10000, grossReceived: 10000 });
  const rows = await s.db.select().from(payments).where(and(eq(payments.reservationId, s.id), eq(payments.status, "succeeded")));
  const paidIn = rows.filter((r) => r.kind !== "refund").reduce((t, r) => t + r.amount, 0);
  const paidOut = rows.filter((r) => r.kind === "refund").reduce((t, r) => t + r.amount, 0);
  expect([paidIn, paidOut]).toEqual([10000, 10000]);
});

test("lowered, paid out at the desk, then raised again: the balance due is the new total minus what is still held", async () => {
  const s = await owing();
  expect(await recordFrontDeskRefund(s.db, s.frontDesk, s.id, cash(3000), minutes(30))).toMatchObject({ ok: true });
  expect(await previewModification(s.db, s.frontDesk, s.id, TWO_NIGHTS, minutes(31)))
    .toMatchObject({ ok: true, difference: 6000, refundIfLower: 0, frontDeskRefundIfLower: 0, balanceDue: 6000 });
  expect(await s.modify(TWO_NIGHTS, minutes(32))).toMatchObject({ ok: true, refunded: 0, frontDeskRefundDue: 0, balanceDue: 6000 });
  expect(await balanceDueOf(s.db, s.id)).toBe(6000);
});

test("a cancel whose online refund fails outright leaves the desk-due as it was; the retry that completes sets it", async () => {
  const s = await tenK({ deposit: true, desk: 7000 }); // 3000 online + 7000 desk, 10000 stay; desk-due 0
  vi.spyOn(s.gateway, "refund").mockResolvedValueOnce({ ok: false, error: "GATEWAY_DOWN" });
  expect(await staffCancel(s.deps, s.frontDesk, s.id, { reason: "x", notifyGuest: false }, AT)).toEqual({ ok: false, error: "REFUND_FAILED" });
  expect(await s.row()).toMatchObject({ status: "confirmed", cancelledAt: null, frontDeskRefundDue: 0 });
  // While that cancellation's refund is unsettled, the desk cannot pay anything out.
  expect(await recordFrontDeskRefund(s.db, s.frontDesk, s.id, cash(1), AT)).toEqual({ ok: false, error: "EXCEEDS_DESK_DUE" });

  expect(await staffCancel(s.deps, s.frontDesk, s.id, { reason: "x", notifyGuest: false }, minutes(20)))
    .toEqual({ ok: true, refunded: 3000, frontDeskRefundDue: 7000, alreadyCancelled: false });
  expect(await s.row()).toMatchObject({ status: "cancelled", frontDeskRefundDue: 7000 });
});

test("the dashboard flags desk-due older than a day", async () => {
  const s = await owing();
  const kinds = async (at: Date) => (await getDashboard(s.db, s.propertyId, at)).alerts.filter((a) => a.kind === "desk_refund_due");
  expect(await kinds(minutes(60))).toEqual([]);
  const later = new Date(AT.getTime() + DAY_MS + 60_000);
  expect(await kinds(later)).toMatchObject([{ reservationId: s.id, code: s.code, detail: expect.stringContaining("3,000") }]);
  expect(await recordFrontDeskRefund(s.db, s.frontDesk, s.id, cash(3000), later)).toMatchObject({ ok: true });
  expect(await kinds(new Date(later.getTime() + DAY_MS * 2))).toEqual([]);
});
