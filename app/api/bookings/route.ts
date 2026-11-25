import { handleCreateBooking } from "@/lib/api/bookings";
import { orBookingDisabled } from "@/lib/api/booking-disabled";
import { bookingEnabled, getDeps } from "@/lib/runtime/deps";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!(await bookingEnabled())) {
    return Response.json({ ok: false, error: "BOOKING_DISABLED" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return orBookingDisabled(async () => handleCreateBooking(await getDeps(new URL(req.url).origin), req, new Date()));
}
