import { handleCancelBooking } from "@/lib/api/bookings";
import { orBookingDisabled } from "@/lib/api/booking-disabled";
import { getDeps } from "@/lib/runtime/deps";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return orBookingDisabled(async () => handleCancelBooking(await getDeps(new URL(req.url).origin), code, req, new Date()));
}
