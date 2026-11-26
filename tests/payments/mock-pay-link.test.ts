import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { createReservation } from "@/lib/booking/create";
import { reservations } from "@/lib/db/schema";
import { buildMockPayment, checkMockPayRequest } from "@/lib/payments/mock-page";
import { MOCK_SIGNATURE_HEADER, payLinkSignature, payLinkValid } from "@/lib/payments/mock-sinopac";
import { BASE, bookingInput, bookingSetup, NOW, PAY_NOW } from "@/tests/helpers/booking";

// /dev/pay is public on the preview: only a link the gateway signed, for the booking's current pending attempt and
// amount, may produce a signed notice. Anything else is a 404 (checkMockPayRequest returns null).

async function started() {
  const s = await bookingSetup();
  const r = await createReservation(s.deps, bookingInput(), NOW);
  if (!r.ok || r.start.kind !== "redirect") throw new Error(JSON.stringify(r));
  const url = new URL(r.start.url);
  const raw: Record<string, string> = { ...Object.fromEntries(url.searchParams), ref: decodeURIComponent(url.pathname.split("/")[3]) };
  const check = (over: Record<string, string | undefined> = {}) => checkMockPayRequest(s.db, { secret: "s", origins: [BASE] }, { ...raw, ...over });
  return { ...s, code: r.code, raw, check };
}

test("the gateway signs its pay link, and a genuine link for the pending attempt passes", async () => {
  const { raw, check, code } = await started();
  expect(raw.sig).toMatch(/^[0-9a-f]{64}$/);
  expect(raw.order).toBe(`${code}-1`);
  expect(await check()).toEqual({
    ref: raw.ref, code, merchantOrderNo: `${code}-1`, amount: PAY_NOW,
    returnUrl: `${BASE}/en/book/return/${code}`, notifyUrl: `${BASE}/api/payments/notify`,
  });
});

test("a tampered or missing signature, or one made with another secret, gives 404", async () => {
  const { raw, check } = await started();
  const flipped = raw.sig.slice(0, -1) + (raw.sig.endsWith("0") ? "1" : "0");
  expect(await check({ sig: flipped })).toBeNull();
  expect(await check({ sig: "" })).toBeNull();
  expect(await check({ sig: undefined })).toBeNull();
  const fields = { ref: raw.ref, code: raw.code, merchantOrderNo: raw.order, amount: Number(raw.amount), returnUrl: raw.returnUrl, notifyUrl: raw.notifyUrl };
  expect(await check({ sig: await payLinkSignature("mock-secret", fields) })).toBeNull(); // the public default secret
  expect(await payLinkValid("s", fields, raw.sig)).toBe(true);
});

test("a wrong amount gives 404, even when re-signed for it (the charge row's amount must match)", async () => {
  const { raw, check } = await started();
  expect(await check({ amount: "1" })).toBeNull();
  expect(await check({ amount: String(PAY_NOW + 1) })).toBeNull();
  expect(await check({ amount: "-4000" })).toBeNull();
  const fields = { ref: raw.ref, code: raw.code, merchantOrderNo: raw.order, amount: 1, returnUrl: raw.returnUrl, notifyUrl: raw.notifyUrl };
  expect(await check({ amount: "1", sig: await payLinkSignature("s", fields) })).toBeNull();
});

test("a wrong order number gives 404, including a stale link after the payment was restarted", async () => {
  const { raw, check, code, db } = await started();
  expect(await check({ order: `${code}-2` })).toBeNull();
  const stale = { ref: raw.ref, code, merchantOrderNo: `${code}-2`, amount: PAY_NOW, returnUrl: raw.returnUrl, notifyUrl: raw.notifyUrl };
  expect(await check({ order: `${code}-2`, sig: await payLinkSignature("s", stale) })).toBeNull(); // signed, but not the current attempt
  await db.update(reservations).set({ chargeAttempt: 2 }).where(eq(reservations.code, code)); // a new attempt started
  expect(await check()).toBeNull(); // the old link (order -1) is dead
});

test("no pending attempt gives 404: paid, expired or unknown bookings", async () => {
  const { check, code, db } = await started();
  for (const status of ["confirmed", "expired", "cancelled"] as const) {
    await db.update(reservations).set({ status }).where(eq(reservations.code, code));
    expect(await check(), status).toBeNull();
  }
  const other = await started();
  expect(await other.check({ code: "NK-NOPE00" })).toBeNull(); // ref and code disagree
});

test("the notice the page signs carries the attempt's order number", async () => {
  const { headers, body } = await buildMockPayment({ secret: "s", ref: "MOCK-NK-1-0000abcd", code: "NK-1", merchantOrderNo: "NK-1-1", amount: 10, outcome: "failed" });
  expect(JSON.parse(body)).toMatchObject({ reservationCode: "NK-1", merchantOrderNo: "NK-1-1", status: "failed", amount: 10 });
  expect(headers[MOCK_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
});
