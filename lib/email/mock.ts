import type { Email, EmailSender } from "./types";

export class MockEmailSender implements EmailSender {
  sent: Email[] = [];
  /** Refuse this many upcoming sends (tests). */
  failNext = 0;
  async send(e: Email) {
    if (this.failNext > 0) {
      this.failNext--;
      return { ok: false as const, error: "MOCK_EMAIL_FAILURE" };
    }
    this.sent.push(e);
    return { ok: true as const, id: `mock-${this.sent.length}` };
  }
}
