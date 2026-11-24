import { handleCreateBooking } from "@/lib/api/bookings";
import { getDeps } from "@/lib/runtime/deps";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleCreateBooking(await getDeps(new URL(req.url).origin), req, new Date());
}
