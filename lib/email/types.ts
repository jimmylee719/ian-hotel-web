export type Email = { to: string; subject: string; html: string; text: string; replyTo?: string };

export interface EmailSender {
  send(e: Email): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
}
