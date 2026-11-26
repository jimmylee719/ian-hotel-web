import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { MOCK_NOTIFY_PATH, mockPayOrigins, mockPayTargetsValid } from "@/lib/payments/mock-page";

// The mock pay page is public on the preview: it may only post its signed notice to this site's own notify route
// and only send the guest back to this site's own return page for the same booking (no open redirect).

const ORIGIN = "https://nk-booking-preview.example";
const ok = { notifyUrl: `${ORIGIN}/api/payments/notify`, returnUrl: `${ORIGIN}/zh-TW/book/return/NK7X2Q`, code: "NK7X2Q" };
const valid = (p: Partial<typeof ok>) => mockPayTargetsValid({ ...ok, ...p }, [ORIGIN]);

test("accepts this site's notify route and return page, for every locale", () => {
  expect(MOCK_NOTIFY_PATH).toBe("/api/payments/notify");
  expect(valid({})).toBe(true);
  for (const l of ["zh-TW", "en", "ja", "ko"]) expect(valid({ returnUrl: `${ORIGIN}/${l}/book/return/NK7X2Q` })).toBe(true);
});

test("refuses a notifyUrl on another origin, path, scheme or port, or with extras", () => {
  for (const notifyUrl of [
    "https://evil.example/api/payments/notify",
    "http://nk-booking-preview.example/api/payments/notify", // http is another origin
    `${ORIGIN}:8443/api/payments/notify`,
    `${ORIGIN}/api/payments/notify/`,
    `${ORIGIN}/api/payments/notify?x=1`,
    `${ORIGIN}/api/payments/notify#x`,
    `${ORIGIN}/api/bookings`,
    `${ORIGIN}/api/payments/../admin`,
    "https://user:pw@nk-booking-preview.example/api/payments/notify",
    "https://nk-booking-preview.example.evil.example/api/payments/notify",
    "javascript:alert(1)",
    "not a url",
    "",
  ]) expect(valid({ notifyUrl }), notifyUrl).toBe(false);
});

test("refuses a returnUrl off-site, to another page, another booking or an unknown locale (no open redirect)", () => {
  for (const returnUrl of [
    "https://evil.example/zh-TW/book/return/NK7X2Q",
    "//evil.example/zh-TW/book/return/NK7X2Q",
    `${ORIGIN}/zh-TW/book/return/OTHER1`,
    `${ORIGIN}/zh-TW/book/return/NK7X2Q/extra`,
    `${ORIGIN}/fr/book/return/NK7X2Q`,
    `${ORIGIN}/zh-TW/manage/NK7X2Q`,
    `${ORIGIN}/zh-TW/book/return/NK7X2Q?next=https://evil.example`,
    "data:text/html,hi",
    "",
  ]) expect(valid({ returnUrl }), returnUrl).toBe(false);
  expect(valid({ code: "" , returnUrl: `${ORIGIN}/zh-TW/book/return/` })).toBe(false);
  expect(mockPayTargetsValid(ok, [])).toBe(false); // no allowed origin: refuse everything
});

test("allowed origins: BASE_URL when set (never the request's), else the request's; invalid fails closed", () => {
  expect(mockPayOrigins("https://nk-booking-preview.example/", "https://attacker.example")).toEqual([ORIGIN]);
  expect(mockPayOrigins(undefined, "http://localhost:8787")).toEqual(["http://localhost:8787"]);
  expect(mockPayOrigins("", "http://localhost:3000")).toEqual(["http://localhost:3000"]);
  expect(mockPayOrigins("not a url", "http://localhost:3000")).toEqual([]);
  expect(mockPayOrigins("ftp://x.example", undefined)).toEqual([]);
  expect(mockPayOrigins(undefined, undefined)).toEqual([]);
});

test("the mock pay page never asks for card or bank details: its only inputs are hidden fields, and it checks both URLs", () => {
  const src = readFileSync(path.resolve(__dirname, "../../app/dev/pay/[ref]/page.tsx"), "utf8");
  const inputs = src.match(/<input\b[^>]*>/g) ?? [];
  expect(inputs.length).toBeGreaterThan(0);
  for (const i of inputs) expect(i).toContain('type="hidden"');
  expect(src).not.toMatch(/<(select|textarea)\b/);
  expect(src).not.toMatch(/cardNumber|cvv|cvc|expiry|account(Number|No)/i);
  // The page and the server action both go through the same check.
  expect(src.match(/await checked\(/g)?.length).toBe(2);
});
