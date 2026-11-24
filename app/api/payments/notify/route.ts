import { handleNotify } from "@/lib/api/bookings";
import { getDeps } from "@/lib/runtime/deps";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleNotify(await getDeps(new URL(req.url).origin), req, new Date());
}
