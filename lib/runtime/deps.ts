import type { Deps } from "@/lib/booking/notify";
import { MockChannelManager } from "@/lib/channel/mock";
import type { ChannelManager } from "@/lib/channel/types";
import { getDb } from "@/lib/db/client";
import type { Db } from "@/lib/db/types";
import { MockEmailSender } from "@/lib/email/mock";
import { ResendEmailSender } from "@/lib/email/resend";
import type { EmailSender } from "@/lib/email/types";
import { MOCK_DEFAULT_SECRET } from "@/lib/payments/mock-page";
import { MockSinoPacGateway } from "@/lib/payments/mock-sinopac";
import type { PaymentGateway } from "@/lib/payments/types";
import type { OpsDeps } from "@/lib/ops/alerts";
import { appEnv, type AppEnv } from "./env";
import { log } from "./log";

/**
 * Thrown when online booking is switched off: PAYMENT_MODE or CHANNEL_MODE is unset (production before
 * SinoPac / SiteMinder are configured), or a mock mode is set outside ENVIRONMENT=local. Routes turn
 * it into a 503; pages show the "booking coming soon" notice. The message is the reason code, so logs say why.
 */
export class BookingDisabledError extends Error {
  constructor(readonly reason: string = "PAYMENT_MODE_NOT_SET") {
    super(reason);
    this.name = "BookingDisabledError";
  }
}

/**
 * Why online booking must stay off, or null if it may run. Fails closed: both modes must be set, and
 * the mock modes are accepted only when ENVIRONMENT === "local" (wrangler.jsonc sets it for the default
 * env; env.staging / env.production set "staging" / "production"), so mock payments can never serve a
 * public host; and staging and production need BASE_URL. (The reason code keeps its historical name.)
 */
export function bookingDisabledReason(env: AppEnv): string | null {
  if (!env.PAYMENT_MODE) return "PAYMENT_MODE_NOT_SET";
  if (!env.CHANNEL_MODE) return "CHANNEL_MODE_NOT_SET";
  if ((env.PAYMENT_MODE === "mock" || env.CHANNEL_MODE === "mock") && env.ENVIRONMENT !== "local") return "MOCK_MODE_IN_PRODUCTION";
  return baseUrlMissingReason(env);
}

/**
 * Production and staging must name their public origin: links in emails and the gateway's return/notify URLs
 * are built from BASE_URL, and the cron has no request origin to fall back on (only localhost).
 */
export function baseUrlMissingReason(env: AppEnv): string | null {
  return (env.ENVIRONMENT === "production" || env.ENVIRONMENT === "staging") && !env.BASE_URL ? "BASE_URL_NOT_SET" : null;
}

/** Is online booking on? */
export function paymentsConfigured(env: AppEnv): boolean {
  return bookingDisabledReason(env) === null;
}

/**
 * Can guests start a new booking? Payments must be configured and BOOKING_OPEN must not be "false". In `next dev`
 * the switch may also come from the shell (`BOOKING_OPEN=false npm run dev`), since wrangler vars and .dev.vars
 * are the only things in the Cloudflare context there.
 */
export function guestBookingOpen(env: AppEnv, shell: { BOOKING_OPEN?: string } = {}): boolean {
  if ((env.BOOKING_OPEN ?? shell.BOOKING_OPEN) === "false") return false;
  return paymentsConfigured(env);
}

export async function bookingEnabled(): Promise<boolean> {
  return guestBookingOpen(await appEnv(), { BOOKING_OPEN: typeof process === "undefined" ? undefined : process.env.BOOKING_OPEN });
}

/** What the email and staff paths need: no payment gateway, so it works while PAYMENT_MODE is unset. */
export type CoreDeps = Pick<Deps, "db" | "email" | "staffEmails" | "baseUrl">;

export async function getCoreDeps(origin: string): Promise<CoreDeps> {
  return buildCoreDeps(await appEnv(), await getDb(), origin);
}

export function buildCoreDeps(env: AppEnv, db: Db, origin: string): CoreDeps {
  return {
    db,
    email: emailSender(env),
    staffEmails: (env.STAFF_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    baseUrl: (env.BASE_URL || origin).replace(/\/+$/, ""),
  };
}

/**
 * Everything the booking services need, for this request. `origin` (the request's) is the base for
 * the absolute URLs given to the payment gateway and put in emails, unless BASE_URL is set.
 * Throws BookingDisabledError while PAYMENT_MODE is unset.
 */
export async function getDeps(origin: string): Promise<Deps> {
  return buildDeps(await appEnv(), await getDb(), origin);
}

export function buildDeps(env: AppEnv, db: Db, origin: string): Deps {
  const reason = bookingDisabledReason(env);
  if (reason) throw new BookingDisabledError(reason);
  const core = buildCoreDeps(env, db, origin);
  return { ...core, gateway: paymentGateway(env, core.baseUrl), channel: channelManager(env) };
}

/**
 * Deps for staff actions while online payments are off (getDeps threw BookingDisabledError): the email
 * deps work; the gateway and channel refuse. Only an action that moves no money may use it (a staff
 * cancel refunding 0 — the channel cancel then waits in syncState pending for the retry job).
 */
export async function getOfflineDeps(origin: string): Promise<Deps> {
  return buildOfflineDeps(await appEnv(), await getDb(), origin);
}

export function buildOfflineDeps(env: AppEnv, db: Db, origin: string): Deps {
  return { ...buildCoreDeps(env, db, origin), gateway: disabledGateway, channel: disabledChannel };
}

/**
 * The full deps when online payments are configured, else the offline ones (db and email only; the gateway and
 * channel refuse) with `paymentsUnavailable: true`, for staff actions that can run without them.
 */
export async function getDepsOrOffline(origin: string): Promise<{ deps: Deps; paymentsUnavailable: boolean }> {
  return buildDepsOrOffline(await appEnv(), await getDb(), origin);
}

export function buildDepsOrOffline(env: AppEnv, db: Db, origin: string): { deps: Deps; paymentsUnavailable: boolean } {
  try {
    return { deps: buildDeps(env, db, origin), paymentsUnavailable: false };
  } catch (e) {
    if (!(e instanceof BookingDisabledError)) throw e;
    return { deps: buildOfflineDeps(env, db, origin), paymentsUnavailable: true };
  }
}

export type ScheduledDeps = Deps & { syncSkipReason: string | null; emailSkipReason: string | null };

/** The cron's base URL when BASE_URL is unset outside production: `wrangler dev`. */
const LOCAL_DEV_ORIGIN = "http://localhost:8787";

/**
 * Deps for the cron worker. Never throws: the email deps always build, and a missing or broken payment
 * or channel config only switches the channel-dependent job (sync retry) off, so hold expiry,
 * pre-arrival emails and pruning keep running. `syncSkipReason` says why sync is off, else null.
 * `emailSkipReason` is set when production has no BASE_URL: the email-sending jobs must not run then,
 * because their links would have no valid origin (never localhost).
 */
export function buildScheduledDeps(env: AppEnv, db: Db): ScheduledDeps {
  const emailSkipReason = baseUrlMissingReason(env);
  const core = buildCoreDeps(env, db, emailSkipReason ? "" : LOCAL_DEV_ORIGIN);
  let syncSkipReason = bookingDisabledReason(env);
  let gateway = disabledGateway;
  let channel = disabledChannel;
  if (!syncSkipReason) {
    try {
      gateway = paymentGateway(env, core.baseUrl);
      channel = channelManager(env);
    } catch (e) {
      log.error("scheduled: payment/channel config failed; sync retry is off", e);
      gateway = disabledGateway;
      channel = disabledChannel;
      syncSkipReason = e instanceof Error ? e.message : String(e);
    }
  }
  return { ...core, gateway, channel, syncSkipReason, emailSkipReason };
}

const disabledGateway: PaymentGateway = {
  provider: "mock",
  supportsPreauth: false,
  timeoutMs: 1,
  async startCharge() { throw new BookingDisabledError(); },
  async verifyNotice() { throw new BookingDisabledError(); },
  async refund() { throw new BookingDisabledError(); },
  async queryTransaction() { throw new BookingDisabledError(); },
  async queryRefund() { throw new BookingDisabledError(); },
};

const disabledChannel: ChannelManager = {
  async pushReservation() { throw new BookingDisabledError("CHANNEL_MODE_NOT_SET"); },
  async modifyReservation() { throw new BookingDisabledError("CHANNEL_MODE_NOT_SET"); },
  async cancelReservation() { throw new BookingDisabledError("CHANNEL_MODE_NOT_SET"); },
  async lookupReservation() { throw new BookingDisabledError("CHANNEL_MODE_NOT_SET"); },
  timeoutMs: 1,
};

function paymentGateway(env: AppEnv, baseUrl: string): PaymentGateway {
  switch (env.PAYMENT_MODE) {
    case "mock":
      return new MockSinoPacGateway({ secret: env.MOCK_PAYMENT_SECRET || MOCK_DEFAULT_SECRET, baseUrl });
    case "sinopac":
      throw new Error("SINOPAC_NOT_CONFIGURED"); // Plan 5
    case undefined:
    case "":
      throw new BookingDisabledError();
    default:
      throw new Error(`UNKNOWN_PAYMENT_MODE: ${env.PAYMENT_MODE}`);
  }
}

function channelManager(env: AppEnv): ChannelManager {
  switch (env.CHANNEL_MODE) {
    case undefined:
    case "":
      throw new BookingDisabledError("CHANNEL_MODE_NOT_SET");
    case "mock":
      return new MockChannelManager();
    case "siteminder":
      throw new Error("SITEMINDER_NOT_CONFIGURED"); // Plan 4
    default:
      throw new Error(`UNKNOWN_CHANNEL_MODE: ${env.CHANNEL_MODE}`);
  }
}

/** What notifyOps needs: the email layer, OPS_EMAILS (comma-separated) and the environment named in the subject. */
export function buildOpsDeps(env: AppEnv, db: Db): OpsDeps {
  return {
    db,
    email: emailSender(env),
    opsEmails: (env.OPS_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    environment: env.ENVIRONMENT?.trim() || "(unset)",
  };
}

/** Resend when configured; otherwise a mock that logs each email (local dev). */
function emailSender(env: AppEnv): EmailSender {
  if (env.RESEND_API_KEY)
    return new ResendEmailSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM ?? "NK Hostel <noreply@nkhostel.com>" });
  const mock = new MockEmailSender();
  return {
    async send(e) {
      log.info(`[email] RESEND_API_KEY not set; not sent:\nTo: ${e.to}${e.replyTo ? `\nReply-To: ${e.replyTo}` : ""}\nSubject: ${e.subject}\n\n${e.text}\n`);
      return mock.send(e);
    },
  };
}
