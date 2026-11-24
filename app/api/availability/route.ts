import { handleAvailability } from "@/lib/api/availability";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handleAvailability(await getDb(), new URL(req.url));
}
