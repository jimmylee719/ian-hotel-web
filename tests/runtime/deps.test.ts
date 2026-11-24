import { expect, test, vi } from "vitest";
import { MockChannelManager } from "@/lib/channel/mock";
import { MockEmailSender } from "@/lib/email/mock";
import { ResendEmailSender } from "@/lib/email/resend";
import { MockSinoPacGateway } from "@/lib/payments/mock-sinopac";
import { BookingDisabledError, buildCoreDeps, buildDeps, buildScheduledDeps, bookingDisabledReason, paymentsConfigured } from "@/lib/runtime/deps";
import { createTestDb } from "@/tests/helpers/test-db";

const db = createTestDb();
const base = { PAYMENT_MODE: "mock", CHANNEL_MODE: "mock", ENVIRONMENT: "local" };

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

test("CHANNEL_MODE unset fails closed, like PAYMENT_MODE", () => {
  expect(() => buildDeps({ PAYMENT_MODE: "mock" }, db, "http://x")).toThrow(BookingDisabledError);
  expect(() => buildDeps({ PAYMENT_MODE: "mock" }, db, "http://x")).toThrow("CHANNEL_MODE_NOT_SET");
  expect(bookingDisabledReason({ PAYMENT_MODE: "mock" })).toBe("CHANNEL_MODE_NOT_SET");
  expect(bookingDisabledReason({ CHANNEL_MODE: "mock" })).toBe("PAYMENT_MODE_NOT_SET");
  expect(bookingDisabledReason(base)).toBeNull();
});

test("ENVIRONMENT=production refuses the mock modes", () => {
  const prod = { ENVIRONMENT: "production" };
  expect(() => buildDeps({ ...base, ...prod }, db, "http://x")).toThrow("MOCK_MODE_IN_PRODUCTION");
  expect(() => buildDeps({ ...base, ...prod }, db, "http://x")).toThrow(BookingDisabledError);
  expect(bookingDisabledReason({ ...base, ...prod })).toBe("MOCK_MODE_IN_PRODUCTION");
  expect(bookingDisabledReason({ PAYMENT_MODE: "sinopac", CHANNEL_MODE: "mock", ...prod })).toBe("MOCK_MODE_IN_PRODUCTION");
  expect(bookingDisabledReason({ ...base, ENVIRONMENT: undefined })).toBe("MOCK_MODE_IN_PRODUCTION"); // mock only when explicitly local
  expect(bookingDisabledReason({ ...base, ENVIRONMENT: "local" })).toBeNull();
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

// Production serves content before SinoPac is configured: PAYMENT_MODE is unset and booking is off.
test("without PAYMENT_MODE the email/staff deps still build, and only the booking deps refuse", async () => {
  const env = { STAFF_EMAILS: "a@x.com", RESEND_API_KEY: "re_x" };
  const core = buildCoreDeps(env, db, "http://x/");
  expect(core.email).toBeInstanceOf(ResendEmailSender);
  expect(core.staffEmails).toEqual(["a@x.com"]);
  expect(core.baseUrl).toBe("http://x");
  expect(paymentsConfigured(env)).toBe(false);
  expect(paymentsConfigured({ PAYMENT_MODE: "" })).toBe(false);
  expect(paymentsConfigured({ PAYMENT_MODE: "mock" })).toBe(false); // channel unset too
  expect(paymentsConfigured(base)).toBe(true);
  expect(() => buildDeps(env, db, "http://x")).toThrow(BookingDisabledError);
});

test("the cron deps work without PAYMENT_MODE, and their gateway refuses to be used", async () => {
  const d = buildScheduledDeps({ CHANNEL_MODE: "mock" }, db);
  expect(d.syncSkipReason).toBe("PAYMENT_MODE_NOT_SET");
  expect(d.baseUrl).toBe("http://localhost:8787");
  expect(buildScheduledDeps({ BASE_URL: "https://nkhostel.com/" }, db).baseUrl).toBe("https://nkhostel.com");
  await expect(d.gateway.refund({ providerRef: "x", amount: 1, reason: "r" })).rejects.toBeInstanceOf(BookingDisabledError);
  expect(buildScheduledDeps(base, db).gateway).toBeInstanceOf(MockSinoPacGateway);
});

test("cron deps never throw: a broken channel config only switches the sync off", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const d = buildScheduledDeps({ ...base, CHANNEL_MODE: "bogus" }, db);
  expect(d.syncSkipReason).toContain("UNKNOWN_CHANNEL_MODE");
  expect(d.staffEmails).toEqual([]);
  error.mockRestore();
  expect(buildScheduledDeps(base, db).syncSkipReason).toBeNull();
});
