import { handleInquiry } from "@/lib/api/inquiry";
import { getCoreDeps } from "@/lib/runtime/deps";

export const dynamic = "force-dynamic";

// Needs no payment gateway, so inquiries keep working while PAYMENT_MODE is unset.
export async function POST(req: Request) {
  return handleInquiry(await getCoreDeps(new URL(req.url).origin), req, new Date());
}
