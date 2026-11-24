import { handleBookingStatus } from "@/lib/api/bookings";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return handleBookingStatus(await getDb(), code, req, new Date());
}
