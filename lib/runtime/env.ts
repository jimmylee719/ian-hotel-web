import { getCloudflareContext } from "@opennextjs/cloudflare";

/** Vars and secrets this app reads (wrangler `vars`, secrets, or `.dev.vars` locally). */
export type AppEnv = {
  /** "local" (default wrangler env) or "production". Mock modes are accepted only when "local". */
  ENVIRONMENT?: string;
  PAYMENT_MODE?: string;
  CHANNEL_MODE?: string;
  MOCK_PAYMENT_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  STAFF_EMAILS?: string;
  BASE_URL?: string;
  /** Cloudflare Access team domain, e.g. "nkhostel.cloudflareaccess.com" (scheme optional). Unset = admin locked. */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag. Unset = admin locked. */
  CF_ACCESS_AUD?: string;
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
