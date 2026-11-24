import { handleQuote } from "@/lib/api/bookings";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleQuote(await getDb(), req, new Date());
}
