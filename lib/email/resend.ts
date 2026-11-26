import type { Email, EmailSender } from "./types";

export class ResendEmailSender implements EmailSender {
  /** `subjectPrefix` (test sites: 【測試】) is put before every subject that does not already start with it. */
  constructor(private readonly o: { apiKey: string; from: string; subjectPrefix?: string }) {}

  async send(e: Email) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: this.o.from, to: [e.to], subject: withPrefix(e.subject, this.o.subjectPrefix), html: e.html, text: e.text,
          ...(e.replyTo ? { reply_to: e.replyTo } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok || !json.id) return { ok: false as const, error: json.message ?? `HTTP ${res.status}` };
      return { ok: true as const, id: json.id };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** `subject` with `prefix` in front, unless it is empty or already there. */
export function withPrefix(subject: string, prefix = ""): string {
  return !prefix || subject.startsWith(prefix) ? subject : `${prefix}${subject}`;
}
