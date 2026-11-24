import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/lib/db/client";
import { MockEmailSender } from "@/lib/email/mock";
import { ResendEmailSender } from "@/lib/email/resend";
import type { EmailSender } from "@/lib/email/types";
import { submitInquiry, type InquiryInput } from "@/lib/inquiry";

export const dynamic = "force-dynamic";

type InquiryEnv = { RESEND_API_KEY?: string; EMAIL_FROM?: string; STAFF_EMAILS?: string };

/** Resend when configured; otherwise log the email (local dev). Task 9 moves this into getDeps(). */
function emailSender(env: InquiryEnv): EmailSender {
  if (env.RESEND_API_KEY) return new ResendEmailSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM ?? "NK Hostel <noreply@nkhostel.com>" });
  const mock = new MockEmailSender();
  return {
    async send(e) {
      console.log("[inquiry] RESEND_API_KEY not set; email not sent:", JSON.stringify({ to: e.to, replyTo: e.replyTo, subject: e.subject }));
      return mock.send(e);
    },
  };
}

export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > 20_000) return Response.json({ ok: false, error: "TOO_LARGE" }, { status: 413 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ ok: false, error: "VALIDATION", fields: [] }, { status: 400 });

  const env = (await getCloudflareContext({ async: true })).env as unknown as InquiryEnv;
  const staffEmails = (env.STAFF_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const result = await submitInquiry({ db: await getDb(), email: emailSender(env), staffEmails }, body as InquiryInput, new Date()); // validated inside

  if (result.ok) return Response.json(result);
  return Response.json(result, { status: result.error === "VALIDATION" ? 400 : 502 });
}
