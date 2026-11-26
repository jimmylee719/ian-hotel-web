import { expect, test, vi } from "vitest";
import { MockChannelManager } from "@/lib/channel/mock";
import { SiteMinderChannelManager } from "@/lib/channel/siteminder/client";
import { properties } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import { MockEmailSender } from "@/lib/email/mock";
import { ResendEmailSender } from "@/lib/email/resend";
import { MockSinoPacGateway } from "@/lib/payments/mock-sinopac";
import {
  BookingDisabledError, buildChannelDeps, buildCoreDeps, buildDeps, buildScheduledDeps, bookingDisabledReason, channelDisabledReason,
  paymentsConfigured, propertyHotelCode,
} from "@/lib/runtime/deps";
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

test("sinopac is not available yet; siteminder needs its settings; PAYMENT_MODE must be set", () => {
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

test("ENVIRONMENT=production requires BASE_URL: booking is off and the cron never falls back to localhost", () => {
  const prod = { ENVIRONMENT: "production", PAYMENT_MODE: "sinopac", CHANNEL_MODE: "siteminder" };
  expect(bookingDisabledReason(prod)).toBe("BASE_URL_NOT_SET");
  expect(() => buildDeps(prod, db, "https://nkhostel.com")).toThrow("BASE_URL_NOT_SET");
  expect(() => buildDeps(prod, db, "https://nkhostel.com")).toThrow(BookingDisabledError);
  expect(bookingDisabledReason({ ...prod, BASE_URL: "https://nkhostel.com" })).toMatch(/^SITEMINDER_NOT_CONFIGURED/);
  expect(bookingDisabledReason({ ...prod, BASE_URL: "https://nkhostel.com", ...SM })).toBeNull();

  const cron = buildScheduledDeps({ ENVIRONMENT: "production" }, db);
  expect(cron.baseUrl).not.toContain("localhost");
  expect(cron.emailSkipReason).toBe("BASE_URL_NOT_SET");
  expect(buildScheduledDeps({ ENVIRONMENT: "production", BASE_URL: "https://nkhostel.com" }, db))
    .toMatchObject({ baseUrl: "https://nkhostel.com", emailSkipReason: null });
  // Local development keeps the wrangler dev fallback.
  expect(buildScheduledDeps(base, db)).toMatchObject({ baseUrl: "http://localhost:8787", emailSkipReason: null });
});

test("staging fails closed like production: mock modes refused, BASE_URL required", () => {
  expect(bookingDisabledReason({ ...base, ENVIRONMENT: "staging" })).toBe("MOCK_MODE_IN_PRODUCTION");
  expect(bookingDisabledReason({ ENVIRONMENT: "staging", PAYMENT_MODE: "sinopac", CHANNEL_MODE: "siteminder" })).toBe("BASE_URL_NOT_SET");
  expect(buildScheduledDeps({ ENVIRONMENT: "staging" }, db).emailSkipReason).toBe("BASE_URL_NOT_SET");
  expect(buildScheduledDeps({ ENVIRONMENT: "staging", BASE_URL: "https://staging.nk.test" }, db).emailSkipReason).toBeNull();
});

test("BOOKING_OPEN=false closes guest booking even with payments configured", async () => {
  const { guestBookingOpen } = await import("@/lib/runtime/deps");
  expect(guestBookingOpen(base)).toBe(true);
  expect(guestBookingOpen({ ...base, BOOKING_OPEN: "false" })).toBe(false);
  expect(guestBookingOpen(base, { BOOKING_OPEN: "false" })).toBe(false);
  expect(guestBookingOpen({ ...base, BOOKING_OPEN: "true" }, { BOOKING_OPEN: "false" })).toBe(true);
  expect(guestBookingOpen({ PAYMENT_MODE: "mock" })).toBe(false);
  expect(paymentsConfigured({ ...base, BOOKING_OPEN: "false" })).toBe(true);
});

test("channel-only deps (manual channel retry) need the channel, not payments", async () => {
  const d = buildChannelDeps({ CHANNEL_MODE: "mock", ENVIRONMENT: "local" }, db, "http://localhost:3000");
  expect(d.channel).toBeInstanceOf(MockChannelManager);
  await expect(d.gateway.refund({ providerRef: "x", amount: 1, reason: "r", idempotencyKey: "k" })).rejects.toThrow(BookingDisabledError);
  const reason = (env: Record<string, string>) => {
    try { buildChannelDeps(env, db, "http://localhost:3000"); return null; } catch (e) { return (e as BookingDisabledError).reason; }
  };
  expect(reason({ PAYMENT_MODE: "mock", ENVIRONMENT: "local" })).toBe("CHANNEL_MODE_NOT_SET");
  expect(reason({ CHANNEL_MODE: "mock", ENVIRONMENT: "production" })).toBe("MOCK_MODE_IN_PRODUCTION");
  expect(reason({ CHANNEL_MODE: "siteminder", ENVIRONMENT: "preview" })).toBe("REAL_MODE_IN_PREVIEW");
});

const SM = {
  SITEMINDER_ENDPOINT: "https://siteminder.test/reservation-gateway/services", SITEMINDER_USERNAME: "fake-user",
  SITEMINDER_PASSWORD: "Fake-Passw0rd!2026", SITEMINDER_REQUESTOR_ID: "NKDIRECT",
};

test("CHANNEL_MODE=siteminder with every setting builds the SiteMinder adapter", () => {
  const env = { ...base, CHANNEL_MODE: "siteminder", ...SM };
  expect(bookingDisabledReason(env)).toBeNull();
  expect(buildDeps(env, db, "http://x").channel).toBeInstanceOf(SiteMinderChannelManager);
  expect(buildChannelDeps(env, db, "http://x").channel).toBeInstanceOf(SiteMinderChannelManager);
  expect(buildScheduledDeps(env, db)).toMatchObject({ syncSkipReason: null });
  expect(buildScheduledDeps(env, db).channel).toBeInstanceOf(SiteMinderChannelManager);
});

test("CHANNEL_MODE=siteminder fails closed while a setting is missing, naming it (never its value)", () => {
  for (const name of Object.keys(SM) as (keyof typeof SM)[]) {
    const env = { ...base, CHANNEL_MODE: "siteminder", ...SM, [name]: " " };
    const want = `SITEMINDER_NOT_CONFIGURED: ${name} not set`;
    expect(bookingDisabledReason(env)).toBe(want);
    expect(channelDisabledReason(env)).toBe(want);
    expect(() => buildDeps(env, db, "http://x")).toThrow(BookingDisabledError);
    expect(() => buildChannelDeps(env, db, "http://x")).toThrow(want);
    const cron = buildScheduledDeps(env, db);
    expect(cron.syncSkipReason).toBe(want);
    expect(cron.channel.disabled).toBe(true);
  }
  const none = { ...base, CHANNEL_MODE: "siteminder" };
  expect(bookingDisabledReason(none)).toBe(
    "SITEMINDER_NOT_CONFIGURED: SITEMINDER_ENDPOINT, SITEMINDER_USERNAME, SITEMINDER_PASSWORD, SITEMINDER_REQUESTOR_ID not set");
  expect(bookingDisabledReason({ ...none, ...SM })).toBeNull();
  // The preview stays mock-only, whatever is set.
  expect(channelDisabledReason({ CHANNEL_MODE: "siteminder", ENVIRONMENT: "preview", ...SM })).toBe("REAL_MODE_IN_PREVIEW");
});

test("the HotelCode is the one property's smPropertyCode; none or several is refused", async () => {
  const d = createTestDb();
  await expect(propertyHotelCode(d)).rejects.toThrow("SITEMINDER_HOTEL_CODE_NOT_SET");
  await seedNk(d);
  expect(await propertyHotelCode(d)).toBe("NKHOSTEL");
  await d.insert(properties).values({
    id: "p2", slug: "other", type: "hotel", name: { "zh-TW": "另一館", en: "Other", ja: "Other", ko: "Other" }, timezone: "Asia/Taipei",
    currency: "TWD", address: { "zh-TW": "", en: "", ja: "", ko: "" }, phone: "", email: "", smPropertyCode: "OTHER", createdAt: 0,
  });
  await expect(propertyHotelCode(d)).rejects.toThrow("SITEMINDER_SEVERAL_HOTEL_CODES");
});

test("the wired adapter sends the property's HotelCode and, without one, sends nothing and retries", async () => {
  const d = createTestDb();
  const calls: string[] = [];
  const env = { ...base, CHANNEL_MODE: "siteminder", ...SM };
  const channel = buildDeps(env, d, "http://x").channel as SiteMinderChannelManager;
  // No property code yet: not sent, retryable.
  const r = {
    code: "NK-AB12CD", smPropertyCode: "", checkIn: "2026-12-01", checkOut: "2026-12-02",
    rooms: [{ smRoomCode: "MIXEDCUBE", smRatePlanCode: "DIRECTFLEX", nightlyPrices: [2000], roomName: "r", ratePlanName: "p" }],
    guest: { firstName: "M", lastName: "L", email: "m@example.com", phone: "" }, adults: 1, children: 0, currency: "TWD",
    createdAt: 0, lastModifiedAt: 0, total: 2000, paidAmount: 0, discount: 0, addons: [],
  };
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
    calls.push(String(init?.body));
    return new Response("unavailable", { status: 503 });
  });
  expect(await channel.pushReservation(r)).toMatchObject({ ok: false, retryable: true, error: "SITEMINDER_HOTEL_CODE_NOT_SET" });
  expect(calls).toHaveLength(0);
  await seedNk(d);
  expect(await channel.pushReservation({ ...r, smPropertyCode: "NKHOSTEL" })).toMatchObject({ ok: false, retryable: true, detail: { kind: "http", httpStatus: 503 } });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('<BasicPropertyInfo HotelCode="NKHOSTEL"/>');
  expect(calls[0]).toContain('<RequestorID Type="22" ID="NKDIRECT"/>');
  fetchSpy.mockRestore();
});
