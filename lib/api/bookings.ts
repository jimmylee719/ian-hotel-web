import { and, eq } from "drizzle-orm";
import { createReservation, type CreateError, type CreateInput } from "@/lib/booking/create";
import { cancelReservation, findReservation } from "@/lib/booking/manage";
import type { Deps } from "@/lib/booking/notify";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { PriceInput, priceStay } from "@/lib/booking/pricing";
import { payments, reservations } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { checkRate, clientIp, isLimited, RATE, retryAfterSec, tooManyRequests } from "./rate-limit";

/**
 * Booking API handlers. Each takes its dependencies, the Request and the time, and returns a
 * Response, so it can be tested without the Workers runtime; app/api/**\/route.ts only adapts.
 */

const MAX_BODY = 20_000;
const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function readJson(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  const text = await req.text().catch(() => "");
  if (text.length > MAX_BODY) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const CREATE_STATUS: Record<CreateError, number> = {
  INVALID_INPUT: 400,
  PROMO_INVALID: 400,
  NOT_AVAILABLE: 409,
  SOLD_OUT: 409,
  PRICE_CHANGED: 409,
};

/** POST /api/bookings → 200 `{ code, start }`; the client follows `start` to the payment page. */
export async function handleCreateBooking(deps: Deps, req: Request, now: Date): Promise<Response> {
  if (!(await checkRate(deps.db, `create:${clientIp(req)}`, RATE.create, 60, now))) return tooManyRequests(retryAfterSec(60, now));
  const body = await readJson(req);
  if (!body || typeof body !== "object") return json(400, { error: "INVALID_INPUT" });
  const r = await createReservation(deps, body as CreateInput, now); // validated inside
  if (!r.ok)
    return json(CREATE_STATUS[r.error], { error: r.error, ...(r.detail ? { detail: r.detail } : {}), ...(r.code ? { code: r.code } : {}) });
  return json(200, { code: r.code, start: r.start });
}

export type PaymentState = "succeeded" | "failed" | "pending";

/**
 * GET /api/bookings/[code]/status?email= → the guest's view of the booking plus `paymentState`:
 * "succeeded" if any charge succeeded; "failed" if a charge failed at or after the latest payment
 * start (so a retry is "pending" until its own result arrives); otherwise "pending".
 *
 * Limits: a lookup that finds nothing counts against the IP (10/min, the enumeration guard), and once
 * that is used up every lookup from the IP is refused for the rest of the window. A lookup that finds
 * the booking counts against IP + code (60/min), so the return page's polling has its own budget.
 */
export async function handleBookingStatus(db: Db, code: string, req: Request, now: Date): Promise<Response> {
  const ip = clientIp(req);
  const failedKey = `lookup-failed:${ip}`;
  if (await isLimited(db, failedKey, RATE.lookupFailed, 60, now)) return tooManyRequests(retryAfterSec(60, now));
  const email = new URL(req.url).searchParams.get("email") ?? "";
  const view = email ? await findReservation(db, code, email, now) : null;
  if (!view) {
    if (!(await checkRate(db, failedKey, RATE.lookupFailed, 60, now))) return tooManyRequests(retryAfterSec(60, now));
    return json(404, { error: "NOT_FOUND" });
  }
  if (!(await checkRate(db, `lookup:${ip}:${view.code}`, RATE.lookupBooking, 60, now))) return tooManyRequests(retryAfterSec(60, now));
  return json(200, { ...view, paymentState: await paymentState(db, view.code) });
}

async function paymentState(db: Db, code: string): Promise<PaymentState> {
  const [res] = await db.select({ id: reservations.id, startedAt: reservations.lastChargeStartedAt })
    .from(reservations).where(eq(reservations.code, code));
  const charges = await db.select({ status: payments.status, createdAt: payments.createdAt }).from(payments)
    .where(and(eq(payments.reservationId, res.id), eq(payments.kind, "charge")));
  if (charges.some((c) => c.status === "succeeded")) return "succeeded";
  const since = res.startedAt ?? 0;
  return charges.some((c) => c.status === "failed" && c.createdAt >= since) ? "failed" : "pending";
}

/** POST /api/bookings/[code]/cancel `{ email }`. */
export async function handleCancelBooking(deps: Deps, code: string, req: Request, now: Date): Promise<Response> {
  if (!(await checkRate(deps.db, `cancel:${clientIp(req)}`, RATE.cancel, 60, now))) return tooManyRequests(retryAfterSec(60, now));
  const body = (await readJson(req)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email : "";
  if (!email) return json(404, { error: "NOT_FOUND" });
  const r = await cancelReservation(deps, code, email, now);
  if (r.ok) {
    const desk = r.frontDeskRefundDue ? { frontDeskRefundDue: r.frontDeskRefundDue } : {};
    return json(200, { refunded: r.refunded, ...desk, alreadyCancelled: r.alreadyCancelled });
  }
  const status = r.error === "NOT_FOUND" ? 404 : r.error === "NOT_CANCELLABLE" ? 409 : 502;
  return json(status, { error: r.error });
}

/** A payment notice is a few hundred bytes; anything over this is refused before it touches the database. */
export const MAX_NOTIFY_BODY = 16 * 1024;

/** The body as text, or null once it is (declared or actually) over `max` bytes; stops reading there. */
async function readCappedText(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** POST /api/payments/notify: the payment provider's server-to-server notice. Over 16 KB → 413, unlogged. */
export async function handleNotify(deps: Deps, req: Request, now: Date): Promise<Response> {
  const body = await readCappedText(req, MAX_NOTIFY_BODY);
  if (body === null) return new Response("PAYLOAD_TOO_LARGE", { status: 413, headers: { "Cache-Control": "no-store" } });
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const r = await handlePaymentNotice(deps, { headers, body }, now);
  return new Response(r.status === 200 ? "OK" : "BAD_REQUEST", { status: r.status, headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/quote: the price the details page shows, computed exactly as createReservation will.
 * An invalid promo code is not an error here: the undiscounted quote comes back with `promo: "invalid"`.
 */
export async function handleQuote(db: Db, req: Request, now: Date): Promise<Response> {
  if (!(await checkRate(db, `quote:${clientIp(req)}`, RATE.quote, 60, now))) return tooManyRequests(retryAfterSec(60, now));
  const parsed = PriceInput.safeParse(await readJson(req));
  if (!parsed.success) return json(400, { error: "INVALID_INPUT" });
  const input = parsed.data;
  let r = await priceStay(db, input, now);
  let promo: "none" | "applied" | "invalid" = input.promoCode?.trim() ? "applied" : "none";
  if (!r.ok && r.error === "PROMO_INVALID") {
    promo = "invalid";
    r = await priceStay(db, { ...input, promoCode: undefined }, now);
  }
  if (!r.ok) return json(r.error === "NOT_AVAILABLE" ? 409 : 400, { error: r.error });
  return json(200, { quote: r.priced.quote, promo });
}
