import { BookingDisabledError } from "@/lib/runtime/deps";

/**
 * Run a booking route handler; while payments are not configured (PAYMENT_MODE unset) answer
 * 503 BOOKING_DISABLED instead of crashing. Any other error propagates.
 */
export async function orBookingDisabled(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof BookingDisabledError) {
      return Response.json({ ok: false, error: "BOOKING_DISABLED" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    throw e;
  }
}
