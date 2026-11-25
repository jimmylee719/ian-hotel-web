import { and, eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { refundOnce } from "@/lib/booking/confirm";
import { cancelReservation } from "@/lib/booking/manage";
import { refundableCharges } from "@/lib/booking/notify";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { payments } from "@/lib/db/schema";
import { MockSinoPacGateway } from "@/lib/payments/mock-sinopac";
import { bookingSetup, minutes, PAY_NOW } from "@/tests/helpers/booking";
import { paymentConformance } from "@/tests/conformance/payment";

let attempt = 0;
paymentConformance(() => new MockSinoPacGateway({ secret: "s", baseUrl: "https://hotel.test" }), {
  fixtures: {
    signedNotice: (gw, n) => gw.signedNotice(n),
    // As in production: the attempt is started, then the provider's notice brings its own transaction ref.
    paidAttempt: async (gw) => {
      const code = `NK-PA${++attempt}`;
      const merchantOrderNo = `${code}-1`;
      await gw.startCharge({
        reservationCode: code, merchantOrderNo, amount: 4000, locale: "en",
        returnUrl: "https://hotel.test/r", notifyUrl: "https://hotel.test/n", description: "x",
      });
      const providerRef = `BANK-${merchantOrderNo}`;
      const v = await gw.verifyNotice(await gw.signedNotice({ reservationCode: code, providerRef, amount: 4000, status: "succeeded", merchantOrderNo }));
      if (!v.ok) throw new Error(v.error);
      return { merchantOrderNo, providerRef, amount: 4000 };
    },
  },
});

const GUEST = "mei@example.com";

/** A paid, confirmed booking (2026-12-01 → 12-03) and its refund rows. */
async function paid(o: { refundTimeoutNext?: number } = {}) {
  const s = await bookingSetup(o);
  const code = await s.book();
  await handlePaymentNotice(s.deps, await s.notice(code), minutes(2));
  const res = await s.reservation(code);
  expect(res.status).toBe("confirmed");
  const refundRows = () => s.db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund")));
  const [charge] = await refundableCharges(s.db, res.id);
  return { ...s, code, res, charge, refundRows };
}

test("a refund that succeeded but whose answer timed out is recorded as succeeded after queryRefund, refunded once", async () => {
  const { deps, gateway, code, res, reservation, refundRows } = await paid({ refundTimeoutNext: 1 });
  const refund = vi.spyOn(gateway, "refund");
  const query = vi.spyOn(gateway, "queryRefund");

  expect(await cancelReservation(deps, code, GUEST, minutes(10))).toEqual({ ok: true, refunded: PAY_NOW, alreadyCancelled: false });
  expect(refund).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith(`cancel:${res.id}`);
  expect(gateway.refunds).toHaveLength(1);
  expect(await refundRows()).toMatchObject([{ status: "succeeded", amount: PAY_NOW, providerRef: gateway.refunds[0].refundRef }]);
  expect(await reservation(code)).toMatchObject({ status: "cancelled", refundedAmount: PAY_NOW });
});

test("refundOnce: an unknown outcome that queryRefund reports not_found (or failed) is failed, and a retry refunds", async () => {
  const { deps, gateway, charge, refundRows } = await paid();
  vi.spyOn(gateway, "refund").mockRejectedValueOnce(new Error("socket hang up")); // never reached the provider
  const r = await refundOnce(deps, "k-not-found", charge, 100, "TEST", minutes(10));
  expect(r).toMatchObject({ ok: false });
  expect(r.ok || r.pendingRefundId).toBeFalsy(); // not stuck pending
  expect(await refundRows()).toMatchObject([{ status: "failed", idempotencyKey: "k-not-found" }]);

  expect(await refundOnce(deps, "k-not-found", charge, 100, "TEST", minutes(11))).toEqual({ ok: true, amount: 100 });
  expect(gateway.refunds).toHaveLength(1);

  vi.spyOn(gateway, "refund").mockResolvedValueOnce({ ok: false, error: "TIMEOUT", outcomeUnknown: true });
  vi.spyOn(gateway, "queryRefund").mockResolvedValueOnce({ status: "failed" });
  expect(await refundOnce(deps, "k-failed", charge, 50, "TEST", minutes(12))).toMatchObject({ ok: false });
  expect((await refundRows()).find((p) => p.idempotencyKey === "k-failed")).toMatchObject({ status: "failed" });
});

test("refundOnce: an unknown outcome stays pending when queryRefund says pending or cannot answer", async () => {
  const { deps, gateway, charge, refundRows } = await paid();
  vi.spyOn(gateway, "refund").mockResolvedValueOnce({ ok: false, error: "TIMEOUT", outcomeUnknown: true });
  vi.spyOn(gateway, "queryRefund").mockResolvedValueOnce({ status: "pending" });
  const a = await refundOnce(deps, "k-pending", charge, 100, "TEST", minutes(10));
  expect(a).toMatchObject({ ok: false, error: expect.stringContaining("REFUND_OUTCOME_UNKNOWN") });

  vi.spyOn(gateway, "refund").mockRejectedValueOnce(new Error("ECONNRESET"));
  vi.spyOn(gateway, "queryRefund").mockResolvedValueOnce({ error: "QUERY_DOWN" });
  const b = await refundOnce(deps, "k-query-down", charge, 100, "TEST", minutes(10));

  vi.spyOn(gateway, "refund").mockRejectedValueOnce(new Error("ECONNRESET"));
  vi.spyOn(gateway, "queryRefund").mockRejectedValueOnce(new Error("ECONNRESET"));
  const c = await refundOnce(deps, "k-query-throws", charge, 100, "TEST", minutes(10));

  const rows = await refundRows();
  for (const [key, out] of [["k-pending", a], ["k-query-down", b], ["k-query-throws", c]] as const) {
    const row = rows.find((p) => p.idempotencyKey === key)!;
    expect(row.status).toBe("pending");
    expect(out).toMatchObject({ ok: false, pendingRefundId: row.id, refundId: row.id });
  }
  expect(gateway.refunds).toHaveLength(0);
});

test("refundOnce: a definite rejection is failed without asking queryRefund", async () => {
  const { deps, gateway, charge, refundRows } = await paid();
  vi.spyOn(gateway, "refund").mockResolvedValueOnce({ ok: false, error: "DECLINED" });
  const query = vi.spyOn(gateway, "queryRefund");
  expect(await refundOnce(deps, "k-declined", charge, 100, "TEST", minutes(10))).toMatchObject({ ok: false, error: "DECLINED" });
  expect(query).not.toHaveBeenCalled();
  expect(await refundRows()).toMatchObject([{ status: "failed" }]);
});

test("paying again starts a new attempt: merchantOrderNo is <code>-1 then <code>-2", async () => {
  const { gateway, book, reservation } = await bookingSetup();
  const start = vi.spyOn(gateway, "startCharge");
  const code = await book();
  expect(await book({}, minutes(1))).toBe(code); // same idempotency key: the pay-again path
  expect(code).toMatch(/^NK-[0-9A-Z]{6}$/);
  expect(start.mock.calls.map(([r]) => r.merchantOrderNo)).toEqual([`${code}-1`, `${code}-2`]);
  expect(await reservation(code)).toMatchObject({ chargeAttempt: 2, lastChargeStartedAt: minutes(1).getTime() });
});

test("no new attempt is started once the booking has left pending_payment", async () => {
  const { deps, gateway, book, notice, reservation } = await bookingSetup();
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(2));
  const start = vi.spyOn(gateway, "startCharge");
  await expect(book({}, minutes(3))).rejects.toThrow(/ALREADY_PAID/);
  expect(start).not.toHaveBeenCalled();
  expect((await reservation(code)).chargeAttempt).toBe(1);
});

test("mock queryTransaction finds a started charge by merchantOrderNo or providerRef, and its verified result", async () => {
  const gw = new MockSinoPacGateway({ secret: "s", baseUrl: "https://hotel.test" });
  expect(await gw.queryTransaction({ merchantOrderNo: "NK-NONE-1" })).toEqual({ status: "not_found" });
  const start = await gw.startCharge({
    reservationCode: "NK-ABCDEF", merchantOrderNo: "NK-ABCDEF-1", amount: 4000, locale: "en",
    returnUrl: "https://hotel.test/r", notifyUrl: "https://hotel.test/n", description: "x",
  });
  if (start.kind !== "redirect") throw new Error("expected a redirect");
  const providerRef = decodeURIComponent(new URL(start.url).pathname.split("/")[3]);
  expect(await gw.queryTransaction({ merchantOrderNo: "NK-ABCDEF-1" })).toEqual({ status: "pending", amount: 4000, providerRef });
  await gw.verifyNotice(await gw.signedNotice({ reservationCode: "NK-ABCDEF", providerRef, amount: 4000, status: "succeeded" }));
  expect(await gw.queryTransaction({ providerRef })).toEqual({ status: "succeeded", amount: 4000, providerRef });
  expect(await gw.queryRefund("never")).toEqual({ status: "not_found" });
});
