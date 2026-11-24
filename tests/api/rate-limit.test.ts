import { expect, test } from "vitest";
import { checkRate, clientIp } from "@/lib/api/rate-limit";
import { createTestDb } from "@/tests/helpers/test-db";

const T0 = new Date("2026-11-24T02:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

test("allows `limit` requests per window, refuses the next, and resets in the next window", async () => {
  const db = createTestDb();
  for (let i = 0; i < 10; i++) expect(await checkRate(db, "status:1.2.3.4", 10, 60, at(i))).toBe(true);
  expect(await checkRate(db, "status:1.2.3.4", 10, 60, at(30))).toBe(false);
  // Other keys have their own counter.
  expect(await checkRate(db, "status:5.6.7.8", 10, 60, at(30))).toBe(true);
  // T0 is on a minute boundary, so the next window starts at +60s.
  expect(await checkRate(db, "status:1.2.3.4", 10, 60, at(60))).toBe(true);
  for (let i = 0; i < 9; i++) expect(await checkRate(db, "status:1.2.3.4", 10, 60, at(61))).toBe(true);
  expect(await checkRate(db, "status:1.2.3.4", 10, 60, at(62))).toBe(false);
});

test("the client IP comes from cf-connecting-ip", () => {
  expect(clientIp(new Request("http://x", { headers: { "cf-connecting-ip": "9.9.9.9" } }))).toBe("9.9.9.9");
  expect(clientIp(new Request("http://x"))).toBe("unknown");
});
