import { handleCreateBooking } from "@/lib/api/bookings";
import { orBookingDisabled } from "@/lib/api/booking-disabled";
import { getDeps } from "@/lib/runtime/deps";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return orBookingDisabled(async () => handleCreateBooking(await getDeps(new URL(req.url).origin), req, new Date()));
}
