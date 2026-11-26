import type { AppEnv } from "./env";
import { log } from "./log";

/**
 * Which hosts each vendor's endpoints may point at, by kind. Matched exactly (lowercase host, no port),
 * no wildcards. Empty until the vendor docs arrive: Task 3 fills SiteMinder's, Task 5 SinoPac's.
 * While a list is empty, every endpoint of that vendor is refused in that environment (fails closed).
 */
export type VendorHosts = { production: string[]; sandbox: string[] };
/** SITEMINDER-OPEN-Q3: which pre-production and production reservation hosts are correct (doc §7 Q3). */
export const SITEMINDER_HOSTS: VendorHosts = { production: [], sandbox: [] };
export const SINOPAC_HOSTS: VendorHosts = { production: [], sandbox: [] };

const VENDORS = { SITEMINDER: SITEMINDER_HOSTS, SINOPAC: SINOPAC_HOSTS } as const;

/**
 * The vendor endpoint settings checked: every var or secret named `SITEMINDER_…ENDPOINT` / `SINOPAC_…ENDPOINT`
 * (or `…_URL`), e.g. SITEMINDER_ENDPOINT, SINOPAC_ENDPOINT, SINOPAC_QUERY_ENDPOINT. A name the adapters add later
 * is covered without touching this file. Unset or empty ones are skipped.
 */
const ENDPOINT_NAME = /^(SITEMINDER|SINOPAC)_(?:[A-Z0-9_]*_)?(?:ENDPOINT|URL)$/;

/** Thrown by assertConfig. The message lists every reason; it names settings, never their values. */
export class ConfigRefusedError extends Error {
  constructor(readonly reasons: string[]) {
    super(`CONFIG_REFUSED: ${reasons.join("; ")}`);
    this.name = "ConfigRefusedError";
  }
}

/** Any SiteMinder or SinoPac setting (endpoints, credentials, codes): the preview may have none of them. */
const VENDOR_SETTING = /^(SITEMINDER|SINOPAC)_/;

/**
 * Why this environment's config must not run at all, or null when it may. Rules (ENVIRONMENT, trimmed):
 * - "local": anything goes (wrangler dev, tests, the mock pay page).
 * - "preview" (the owner's public, labelled test site): mock is the only mode. A PAYMENT_MODE / CHANNEL_MODE other
 *   than "mock" is refused (unset is allowed: booking then simply stays off), and so is every SITEMINDER_… /
 *   SINOPAC_… setting that is set, endpoint or not, so the preview can never reach a real gateway or channel.
 * - "staging": no mock mode; every vendor endpoint must be https on that vendor's sandbox list (never production).
 * - "production", and anything else (unset or mistyped, e.g. "Preview", is treated as production: fails closed):
 *   no mock mode; every vendor endpoint must be https on that vendor's production list.
 */
export function configRefusal(env: AppEnv & Record<string, unknown>): string | null {
  const environment = env.ENVIRONMENT?.trim();
  if (environment === "local") return null;
  if (environment === "preview") return previewRefusal(env);
  const kind: keyof VendorHosts = environment === "staging" ? "sandbox" : "production";
  const label = environment || "(unset)";
  const reasons: string[] = [];
  if (env.PAYMENT_MODE?.trim() === "mock" || env.CHANNEL_MODE?.trim() === "mock")
    reasons.push(`MOCK_MODE_REFUSED: a mock mode is set with ENVIRONMENT=${label}`);
  for (const name of Object.keys(env).sort()) {
    const m = ENDPOINT_NAME.exec(name);
    const value = env[name];
    if (!m || typeof value !== "string" || value.trim() === "") continue;
    const hosts = VENDORS[m[1] as keyof typeof VENDORS];
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      reasons.push(`ENDPOINT_INVALID: ${name} is not a URL`);
      continue;
    }
    if (url.protocol !== "https:") {
      reasons.push(`ENDPOINT_NOT_HTTPS: ${name} must use https`);
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (kind === "sandbox" && hosts.production.includes(host)) {
      reasons.push(`ENDPOINT_PRODUCTION_IN_STAGING: ${name} points at a production host (${host})`);
    } else if (!hosts[kind].includes(host)) {
      reasons.push(`ENDPOINT_NOT_ALLOWED: ${name} host ${host} is not on the ${m[1]} ${kind} list (ENVIRONMENT=${label})`);
    }
  }
  return reasons.length ? new ConfigRefusedError(reasons).message : null;
}

/** configRefusal for ENVIRONMENT=preview: mock modes only, and no vendor settings at all. */
function previewRefusal(env: AppEnv & Record<string, unknown>): string | null {
  const reasons: string[] = [];
  for (const name of ["PAYMENT_MODE", "CHANNEL_MODE"] as const) {
    const mode = env[name]?.trim();
    if (mode && mode !== "mock") reasons.push(`REAL_MODE_IN_PREVIEW: ${name} must be mock with ENVIRONMENT=preview`);
  }
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (VENDOR_SETTING.test(name) && typeof value === "string" && value.trim() !== "")
      reasons.push(`VENDOR_SETTING_IN_PREVIEW: ${name} must not be set with ENVIRONMENT=preview`);
  }
  return reasons.length ? new ConfigRefusedError(reasons).message : null;
}

/**
 * Throws ConfigRefusedError when the config must not run (configRefusal). Called at every entry point: each
 * request (worker.ts through withConfigGuard → 503) and each cron trigger (lib/jobs/cron.ts → skipped, logged,
 * recorded in job_runs, ops alerted).
 */
export function assertConfig(env: AppEnv & Record<string, unknown>): void {
  const reason = configRefusal(env);
  if (reason) throw new ConfigRefusedError(reason.replace(/^CONFIG_REFUSED: /, "").split("; "));
}

type FetchHandler<E, C> = (request: Request, env: E, ctx: C) => Response | Promise<Response>;

/**
 * Wrap the Worker's fetch handler: a refused config answers 503 (Retry-After 300) to every request without
 * running the app, and logs why. The response body names no setting. This is the single request choke point:
 * worker.ts's fetch receives `env` directly and sees every request that reaches the Worker (pages, /api, /admin,
 * /media); Next's middleware skips /api, /admin, /dev and /media, and getDeps runs only on booking routes.
 */
export function withConfigGuard<E, C>(fetch: FetchHandler<E, C>): FetchHandler<E, C> {
  return (request, env, ctx) => {
    const reason = configRefusal(env as AppEnv & Record<string, unknown>);
    if (reason) {
      log.error(`request refused: ${reason}`);
      return new Response("Service temporarily unavailable (CONFIG_REFUSED)", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "300", "cache-control": "no-store" },
      });
    }
    return fetch(request, env, ctx);
  };
}
