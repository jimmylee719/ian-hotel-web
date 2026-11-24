import { expect, test } from "vitest";
import { handleInquiry } from "@/lib/api/inquiry";
import { seedNk } from "@/lib/db/seed-nk";
import { MockEmailSender } from "@/lib/email/mock";
import { createTestDb } from "@/tests/helpers/test-db";

const NOW = new Date("2026-12-01T04:00:00Z");
const body = {
  name: "Chen Mei", email: "mei@example.com", phone: "", groupSize: 24,
  checkIn: "2027-03-10", checkOut: "2027-03-13", message: "", locale: "en", honeypot: "",
};
const req = (ip: string, b: unknown = body) =>
  new Request("https://hotel.test/api/inquiry", {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(b),
  });

test("POST /api/inquiry: sends, validates, and allows 5 per IP per minute", async () => {
  const db = createTestDb();
  await seedNk(db);
  const email = new MockEmailSender();
  const deps = { db, email, staffEmails: ["front@nkhostel.com"] };

  expect((await handleInquiry(deps, req("3.3.3.3", { ...body, email: "nope" }), NOW)).status).toBe(400);
  for (let i = 0; i < 4; i++) expect((await handleInquiry(deps, req("3.3.3.3"), NOW)).status).toBe(200);
  const sixth = await handleInquiry(deps, req("3.3.3.3"), NOW);
  expect(sixth.status).toBe(429);
  expect(await sixth.json()).toEqual({ ok: false, error: "RATE_LIMITED" });
  expect(email.sent).toHaveLength(4);
  expect((await handleInquiry(deps, req("4.4.4.4"), NOW)).status).toBe(200);
});
