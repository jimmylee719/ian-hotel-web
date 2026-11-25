import { afterEach, expect, test, vi } from "vitest";
import { redact, REDACTED } from "@/lib/runtime/redact";
import { log } from "@/lib/runtime/log";

afterEach(() => vi.restoreAllMocks());

test("redact removes the card number and the key value (brief)", () => {
  const out = redact("card 4111 1111 1111 1111 key=abc");
  expect(out).not.toMatch(/4111/);
  expect(out).not.toContain("abc");
  expect(out).toBe(`card ${REDACTED} key=${REDACTED}`);
});

test("13 to 19 digit runs, with spaces or hyphens, are masked", () => {
  for (const pan of ["4111111111111111", "4111-1111-1111-1111", "3782 822463 10005", "6011000990139424123", "1234567890123"]) {
    expect(redact(`x ${pan} y`)).toBe(`x ${REDACTED} y`);
  }
  expect(redact(`{"card":"4111111111111111"}`)).toBe(`{"card":"${REDACTED}"}`);
});

test("ordinary text keeps its booking codes, dates, amounts and short ids", () => {
  const text = "booking NK-7Q2XKD 2026-12-01 → 2026-12-03 total NT$4,000 (4000) attempt NK-7Q2XKD-2 phone +886 2 1234 5678 at 2026-11-28 10:00";
  expect(redact(text)).toBe(text);
  expect(redact("scheduled: expired=1 attempted=0 preArrival=1 pruned=3")).toBe("scheduled: expired=1 attempted=0 preArrival=1 pruned=3");
  expect(redact("stay 2026-12-01 2026-12-03")).toBe("stay 2026-12-01 2026-12-03");
  expect(redact("123456789012")).toBe("123456789012"); // 12 digits: an amount or id, not a card
});

test("Authorization and Cookie values are masked in header, JSON and key=value forms", () => {
  expect(redact("Authorization: Bearer re_abc.def\nnext line")).toBe(`Authorization: ${REDACTED}\nnext line`);
  expect(redact("cookie: CF_Authorization=eyJ.x.y; other=1")).toBe(`cookie: ${REDACTED}`);
  expect(redact(`{"authorization":"Bearer zzz","x":1}`)).toBe(`{"authorization":"${REDACTED}","x":1}`);
  expect(redact("Set-Cookie: sid=abc; HttpOnly")).toBe(`Set-Cookie: ${REDACTED}`);
});

test("secret-named fields are masked in key=value, JSON and header forms, whatever the case", () => {
  expect(redact("password=hunter2&user=bob")).toBe(`password=${REDACTED}&user=bob`);
  expect(redact("https://x.test/cb?token=t0k3n&id=5")).toBe(`https://x.test/cb?token=${REDACTED}&id=5`);
  expect(redact(`{"HashKey":"AbC123","HashIV":"Iv456","MerchantID":"NK001"}`))
    .toBe(`{"HashKey":"${REDACTED}","HashIV":"${REDACTED}","MerchantID":"NK001"}`);
  expect(redact(`{"secret": "s3", "apiKey":"k", "n": 42, "client_secret":"c"}`))
    .toBe(`{"secret": "${REDACTED}", "apiKey":"${REDACTED}", "n": 42, "client_secret":"${REDACTED}"}`);
  expect(redact(`{"token":12345}`)).toBe(`{"token":"${REDACTED}"}`);
  expect(redact("X-Api-Key: sk_live_1 rest")).toBe(`X-Api-Key: ${REDACTED} rest`);
  expect(redact("RESEND_API_KEY=re_123 EMAIL_FROM=a@b")).toBe(`RESEND_API_KEY=${REDACTED} EMAIL_FROM=a@b`);
  expect(redact("password='p w'")).toBe(`password=${REDACTED}`);
});

test("log redacts string arguments and Error messages/stacks, keeping the console method and an Error", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const info = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  log.error("gateway said token=abc", new Error("card 4111111111111111 refused"));
  const [msg, err] = error.mock.calls[0];
  expect(msg).toBe(`gateway said token=${REDACTED}`);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe(`card ${REDACTED} refused`);
  expect((err as Error).stack).not.toContain("4111111111111111");
  log.info("plain", 3);
  expect(info).toHaveBeenCalledWith("plain", 3);
  log.warn({ password: "x", ok: 1 });
  expect(warn).toHaveBeenCalledWith({ password: REDACTED, ok: 1 });
});

test("log keeps an Error's cause chain, redacted: the root reason survives, secrets in it do not", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const root = new Error("D1_ERROR: UNIQUE constraint failed: notifications.id token=s3cr3t");
  const mid = new Error("SqliteError wrapper", { cause: root });
  const top = new Error("Failed query: insert into x params: 4111111111111111", { cause: mid });
  log.error("notify failed", top);
  const err = error.mock.calls[0][1] as Error;
  expect(err.message).toBe(`Failed query: insert into x params: ${REDACTED}`);
  const c1 = err.cause as Error;
  expect(c1).toBeInstanceOf(Error);
  expect(c1.message).toBe("SqliteError wrapper");
  const c2 = c1.cause as Error;
  expect(c2.message).toBe(`D1_ERROR: UNIQUE constraint failed: notifications.id token=${REDACTED}`);
  expect(c2.stack).not.toContain("s3cr3t");
  log.error("x", new Error("y", { cause: "password=hunter2" }));
  expect((error.mock.calls[1][1] as Error).cause).toBe(`password=${REDACTED}`);
});
