import { and, eq } from "drizzle-orm";
import { routing } from "@/i18n/routing";
import { payments, reservations } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { isTestSite } from "@/lib/runtime/env";
import { MockSinoPacGateway, payLinkValid } from "./mock-sinopac";

/** Signing secret when MOCK_PAYMENT_SECRET is not set (mock mode only; the gateway and the pay page share it). */
export const MOCK_DEFAULT_SECRET = "mock-secret";

/**
 * The mock pay page exists only when PAYMENT_MODE is "mock" and ENVIRONMENT is "local" or "preview" (trimmed)
 * (isTestSite): the same rule bookingDisabledReason (lib/runtime/deps.ts) applies to the mock modes, so /dev/pay
 * 404s on any other environment, including staging, production and an unset or mistyped ENVIRONMENT.
 */
export function isMockPaymentMode(
  env: { PAYMENT_MODE?: string; ENVIRONMENT?: string } = process.env as { PAYMENT_MODE?: string; ENVIRONMENT?: string },
): boolean {
  return isTestSite(env);
}

/** The only path the mock pay page may POST its notice to (app/api/payments/notify). */
export const MOCK_NOTIFY_PATH = "/api/payments/notify";

/**
 * The origins the mock pay page may send the guest back to or post its notice to: BASE_URL's when set (the preview,
 * staging, production), else the request's own (local dev). Empty when neither is a valid http(s) URL.
 */
export function mockPayOrigins(baseUrl: string | undefined, requestOrigin: string | undefined): string[] {
  for (const candidate of [baseUrl, requestOrigin]) {
    if (!candidate) continue;
    try {
      const u = new URL(candidate);
      if (u.protocol === "https:" || u.protocol === "http:") return [u.origin];
    } catch {
      // not a URL: try the next one
    }
    return [];
  }
  return [];
}

/**
 * Are the pay page's notifyUrl and returnUrl this site's own? notifyUrl must be exactly `<origin>/api/payments/notify`
 * and returnUrl `<origin>/<locale>/book/return/<code>` for this booking's code, both on an allowed origin, with no
 * credentials, query or fragment. The page is public on the preview, so this stops it from being used to POST signed
 * notices elsewhere or as an open redirect.
 */
export function mockPayTargetsValid(
  p: { notifyUrl: string; returnUrl: string; code: string },
  origins: string[],
): boolean {
  const parse = (raw: string) => {
    try {
      const u = new URL(raw);
      return origins.includes(u.origin) && !u.username && !u.password && !u.search && !u.hash ? u : null;
    } catch {
      return null;
    }
  };
  const notify = parse(p.notifyUrl);
  const back = parse(p.returnUrl);
  if (!notify || notify.pathname !== MOCK_NOTIFY_PATH || !back) return false;
  const m = /^\/([^/]+)\/book\/return\/([^/]+)$/.exec(back.pathname);
  return !!m && (routing.locales as readonly string[]).includes(m[1]) && m[2] === encodeURIComponent(p.code) && p.code.length > 0;
}

/** Recover the reservation code from a ref shaped MOCK-<code>-<8 hex>. */
export function reservationCodeFromRef(ref: string): string | null {
  const m = /^MOCK-(.+)-[0-9a-f]{8}$/.exec(ref);
  return m ? m[1] : null;
}

/** A pay request the mock pay page may act on (checkMockPayRequest). */
export type MockPayRequest = { ref: string; code: string; merchantOrderNo: string; amount: number; returnUrl: string; notifyUrl: string };

/**
 * Every check the public mock pay page makes, on the page and again in its action, before it shows the buttons or
 * signs a notice; null (the caller 404s) on any failure:
 * - the link's `sig` is the gateway's HMAC over ref|code|order|amount|returnUrl|notifyUrl (constant-time compare),
 *   so only a link MockSinoPacGateway.startCharge made for this booking works, not one built from a guessed code;
 * - ref carries the code, the amount is a whole number, both URLs are this site's own (mockPayTargetsValid);
 * - the booking still awaits payment, `order` is its current attempt (`<code>-<chargeAttempt>`), and its charge row
 *   has this amount and is not already paid: a stale or replayed link cannot mark anything paid or failed.
 */
export async function checkMockPayRequest(
  db: Db,
  o: { secret: string; origins: string[] },
  raw: { ref?: string; code?: string; order?: string; amount?: string; returnUrl?: string; notifyUrl?: string; sig?: string },
): Promise<MockPayRequest | null> {
  const { ref = "", code = "", order = "", returnUrl = "", notifyUrl = "", sig = "" } = raw;
  if (!code || !order || !sig || reservationCodeFromRef(ref) !== code || !/^\d{1,9}$/.test(raw.amount ?? "")) return null;
  const amount = Number(raw.amount);
  if (!mockPayTargetsValid({ notifyUrl, returnUrl, code }, o.origins)) return null;
  const p = { ref, code, merchantOrderNo: order, amount, returnUrl, notifyUrl };
  if (!(await payLinkValid(o.secret, p, sig))) return null;
  const [res] = await db.select().from(reservations).where(eq(reservations.code, code));
  if (!res || res.status !== "pending_payment" || order !== `${code}-${res.chargeAttempt}`) return null;
  const charges = await db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "charge")));
  if (!charges.some((c) => c.amount === amount && c.status !== "succeeded")) return null;
  return p;
}

/** Build the signed notice the mock pay page POSTs to notifyUrl (with the attempt's order number). */
export async function buildMockPayment(p: {
  secret: string;
  ref: string;
  code: string;
  merchantOrderNo?: string;
  amount: number;
  outcome: "succeeded" | "failed";
}) {
  const gw = new MockSinoPacGateway({ secret: p.secret, baseUrl: "http://localhost" });
  return gw.signedNotice({
    reservationCode: p.code,
    providerRef: p.ref,
    amount: p.amount,
    status: p.outcome,
    ...(p.merchantOrderNo ? { merchantOrderNo: p.merchantOrderNo } : {}),
    ...(p.outcome === "succeeded" ? { authCode: "000000", last4: "4242" } : {}),
  });
}
