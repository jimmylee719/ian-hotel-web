import { describe, expect, test, vi } from "vitest";
import { createReservation } from "@/lib/booking/create";
import { seedNk } from "@/lib/db/seed-nk";
import type { PaymentGateway, PaymentNotice } from "@/lib/payments/types";
import { fillAri } from "@/tests/helpers/ari";
import { BASE, bookingInput, NOW } from "@/tests/helpers/booking";
import { createTestDb } from "@/tests/helpers/test-db";

/**
 * The rules every PaymentGateway must keep, shared by the mock and the real SinoPac adapter.
 * Not a test file itself: a `*.test.ts` calls it with the adapter under test.
 */
export type PaymentConformanceOptions<G extends PaymentGateway = PaymentGateway> = {
  fixtures?: {
    /**
     * The request the provider would send to notifyUrl for `notice`, correctly signed (rule 1).
     * Required: without it rule 1 fails rather than being skipped.
     */
    signedNotice?: (gw: G, notice: PaymentNotice) => Promise<{ headers: Record<string, string>; body: string }>;
    /** The same request with its content changed but its signature kept. Default: the amount in the body changed. */
    tamper?: (signed: { headers: Record<string, string>; body: string }, notice: PaymentNotice) => { headers: Record<string, string>; body: string };
    /** A charge that succeeded at the provider, to refund (rules 2 and 4). Default: a made-up ref of NT$100. */
    paidCharge?: (gw: G) => Promise<{ providerRef: string; amount: number }>;
  };
};

let seq = 0;
/** A value no earlier run used, so a real sandbox never sees the same one twice. */
const fresh = (prefix: string) => `${prefix}${Date.now().toString(36).toUpperCase()}${(++seq).toString(36).toUpperCase()}`;

const defaultTamper = (s: { headers: Record<string, string>; body: string }, n: PaymentNotice) =>
  ({ ...s, body: s.body.replace(String(n.amount), String(n.amount + 1)) });

export function paymentConformance<G extends PaymentGateway>(make: () => G, opts: PaymentConformanceOptions<G> = {}): void {
  const tamper = opts.fixtures?.tamper ?? defaultTamper;
  const paidCharge = opts.fixtures?.paidCharge ?? (async () => ({ providerRef: fresh("CONF-REF-"), amount: 100 }));
  const notice = (): PaymentNotice => {
    const code = fresh("NK-P");
    return { reservationCode: code, providerRef: fresh(`REF-${code}-`), amount: 4960, status: "succeeded" };
  };
  const signed = (gw: G, n: PaymentNotice) => {
    const sign = opts.fixtures?.signedNotice;
    if (!sign) return expect.fail("fixtures.signedNotice is required to check rule 1");
    return sign(gw, n);
  };

  describe("PaymentGateway conformance", () => {
    test("1. a correctly signed notice verifies, with its content", async () => {
      const gw = make();
      const n = notice();
      const r = await gw.verifyNotice(await signed(gw, n));
      expect(r).toMatchObject({ ok: true, notice: { reservationCode: n.reservationCode, providerRef: n.providerRef, amount: n.amount, status: n.status } });
    });

    test("1. a tampered notice is BAD_SIGNATURE", async () => {
      const gw = make();
      const n = notice();
      const t = tamper(await signed(gw, n), n);
      expect(await gw.verifyNotice(t)).toEqual({ ok: false, error: "BAD_SIGNATURE" });
    });

    test("1. a malformed notice is MALFORMED", async () => {
      const gw = make();
      const { headers } = await signed(gw, notice());
      expect(await gw.verifyNotice({ headers, body: "not a notice" })).toEqual({ ok: false, error: "MALFORMED" });
    });

    test("2. refunding twice under one idempotencyKey refunds once and answers the same refundRef", async () => {
      const gw = make();
      const charge = await paidCharge(gw);
      const key = fresh("conf-refund:");
      const req = { providerRef: charge.providerRef, amount: charge.amount, reason: "CONFORMANCE", idempotencyKey: key };
      const a = await gw.refund(req);
      if (!a.ok) return expect.fail(`refund failed: ${a.error}`);
      expect(await gw.refund(req)).toEqual({ ok: true, refundRef: a.refundRef });
      expect(await gw.queryRefund(key)).toMatchObject({ status: "succeeded" }); // one refund, not two
    });

    test("3. a second payment attempt carries a merchantOrderNo different from the first", async () => {
      const db = createTestDb();
      const { propertyId } = await seedNk(db);
      await fillAri(db, propertyId, "2026-12-01", 5, { available: 3 });
      const gateway: PaymentGateway = make();
      const start = vi.spyOn(gateway, "startCharge");
      const deps = { db, gateway, baseUrl: BASE };
      const input = bookingInput({ idempotencyKey: fresh("conf-key-") });
      const first = await createReservation(deps, input, NOW);
      const again = await createReservation(deps, input, new Date(NOW.getTime() + 60_000)); // the guest pays again
      if (!first.ok || !again.ok) return expect.fail(JSON.stringify({ first, again }));
      const orderNos = start.mock.calls.map(([r]) => r.merchantOrderNo);
      expect(orderNos).toHaveLength(2);
      expect(orderNos[0]).not.toBe(orderNos[1]);
      // Each attempt's start actually carries its own merchantOrderNo to the provider.
      expect(JSON.stringify(first.start)).toContain(encodeURIComponent(orderNos[0]));
      expect(JSON.stringify(again.start)).toContain(encodeURIComponent(orderNos[1]));
    });

    test("4. queryRefund reports a refund that succeeded as succeeded, with its refundRef", async () => {
      const gw = make();
      const charge = await paidCharge(gw);
      const key = fresh("conf-query:");
      const r = await gw.refund({ providerRef: charge.providerRef, amount: charge.amount, reason: "CONFORMANCE", idempotencyKey: key });
      if (!r.ok) return expect.fail(`refund failed: ${r.error}`);
      const q = await gw.queryRefund(key);
      expect(q).toMatchObject({ status: "succeeded" });
      if ("status" in q && q.refundRef !== undefined) expect(q.refundRef).toBe(r.refundRef);
    });

    test("5. timeoutMs is set and at most 30000", () => {
      const { timeoutMs } = make();
      expect(Number.isFinite(timeoutMs)).toBe(true);
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(30_000);
    });
  });
}
