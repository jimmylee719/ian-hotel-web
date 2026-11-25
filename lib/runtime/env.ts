import { getCloudflareContext } from "@opennextjs/cloudflare";

/** Vars and secrets this app reads (wrangler `vars`, secrets, or `.dev.vars` locally). */
export type AppEnv = {
  /**
   * "local" (default wrangler env), "staging" (env.staging) or "production" (env.production). Mock modes are
   * accepted only when "local"; staging and production also need BASE_URL, and their vendor endpoints are checked
   * against lib/runtime/config-guard.ts's host lists (anything else is treated as production there).
   */
  ENVIRONMENT?: string;
  PAYMENT_MODE?: string;
  CHANNEL_MODE?: string;
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
