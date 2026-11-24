import type { Email, EmailSender } from "./types";

export class MockEmailSender implements EmailSender {
  sent: Email[] = [];
  async send(e: Email) {
    this.sent.push(e);
    return { ok: true as const, id: `mock-${this.sent.length}` };
  }
}
