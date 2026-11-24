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
import { appEnv, type AppEnv } from "./env";

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
 * env; env.production sets "production"), so mock payments can never serve a public host.
 */
export function bookingDisabledReason(env: AppEnv): string | null {
  if (!env.PAYMENT_MODE) return "PAYMENT_MODE_NOT_SET";
  if (!env.CHANNEL_MODE) return "CHANNEL_MODE_NOT_SET";
  if ((env.PAYMENT_MODE === "mock" || env.CHANNEL_MODE === "mock") && env.ENVIRONMENT !== "local") return "MOCK_MODE_IN_PRODUCTION";
  return null;
}

/** Is online booking on? */
export function paymentsConfigured(env: AppEnv): boolean {
  return bookingDisabledReason(env) === null;
}

export async function bookingEnabled(): Promise<boolean> {
  return paymentsConfigured(await appEnv());
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

export type ScheduledDeps = Deps & { syncSkipReason: string | null };

/**
 * Deps for the cron worker. Never throws: the email deps always build, and a missing or broken payment
 * or channel config only switches the channel-dependent job (sync retry) off, so hold expiry,
 * pre-arrival emails and pruning keep running. `syncSkipReason` says why sync is off, else null.
 */
export function buildScheduledDeps(env: AppEnv, db: Db): ScheduledDeps {
  const core = buildCoreDeps(env, db, "http://localhost:8787");
  let syncSkipReason = bookingDisabledReason(env);
  let gateway = disabledGateway;
  let channel = disabledChannel;
  if (!syncSkipReason) {
    try {
      gateway = paymentGateway(env, core.baseUrl);
      channel = channelManager(env);
    } catch (e) {
      console.error("scheduled: payment/channel config failed; sync retry is off", e);
      gateway = disabledGateway;
      channel = disabledChannel;
      syncSkipReason = e instanceof Error ? e.message : String(e);
    }
  }
  return { ...core, gateway, channel, syncSkipReason };
}

const disabledGateway: PaymentGateway = {
  provider: "mock",
  supportsPreauth: false,
  async startCharge() { throw new BookingDisabledError(); },
  async verifyNotice() { throw new BookingDisabledError(); },
  async refund() { throw new BookingDisabledError(); },
};

const disabledChannel: ChannelManager = {
  async pushReservation() { throw new BookingDisabledError("CHANNEL_MODE_NOT_SET"); },
  async modifyReservation() { throw new BookingDisabledError("CHANNEL_MODE_NOT_SET"); },
  async cancelReservation() { throw new BookingDisabledError("CHANNEL_MODE_NOT_SET"); },
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

/** Resend when configured; otherwise a mock that logs each email (local dev). */
function emailSender(env: AppEnv): EmailSender {
  if (env.RESEND_API_KEY)
    return new ResendEmailSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM ?? "NK Hostel <noreply@nkhostel.com>" });
  const mock = new MockEmailSender();
  return {
    async send(e) {
      console.log(`[email] RESEND_API_KEY not set; not sent:\nTo: ${e.to}${e.replyTo ? `\nReply-To: ${e.replyTo}` : ""}\nSubject: ${e.subject}\n\n${e.text}\n`);
      return mock.send(e);
    },
  };
}
