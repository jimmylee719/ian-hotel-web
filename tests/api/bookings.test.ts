import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  handleBookingStatus, handleCancelBooking, handleCreateBooking, handleNotify, handleQuote,
} from "@/lib/api/bookings";
import { promoCodes, reservations } from "@/lib/db/schema";
import { addons } from "@/lib/db/schema";
import { bookingInput, bookingSetup, NOW, PAY_NOW } from "@/tests/helpers/booking";

const post = (path: string, body: unknown, ip = "1.1.1.1") =>
  new Request(`https://hotel.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const get = (path: string, ip = "1.1.1.1") => new Request(`https://hotel.test${path}`, { headers: { "cf-connecting-ip": ip } });

describe("POST /api/bookings", () => {
  test("missing fields are a 400", async () => {
    const { deps } = await bookingSetup();
    const { guest: _g, ...noGuest } = bookingInput();
    const res = await handleCreateBooking(deps, post("/api/bookings", noGuest), NOW);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "INVALID_INPUT" });
  });

  test("a body that is not JSON is a 400", async () => {
    const { deps } = await bookingSetup();
    expect((await handleCreateBooking(deps, post("/api/bookings", "{oops"), NOW)).status).toBe(400);
  });

  test("a valid booking returns 200 with the code and how to start the payment", async () => {
    const { deps, reservation } = await bookingSetup();
    const res = await handleCreateBooking(deps, post("/api/bookings", bookingInput()), NOW);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; start: { kind: string; url: string } };
    expect(body.code).toMatch(/^NK-/);
    expect(body.start.kind).toBe("redirect");
    expect(new URL(body.start.url).searchParams.get("amount")).toBe(String(PAY_NOW));
    expect((await reservation(body.code)).status).toBe("pending_payment");
  });

  test("a sold-out room is a 409", async () => {
    const { deps } = await bookingSetup({ available: 0 });
    const res = await handleCreateBooking(deps, post("/api/bookings", bookingInput()), NOW);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "NOT_AVAILABLE" });
  });

  test("the 6th request from one IP within a minute is a 429", async () => {
    const { deps } = await bookingSetup({ available: 10 });
    for (let i = 0; i < 5; i++) {
      const r = await handleCreateBooking(deps, post("/api/bookings", bookingInput({ idempotencyKey: `key-rate-${i}-abcdef` })), NOW);
      expect(r.status).toBe(200);
    }
    const sixth = await handleCreateBooking(deps, post("/api/bookings", bookingInput({ idempotencyKey: "key-rate-6-abcdef" })), NOW);
    expect(sixth.status).toBe(429);
    // Another IP is not affected.
    const other = await handleCreateBooking(deps, post("/api/bookings", bookingInput({ idempotencyKey: "key-rate-7-abcdef" }), "2.2.2.2"), NOW);
    expect(other.status).toBe(200);
  });
});

describe("GET /api/bookings/[code]/status", () => {
  test("a wrong email is a 404; the right one (any case) returns the status", async () => {
    const { deps, book } = await bookingSetup();
    const code = await book();
    expect((await handleBookingStatus(deps.db, code, get(`/api/bookings/${code}/status?email=other@example.com`), NOW)).status).toBe(404);
    expect((await handleBookingStatus(deps.db, code, get(`/api/bookings/${code}/status`), NOW)).status).toBe(404);
    const res = await handleBookingStatus(deps.db, code, get(`/api/bookings/${code}/status?email=MEI@example.com`), NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ code, status: "pending_payment", adults: 2, children: 0, rooms: 1, lastPaymentFailed: false });
  });

  test("a failed payment attempt is reported while the booking is still payable", async () => {
    const { deps, book, gateway } = await bookingSetup();
    const code = await book();
    await handleNotify(deps, notifyReq(await gateway.signedNotice({
      reservationCode: code, providerRef: `REF-FAIL-${code}`, amount: PAY_NOW, status: "failed",
    })), NOW);
    const res = await handleBookingStatus(deps.db, code, get(`/api/bookings/${code}/status?email=mei@example.com`), NOW);
    expect(await res.json()).toMatchObject({ status: "pending_payment", lastPaymentFailed: true });
  });

  test("the 11th lookup from one IP within a minute is a 429", async () => {
    const { deps, book } = await bookingSetup();
    const code = await book();
    for (let i = 0; i < 10; i++)
      expect((await handleBookingStatus(deps.db, code, get(`/api/bookings/${code}/status?email=mei@example.com`), NOW)).status).toBe(200);
    expect((await handleBookingStatus(deps.db, code, get(`/api/bookings/${code}/status?email=mei@example.com`), NOW)).status).toBe(429);
  });
});

const notifyReq = (n: { headers: Record<string, string>; body: string }) =>
  new Request("https://hotel.test/api/payments/notify", { method: "POST", headers: n.headers, body: n.body });

describe("POST /api/payments/notify", () => {
  test("a correctly signed notice is a 200 and confirms the booking", async () => {
    const { deps, book, notice, reservation } = await bookingSetup();
    const code = await book();
    const res = await handleNotify(deps, notifyReq(await notice(code)), NOW);
    expect(res.status).toBe(200);
    expect((await reservation(code)).status).toBe("confirmed");
  });

  test("a tampered notice is a 400 and changes nothing", async () => {
    const { deps, book, notice, reservation } = await bookingSetup();
    const code = await book();
    const n = await notice(code);
    const tampered = { ...n, body: n.body.replace(String(PAY_NOW), "1") };
    const res = await handleNotify(deps, notifyReq(tampered), NOW);
    expect(res.status).toBe(400);
    expect((await reservation(code)).status).toBe("pending_payment");
  });
});

describe("POST /api/bookings/[code]/cancel", () => {
  test("cancels a confirmed booking and reports the refund; a repeat says it is already cancelled", async () => {
    const { deps, book, notice, reservation } = await bookingSetup();
    const code = await book();
    await handleNotify(deps, notifyReq(await notice(code)), NOW);
    const res = await handleCancelBooking(deps, code, post(`/api/bookings/${code}/cancel`, { email: "mei@example.com" }), NOW);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refunded: PAY_NOW, alreadyCancelled: false });
    expect((await reservation(code)).status).toBe("cancelled");
    const again = await handleCancelBooking(deps, code, post(`/api/bookings/${code}/cancel`, { email: "mei@example.com" }), NOW);
    expect(await again.json()).toEqual({ refunded: PAY_NOW, alreadyCancelled: true });
  });

  test("wrong email is 404; an unpaid booking is 409 NOT_CANCELLABLE", async () => {
    const { deps, book } = await bookingSetup();
    const code = await book();
    expect((await handleCancelBooking(deps, code, post(`/api/bookings/${code}/cancel`, { email: "x@example.com" }), NOW)).status).toBe(404);
    const res = await handleCancelBooking(deps, code, post(`/api/bookings/${code}/cancel`, { email: "mei@example.com" }), NOW);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "NOT_CANCELLABLE" });
  });

  test("a refund the gateway refuses is a 502 REFUND_FAILED", async () => {
    const { deps, book, notice } = await bookingSetup({ failRefund: true });
    const code = await book();
    await handleNotify(deps, notifyReq(await notice(code)), NOW);
    const res = await handleCancelBooking(deps, code, post(`/api/bookings/${code}/cancel`, { email: "mei@example.com" }), NOW);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "REFUND_FAILED" });
  });

  test("the 11th cancel request from one IP within a minute is a 429", async () => {
    const { deps } = await bookingSetup();
    for (let i = 0; i < 10; i++)
      expect((await handleCancelBooking(deps, "NK-XXXXXX", post("/api/bookings/NK-XXXXXX/cancel", { email: "a@b.co" }), NOW)).status).toBe(404);
    expect((await handleCancelBooking(deps, "NK-XXXXXX", post("/api/bookings/NK-XXXXXX/cancel", { email: "a@b.co" }), NOW)).status).toBe(429);
  });
});

describe("POST /api/quote", () => {
  const quoteBody = (over: Record<string, unknown> = {}) => {
    const { guest: _g, idempotencyKey: _k, acceptTerms: _a, locale: _l, ...rest } = bookingInput();
    return { ...rest, ...over };
  };

  test("prices the stay exactly as createReservation would, add-ons and promo included", async () => {
    const { deps, db, propertyId, reservation } = await bookingSetup();
    await db.insert(addons).values({
      id: crypto.randomUUID(), propertyId, slug: "breakfast", name: { "zh-TW": "早餐", en: "Breakfast", ja: "朝食", ko: "조식" },
      price: 250, unit: "per_person_night", active: true,
    });
    await db.insert(promoCodes).values({ id: crypto.randomUUID(), propertyId, code: "WELCOME10", kind: "percent", value: 10, active: true });
    const over = { addons: [{ slug: "breakfast", qty: 1 }], promoCode: "welcome10" };
    const res = await handleQuote(deps.db, post("/api/quote", quoteBody(over)), NOW);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quote: { total: number; discount: number; addonSubtotal: number }; promo: string };
    expect(body.promo).toBe("applied");
    expect(body.quote).toMatchObject({ discount: 400, addonSubtotal: 1000, total: 4000 - 400 + 1000 });

    const created = await handleCreateBooking(deps, post("/api/bookings", bookingInput(over)), NOW);
    const { code } = (await created.json()) as { code: string };
    expect((await reservation(code)).quote).toEqual(body.quote);
  });

  test("an invalid promo code still returns the undiscounted quote, flagged invalid", async () => {
    const { deps } = await bookingSetup();
    const res = await handleQuote(deps.db, post("/api/quote", quoteBody({ promoCode: "NOPE" })), NOW);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ promo: "invalid", quote: { discount: 0, total: 4000 } });
  });

  test("a room that is no longer available is a 409; bad input is a 400", async () => {
    const { deps } = await bookingSetup({ available: 0 });
    expect((await handleQuote(deps.db, post("/api/quote", quoteBody()), NOW)).status).toBe(409);
    expect((await handleQuote(deps.db, post("/api/quote", quoteBody({ adults: 0 })), NOW)).status).toBe(400);
  });
});

test("promo codes match case-insensitively when booking", async () => {
  const { deps, db, propertyId } = await bookingSetup();
  await db.insert(promoCodes).values({ id: crypto.randomUUID(), propertyId, code: "WELCOME10", kind: "percent", value: 10, active: true });
  const res = await handleCreateBooking(deps, post("/api/bookings", bookingInput({ promoCode: " welcome10 " })), NOW);
  expect(res.status).toBe(200);
  const { code } = (await res.json()) as { code: string };
  const [r] = await db.select().from(reservations).where(eq(reservations.code, code));
  expect(r.promoCode).toBe("WELCOME10");
  expect(r.totalAmount).toBe(3600);
});

test("children count toward a room's occupancy when booking", async () => {
  const { deps } = await bookingSetup();
  // mixed-cube sleeps 2: 2 adults + 1 child does not fit in one room.
  const res = await handleCreateBooking(deps, post("/api/bookings", bookingInput({ children: 1 })), NOW);
  expect(res.status).toBe(409);
  // In two rooms it does.
  const ok = await handleCreateBooking(deps, post("/api/bookings", bookingInput({ children: 1, rooms: 2, idempotencyKey: "key-kids-2-abcdef" })), NOW);
  expect(ok.status).toBe(200);
});
