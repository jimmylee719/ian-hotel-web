import { getCloudflareContext } from "@opennextjs/cloudflare";

/** Vars and secrets this app reads (wrangler `vars`, secrets, or `.dev.vars` locally). */
export type AppEnv = {
  /**
   * "local" (default wrangler env), "preview" (env.preview, the owner's public test site on workers.dev), "staging"
   * (env.staging) or "production" (env.production). Mock modes are accepted only when exactly "local" or "preview"
   * (isMockEnvironment); in "preview" they are the only modes allowed and no vendor setting may be set
   * (lib/runtime/config-guard.ts). Staging and production also need BASE_URL, and their vendor endpoints are checked
   * against config-guard's host lists (anything else, unset or mistyped, is treated as production there).
   */
  ENVIRONMENT?: string;
  PAYMENT_MODE?: string;
  CHANNEL_MODE?: string;
  /** Signs the mock gateway's notices (the gateway and /dev/pay share it). Required in "preview" (a wrangler secret). */
  MOCK_PAYMENT_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  STAFF_EMAILS?: string;
  /** Comma-separated: who gets the ops alerts (lib/ops/alerts.ts). Unset = alerts are only logged. */
  OPS_EMAILS?: string;
  BASE_URL?: string;
  /**
   * "false" closes new guest bookings (the booking pages show the 建置中 notice and POST /api/bookings answers 503)
   * even when payments are configured: a public preview of the site. Payment notices, cancels, staff paths and the
   * reconcile jobs keep working. Unset = open whenever payments are configured.
   */
  BOOKING_OPEN?: string;
  /** Cloudflare Access team domain, e.g. "nkhostel.cloudflareaccess.com" (scheme optional). Unset = admin locked. */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag. Unset = admin locked. */
  CF_ACCESS_AUD?: string;
  /**
   * Vendor endpoints (Tasks 3 and 5 decide which ones each adapter reads). Every SITEMINDER_…ENDPOINT /
   * SINOPAC_…ENDPOINT (or …_URL) var that is set is checked by assertConfig against the vendor's host list.
   */
  SITEMINDER_ENDPOINT?: string;
  SINOPAC_ENDPOINT?: string;
  /** Local dev only (ENVIRONMENT=local): act as this staff email without an Access JWT. */
  DEV_STAFF_EMAIL?: string;
};

/** The environments where the mock payment and channel modes may run. Matched exactly ("Preview" is not one). */
export const MOCK_ENVIRONMENTS = ["local", "preview"] as const;

export function isMockEnvironment(environment: string | undefined): boolean {
  return (MOCK_ENVIRONMENTS as readonly (string | undefined)[]).includes(environment);
}

/**
 * Is this a test copy of the site, whose bookings and payments are simulated? True when PAYMENT_MODE is "mock" in a
 * mock environment (local dev or the public preview): the pages then carry the 測試用 labels, the /dev/pay page
 * exists and email subjects start with 【測試】. Never true in staging or production (mock modes are refused there).
 */
export function isTestSite(env: Pick<AppEnv, "PAYMENT_MODE" | "ENVIRONMENT">): boolean {
  return env.PAYMENT_MODE === "mock" && isMockEnvironment(env.ENVIRONMENT);
}

/**
 * The Worker's env for the current request. Outside the Workers runtime (unit tests, scripts)
 * there is no Cloudflare context, so fall back to process.env.
 */
export async function appEnv(): Promise<AppEnv & { DB?: D1Database; WORKER_SELF_REFERENCE?: Fetcher }> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    return env as unknown as AppEnv & { DB: D1Database; WORKER_SELF_REFERENCE?: Fetcher };
  } catch {
    return process.env as AppEnv;
  }
}
