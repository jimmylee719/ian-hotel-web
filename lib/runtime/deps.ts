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
 * Everything the booking services need, for this request. `origin` (the request's) is the base for
 * the absolute URLs given to the payment gateway and put in emails, unless BASE_URL is set.
 */
export async function getDeps(origin: string): Promise<Deps> {
  return buildDeps(await appEnv(), await getDb(), origin);
}

export function buildDeps(env: AppEnv, db: Db, origin: string): Deps {
  const baseUrl = (env.BASE_URL || origin).replace(/\/+$/, "");
  return {
    db,
    gateway: paymentGateway(env, baseUrl),
    channel: channelManager(env),
    email: emailSender(env),
    staffEmails: (env.STAFF_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    baseUrl,
  };
}

function paymentGateway(env: AppEnv, baseUrl: string): PaymentGateway {
  switch (env.PAYMENT_MODE) {
    case "mock":
      return new MockSinoPacGateway({ secret: env.MOCK_PAYMENT_SECRET || MOCK_DEFAULT_SECRET, baseUrl });
    case "sinopac":
      throw new Error("SINOPAC_NOT_CONFIGURED"); // Plan 5
    case undefined:
    case "":
      throw new Error("PAYMENT_MODE_NOT_SET");
    default:
      throw new Error(`UNKNOWN_PAYMENT_MODE: ${env.PAYMENT_MODE}`);
  }
}

function channelManager(env: AppEnv): ChannelManager {
  switch (env.CHANNEL_MODE ?? "mock") {
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
