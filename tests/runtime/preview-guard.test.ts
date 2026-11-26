import { afterEach, expect, test, vi } from "vitest";
import { ResendEmailSender } from "@/lib/email/resend";
import { isMockPaymentMode } from "@/lib/payments/mock-page";
import { configRefusal, SINOPAC_HOSTS, SITEMINDER_HOSTS } from "@/lib/runtime/config-guard";
import { bookingDisabledReason, buildCoreDeps, buildDeps, buildScheduledDeps, emailSender, TEST_EMAIL_PREFIX } from "@/lib/runtime/deps";
import { isMockEnvironment, isTestSite } from "@/lib/runtime/env";
import { createTestDb } from "@/tests/helpers/test-db";

// The public preview (wrangler env.preview) runs the guest booking flow on the mock gateway and channel.
// These pin who may run the mock modes: local and preview only; staging, production, unset and mistyped never.

const mock = { PAYMENT_MODE: "mock", CHANNEL_MODE: "mock" };
const preview = { ...mock, ENVIRONMENT: "preview", MOCK_PAYMENT_SECRET: "s3cret", BASE_URL: "https://nk-booking-preview.example" };

afterEach(() => {
  for (const l of [SITEMINDER_HOSTS, SINOPAC_HOSTS]) { l.production.length = 0; l.sandbox.length = 0; }
});

test("truth table: mock modes are allowed in local and preview only, refused everywhere else (request guard and booking)", () => {
  const allowed = ["local", "preview"];
  for (const ENVIRONMENT of ["local", "preview", "staging", "production", undefined, "", "Preview", "PREVIEW", "prod", "Local"]) {
    const env = { ...mock, ENVIRONMENT, MOCK_PAYMENT_SECRET: "s3cret", BASE_URL: "https://x.example" };
    const ok = allowed.includes(ENVIRONMENT ?? "");
    expect(configRefusal(env) === null, `configRefusal ${ENVIRONMENT}`).toBe(ok);
    expect(bookingDisabledReason(env) === null, `bookingDisabledReason ${ENVIRONMENT}`).toBe(ok);
    expect(isMockEnvironment(ENVIRONMENT), `isMockEnvironment ${ENVIRONMENT}`).toBe(ok);
    expect(isTestSite(env), `isTestSite ${ENVIRONMENT}`).toBe(ok);
    expect(isMockPaymentMode(env), `isMockPaymentMode ${ENVIRONMENT}`).toBe(ok);
    if (!ok) expect(bookingDisabledReason(env)).toBe("MOCK_MODE_IN_PRODUCTION");
  }
});

test("' preview ' follows the existing trim rules: the request guard trims it, but booking, /dev/pay and the labels do not", () => {
  const env = { ...preview, ENVIRONMENT: " preview " };
  expect(configRefusal(env)).toBeNull(); // config-guard trims ENVIRONMENT (as it always has for "local")
  expect(bookingDisabledReason(env)).toBe("MOCK_MODE_IN_PRODUCTION"); // deps matches exactly: booking stays off
  expect(isMockPaymentMode(env)).toBe(false); // /dev/pay 404s
  expect(isTestSite(env)).toBe(false);
  // And " local " was already like that.
  expect(bookingDisabledReason({ ...mock, ENVIRONMENT: " local " })).toBe("MOCK_MODE_IN_PRODUCTION");
});

test("preview: mock is the only mode; a real or unknown PAYMENT_MODE / CHANNEL_MODE is refused", () => {
  expect(configRefusal(preview)).toBeNull();
  expect(bookingDisabledReason(preview)).toBeNull();
  expect(configRefusal({ ...preview, PAYMENT_MODE: "sinopac" })).toMatch(/REAL_MODE_IN_PREVIEW: PAYMENT_MODE/);
  expect(configRefusal({ ...preview, CHANNEL_MODE: "siteminder" })).toMatch(/REAL_MODE_IN_PREVIEW: CHANNEL_MODE/);
  expect(configRefusal({ ...preview, PAYMENT_MODE: "Mock" })).toMatch(/REAL_MODE_IN_PREVIEW/);
  expect(bookingDisabledReason({ ...preview, PAYMENT_MODE: "sinopac" })).toBe("REAL_MODE_IN_PREVIEW");
  expect(bookingDisabledReason({ ...preview, CHANNEL_MODE: "siteminder" })).toBe("REAL_MODE_IN_PREVIEW");
  // Unset modes are not refused (nothing can reach a vendor): booking simply stays off, as before this change.
  expect(configRefusal({ ENVIRONMENT: "preview" })).toBeNull();
  expect(bookingDisabledReason({ ENVIRONMENT: "preview" })).toBe("PAYMENT_MODE_NOT_SET");
});

test("preview refuses every SiteMinder / SinoPac setting, endpoint or not, even when it would be on a host list", () => {
  SITEMINDER_HOSTS.sandbox.push("sandbox.siteminder.example");
  SINOPAC_HOSTS.production.push("pay.sinopac.example");
  for (const [name, value] of [
    ["SITEMINDER_ENDPOINT", "https://sandbox.siteminder.example/x"],
    ["SINOPAC_ENDPOINT", "https://pay.sinopac.example/x"],
    ["SINOPAC_QUERY_URL", "https://pay.sinopac.example/q"],
    ["SINOPAC_MERCHANT_ID", "123"],
    ["SITEMINDER_PASSWORD", "pw"],
  ]) {
    const reason = configRefusal({ ...preview, [name]: value });
    expect(reason, name).toMatch(new RegExp(`VENDOR_SETTING_IN_PREVIEW: ${name}`));
    expect(reason).not.toContain(value); // names the setting, never its value
  }
  expect(configRefusal({ ...preview, SINOPAC_ENDPOINT: "  " })).toBeNull(); // empty = unset
});

test("preview needs MOCK_PAYMENT_SECRET: with the public default secret anyone could forge a paid notice", () => {
  const { MOCK_PAYMENT_SECRET: _, ...noSecret } = preview;
  void _;
  expect(bookingDisabledReason(noSecret)).toBe("MOCK_PAYMENT_SECRET_NOT_SET");
  expect(bookingDisabledReason({ ...noSecret, MOCK_PAYMENT_SECRET: "" })).toBe("MOCK_PAYMENT_SECRET_NOT_SET");
  // local keeps its default secret (wrangler dev, tests)
  expect(bookingDisabledReason({ ...mock, ENVIRONMENT: "local" })).toBeNull();
});

test("staging and production are unchanged: mock refused by both guards, whatever else is set", () => {
  for (const ENVIRONMENT of ["staging", "production"]) {
    const env = { ...preview, ENVIRONMENT };
    expect(configRefusal(env)).toMatch(/MOCK_MODE_REFUSED/);
    expect(bookingDisabledReason(env)).toBe("MOCK_MODE_IN_PRODUCTION");
    expect(isTestSite(env)).toBe(false);
  }
});

test("the preview builds mock deps; the cron runs every job (sync retry included) with the mock channel", () => {
  const db = createTestDb();
  const d = buildDeps(preview, db, "https://ignored.example");
  expect(d.baseUrl).toBe(preview.BASE_URL);
  const s = buildScheduledDeps(preview, db);
  expect(s.syncSkipReason).toBeNull();
  expect(s.emailSkipReason).toBeNull();
  expect(s.baseUrl).toBe(preview.BASE_URL); // never localhost on the preview
});

test("a test site prefixes every email subject with 【測試】; production and staging never do", async () => {
  expect(TEST_EMAIL_PREFIX).toBe("【測試】");
  const resend = emailSender({ ...preview, RESEND_API_KEY: "re_x" });
  expect(resend).toBeInstanceOf(ResendEmailSender);
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)).subject);
    return new Response(JSON.stringify({ id: "1" }), { status: 200 });
  }) as typeof fetch;
  try {
    await resend.send({ to: "test@example.com", subject: "訂房確認", html: "h", text: "t" });
    await resend.send({ to: "test@example.com", subject: "【測試】已有前綴", html: "h", text: "t" });
    await emailSender({ ENVIRONMENT: "production", RESEND_API_KEY: "re_x" }).send({ to: "a@x.com", subject: "訂房確認", html: "h", text: "t" });
    await emailSender({ ENVIRONMENT: "staging", RESEND_API_KEY: "re_x" }).send({ to: "a@x.com", subject: "訂房確認", html: "h", text: "t" });
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(calls).toEqual(["【測試】訂房確認", "【測試】已有前綴", "訂房確認", "訂房確認"]);
  // Without a Resend key nothing is sent (only logged), and the logged subject carries the prefix too.
  const core = buildCoreDeps(preview, createTestDb(), "https://x");
  expect(core.email).not.toBeInstanceOf(ResendEmailSender);
  const info = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await core.email.send({ to: "test@example.com", subject: "訂房確認", html: "h", text: "t" })).toMatchObject({ ok: true });
  expect(info).toHaveBeenCalledWith(expect.stringContaining("not sent:"));
  expect(info).toHaveBeenCalledWith(expect.stringContaining("Subject: 【測試】訂房確認"));
  info.mockRestore();
});
