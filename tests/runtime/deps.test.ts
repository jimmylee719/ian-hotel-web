import { expect, test } from "vitest";
import { MockChannelManager } from "@/lib/channel/mock";
import { MockEmailSender } from "@/lib/email/mock";
import { ResendEmailSender } from "@/lib/email/resend";
import { MockSinoPacGateway } from "@/lib/payments/mock-sinopac";
import { buildDeps } from "@/lib/runtime/deps";
import { createTestDb } from "@/tests/helpers/test-db";

const db = createTestDb();
const base = { PAYMENT_MODE: "mock", CHANNEL_MODE: "mock" };

test("mock mode: mock gateway, mock channel, logged mock email, staff list from STAFF_EMAILS", () => {
  const d = buildDeps({ ...base, STAFF_EMAILS: " a@x.com, b@x.com ,," }, db, "http://localhost:8787");
  expect(d.gateway).toBeInstanceOf(MockSinoPacGateway);
  expect(d.channel).toBeInstanceOf(MockChannelManager);
  expect(d.email).not.toBeInstanceOf(ResendEmailSender);
  expect(d.staffEmails).toEqual(["a@x.com", "b@x.com"]);
  expect(d.baseUrl).toBe("http://localhost:8787");
});

test("BASE_URL wins over the request origin", () => {
  expect(buildDeps({ ...base, BASE_URL: "https://nkhostel.com/" }, db, "http://internal").baseUrl).toBe("https://nkhostel.com");
});

test("RESEND_API_KEY selects Resend", () => {
  expect(buildDeps({ ...base, RESEND_API_KEY: "re_x" }, db, "http://x").email).toBeInstanceOf(ResendEmailSender);
});

test("sinopac and siteminder are not available yet; PAYMENT_MODE must be set", () => {
  expect(() => buildDeps({ ...base, PAYMENT_MODE: "sinopac" }, db, "http://x")).toThrow("SINOPAC_NOT_CONFIGURED");
  expect(() => buildDeps({ ...base, CHANNEL_MODE: "siteminder" }, db, "http://x")).toThrow("SITEMINDER_NOT_CONFIGURED");
  expect(() => buildDeps({ CHANNEL_MODE: "mock" }, db, "http://x")).toThrow("PAYMENT_MODE_NOT_SET");
});

test("the logging mock email sender still records what it would send", async () => {
  const d = buildDeps(base, db, "http://x");
  expect(await d.email.send({ to: "a@x.com", subject: "s", html: "h", text: "t" })).toMatchObject({ ok: true });
  void MockEmailSender;
});
