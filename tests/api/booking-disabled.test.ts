import { expect, test } from "vitest";
import { orBookingDisabled } from "@/lib/api/booking-disabled";
import { BookingDisabledError } from "@/lib/runtime/deps";

test("a booking route answers 503 BOOKING_DISABLED while payments are not configured", async () => {
  const res = await orBookingDisabled(async () => { throw new BookingDisabledError(); });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ ok: false, error: "BOOKING_DISABLED" });
});

test("other responses pass through and other errors still propagate", async () => {
  expect((await orBookingDisabled(async () => new Response("ok", { status: 201 }))).status).toBe(201);
  await expect(orBookingDisabled(async () => { throw new Error("db down"); })).rejects.toThrow("db down");
});
