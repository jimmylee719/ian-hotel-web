import { describe, expect, it } from "vitest";
import { MockSinoPacGateway } from "@/lib/payments/mock-sinopac";
import { buildMockPayment, isMockPaymentMode, reservationCodeFromRef } from "@/lib/payments/mock-page";
import type { PaymentNotice } from "@/lib/payments/types";

const gw = () => new MockSinoPacGateway({ secret: "s3cret", baseUrl: "https://hotel.test/" });
const notice: PaymentNotice = {
  reservationCode: "NK-1234", providerRef: "MOCK-NK-1234-abcdef01", amount: 4960, status: "succeeded",
};

describe("MockSinoPacGateway", () => {
  it("accepts a notice it signed", async () => {
    const g = gw();
    const r = await g.verifyNotice(await g.signedNotice(notice));
    expect(r).toEqual({ ok: true, notice });
  });

  it("rejects a tampered amount", async () => {
    const g = gw();
    const s = await g.signedNotice(notice);
    const r = await g.verifyNotice({ ...s, body: s.body.replace("4960", "1") });
    expect(r).toEqual({ ok: false, error: "BAD_SIGNATURE" });
  });

  it("rejects a missing signature and a signature from another secret", async () => {
    const g = gw();
    const s = await g.signedNotice(notice);
    expect(await g.verifyNotice({ headers: {}, body: s.body })).toEqual({ ok: false, error: "BAD_SIGNATURE" });
    const other = new MockSinoPacGateway({ secret: "x", baseUrl: "https://h" });
    expect(await g.verifyNotice(await other.signedNotice(notice))).toEqual({ ok: false, error: "BAD_SIGNATURE" });
  });

  it("returns MALFORMED for non-JSON and for the wrong shape", async () => {
    const g = gw();
    expect(await g.verifyNotice({ headers: {}, body: "not json" })).toEqual({ ok: false, error: "MALFORMED" });
    expect(await g.verifyNotice({ headers: {}, body: '{"amount":"x"}' })).toEqual({ ok: false, error: "MALFORMED" });
  });

  it("startCharge redirects to the mock pay page", async () => {
    const start = await gw().startCharge({
      reservationCode: "NK-1234", amount: 4960, locale: "ja",
      returnUrl: "https://hotel.test/ja/booking/NK-1234", notifyUrl: "https://hotel.test/api/payments/notify", description: "x",
    });
    expect(start.kind).toBe("redirect");
    if (start.kind !== "redirect") return;
    const url = new URL(start.url);
    expect(url.origin + url.pathname.split("/").slice(0, 3).join("/")).toBe("https://hotel.test/dev/pay");
    const ref = decodeURIComponent(url.pathname.split("/")[3]);
    expect(ref).toMatch(/^MOCK-NK-1234-[0-9a-f]{8}$/);
    expect(url.searchParams.get("code")).toBe("NK-1234");
    expect(url.searchParams.get("amount")).toBe("4960");
    expect(url.searchParams.get("locale")).toBe("ja");
    expect(url.searchParams.get("returnUrl")).toBe("https://hotel.test/ja/booking/NK-1234");
    expect(url.searchParams.get("notifyUrl")).toBe("https://hotel.test/api/payments/notify");
  });

  it("refunds, or fails when configured to", async () => {
    const ok = await gw().refund({ providerRef: "P1", amount: 100, reason: "r" });
    expect(ok.ok && ok.refundRef).toMatch(/^MOCK-REFUND-P1-/);
    const bad = new MockSinoPacGateway({ secret: "s", baseUrl: "https://h", failRefund: true });
    expect((await bad.refund({ providerRef: "P1", amount: 100, reason: "r" })).ok).toBe(false);
    expect(gw().supportsPreauth).toBe(false);
  });

  it("refunds once per idempotency key and repeats the first result", async () => {
    const g = gw();
    const a = await g.refund({ providerRef: "P1", amount: 100, reason: "r", idempotencyKey: "k1" });
    const b = await g.refund({ providerRef: "P1", amount: 100, reason: "r", idempotencyKey: "k1" });
    expect(a).toEqual(b);
    expect(g.refunds).toHaveLength(1);
    await g.refund({ providerRef: "P1", amount: 100, reason: "r", idempotencyKey: "k2" });
    expect(g.refunds).toHaveLength(2);
  });
});

describe("mock pay page logic", () => {
  it("builds a notice the gateway verifies", async () => {
    const signed = await buildMockPayment({ secret: "s3cret", ref: "MOCK-NK-1234-abcdef01", code: "NK-1234", amount: 4960, outcome: "failed" });
    const r = await gw().verifyNotice(signed);
    expect(r.ok && r.notice.status).toBe("failed");
  });

  it("is enabled only in mock mode with ENVIRONMENT=local, the rule deps.ts uses", () => {
    expect(isMockPaymentMode({ PAYMENT_MODE: "mock" })).toBe(false); // ENVIRONMENT unset: not local
    expect(isMockPaymentMode({ PAYMENT_MODE: "mock", ENVIRONMENT: "staging" })).toBe(false);
    expect(isMockPaymentMode({ PAYMENT_MODE: "mock", ENVIRONMENT: "" })).toBe(false);
    expect(isMockPaymentMode({ PAYMENT_MODE: "sinopac" })).toBe(false);
    expect(isMockPaymentMode({})).toBe(false);
    expect(isMockPaymentMode({ PAYMENT_MODE: "mock", ENVIRONMENT: "production" })).toBe(false); // /dev/pay 404s in production
    expect(isMockPaymentMode({ PAYMENT_MODE: "mock", ENVIRONMENT: "local" })).toBe(true);
  });

  it("extracts the reservation code from a ref", () => {
    expect(reservationCodeFromRef("MOCK-NK-1234-abcdef01")).toBe("NK-1234");
    expect(reservationCodeFromRef("garbage")).toBeNull();
  });
});
