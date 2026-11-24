import { getCloudflareContext } from "@opennextjs/cloudflare";

/** Vars and secrets this app reads (wrangler `vars`, secrets, or `.dev.vars` locally). */
export type AppEnv = {
  PAYMENT_MODE?: string;
  CHANNEL_MODE?: string;
  MOCK_PAYMENT_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  STAFF_EMAILS?: string;
  BASE_URL?: string;
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
