import { routing } from "@/i18n/routing";
import { isTestSite } from "@/lib/runtime/env";
import { MockSinoPacGateway } from "./mock-sinopac";

/** Signing secret when MOCK_PAYMENT_SECRET is not set (mock mode only; the gateway and the pay page share it). */
export const MOCK_DEFAULT_SECRET = "mock-secret";

/**
 * The mock pay page exists only when PAYMENT_MODE is "mock" and ENVIRONMENT is exactly "local" or "preview"
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

/** Build the signed notice the mock pay page POSTs to notifyUrl. */
export async function buildMockPayment(p: {
  secret: string;
  ref: string;
  code: string;
  amount: number;
  outcome: "succeeded" | "failed";
}) {
  const gw = new MockSinoPacGateway({ secret: p.secret, baseUrl: "http://localhost" });
  return gw.signedNotice({
    reservationCode: p.code,
    providerRef: p.ref,
    amount: p.amount,
    status: p.outcome,
    ...(p.outcome === "succeeded" ? { authCode: "000000", last4: "4242" } : {}),
  });
}
