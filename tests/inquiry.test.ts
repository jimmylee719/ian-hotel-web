import { beforeEach, describe, expect, test } from "vitest";
import { seedNk } from "@/lib/db/seed-nk";
import { MockEmailSender } from "@/lib/email/mock";
import { submitInquiry, type InquiryInput } from "@/lib/inquiry";
import { createTestDb, type TestDb } from "./helpers/test-db";

const NOW = new Date("2026-12-01T04:00:00Z");
const valid: InquiryInput = {
  name: "Chen Mei",
  email: "mei@example.com",
  phone: "+886 912 345 678",
  groupSize: 24,
  checkIn: "2027-03-10",
  checkOut: "2027-03-13",
  message: "A school basketball team, 20 players and 4 coaches.",
  locale: "en",
  honeypot: "",
};

describe("submitInquiry", () => {
  let db: TestDb;
  let email: MockEmailSender;
  beforeEach(async () => {
    db = createTestDb();
    await seedNk(db);
    email = new MockEmailSender();
  });
  const deps = () => ({ db, email, staffEmails: ["front@nkhostel.com"] });

  test("a filled honeypot is dropped silently: ok, but nothing is sent", async () => {
    const res = await submitInquiry(deps(), { ...valid, honeypot: "http://spam.example" }, NOW);
    expect(res).toEqual({ ok: true });
    expect(email.sent).toHaveLength(0);
  });

  test("sends one email to the hotel with replyTo set to the guest", async () => {
    const res = await submitInquiry(deps(), valid, NOW);
    expect(res).toEqual({ ok: true });
    expect(email.sent).toHaveLength(1);
    const [m] = email.sent;
    expect(m.to).toBe("front@nkhostel.com");
    expect(m.replyTo).toBe("mei@example.com");
    expect(m.subject).toContain("Chen Mei");
    expect(m.subject).toContain("24");
    expect(m.text).toContain("2027-03-10");
    expect(m.text).toContain("basketball");
  });

  test("escapes guest input in the HTML body", async () => {
    await submitInquiry(deps(), { ...valid, message: "<script>alert(1)</script>" }, NOW);
    expect(email.sent[0].html).not.toContain("<script>");
    expect(email.sent[0].html).toContain("&lt;script&gt;");
  });

  test("groupSize 0 is a validation error and sends nothing", async () => {
    const res = await submitInquiry(deps(), { ...valid, groupSize: 0 }, NOW);
    expect(res).toMatchObject({ ok: false, error: "VALIDATION" });
    expect(!res.ok && res.error === "VALIDATION" && res.fields).toContain("groupSize");
    expect(email.sent).toHaveLength(0);
  });

  test("rejects groupSize over 200, a bad email, and check-out not after check-in", async () => {
    for (const bad of [{ groupSize: 201 }, { email: "not-an-email" }, { checkOut: "2027-03-10" }, { checkIn: "2026-11-30" }, { checkIn: "2027-13-01" }, { checkOut: "2027-02-30" }]) {
      const res = await submitInquiry(deps(), { ...valid, ...bad }, NOW);
      expect(res.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(email.sent).toHaveLength(0);
  });

  test("falls back to the property email when no staff addresses are configured", async () => {
    await submitInquiry({ db, email, staffEmails: [] }, valid, NOW);
    expect(email.sent.map((m) => m.to)).toEqual(["info@nkhostel.com"]);
  });

  test("reports a send failure", async () => {
    const failing = { send: async () => ({ ok: false as const, error: "boom" }) };
    const res = await submitInquiry({ db, email: failing, staffEmails: ["a@b.co"] }, valid, NOW);
    expect(res).toEqual({ ok: false, error: "SEND_FAILED" });
  });
});
