import { handleInquiry } from "@/lib/api/inquiry";
import { getDeps } from "@/lib/runtime/deps";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleInquiry(await getDeps(new URL(req.url).origin), req, new Date());
}
