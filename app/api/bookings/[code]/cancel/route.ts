import { handleCancelBooking } from "@/lib/api/bookings";
import { getDeps } from "@/lib/runtime/deps";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return handleCancelBooking(await getDeps(new URL(req.url).origin), code, req, new Date());
}
