import { expect, test } from "vitest";
import { orBookingDisabled } from "@/lib/api/booking-disabled";
import { BookingDisabledError, buildDeps } from "@/lib/runtime/deps";
import { createTestDb } from "@/tests/helpers/test-db";

test("a booking route answers 503 BOOKING_DISABLED while payments are not configured", async () => {
  const res = await orBookingDisabled(async () => { throw new BookingDisabledError(); });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ ok: false, error: "BOOKING_DISABLED" });
});

test("other responses pass through and other errors still propagate", async () => {
  expect((await orBookingDisabled(async () => new Response("ok", { status: 201 }))).status).toBe(201);
  await expect(orBookingDisabled(async () => { throw new Error("db down"); })).rejects.toThrow("db down");
});

// The route glue is orBookingDisabled(getDeps(...)); getDeps is buildDeps over the Worker env.
const db = createTestDb();
const via = (env: Record<string, string>) =>
  orBookingDisabled(async () => { buildDeps(env, db, "http://x"); return new Response("ok"); });

test("POST /api/bookings answers 503 when CHANNEL_MODE is unset", async () => {
  const res = await via({ PAYMENT_MODE: "mock", ENVIRONMENT: "local" });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ ok: false, error: "BOOKING_DISABLED" });
});

test("ENVIRONMENT=production with PAYMENT_MODE=mock answers 503", async () => {
  expect((await via({ PAYMENT_MODE: "mock", CHANNEL_MODE: "mock", ENVIRONMENT: "production" })).status).toBe(503);
  expect((await via({ PAYMENT_MODE: "mock", CHANNEL_MODE: "mock", ENVIRONMENT: "local" })).status).toBe(200);
});
