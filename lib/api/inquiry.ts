import { submitInquiry, type InquiryDeps, type InquiryInput } from "@/lib/inquiry";
import { checkRate, clientIp, RATE, retryAfterSec, tooManyRequests } from "./rate-limit";

/** POST /api/inquiry: group / long-stay inquiry, at most 5 per IP per minute. */
export async function handleInquiry(deps: InquiryDeps, req: Request, now: Date): Promise<Response> {
  if (Number(req.headers.get("content-length") ?? 0) > 20_000) return Response.json({ ok: false, error: "TOO_LARGE" }, { status: 413 });
  if (!(await checkRate(deps.db, `inquiry:${clientIp(req)}`, RATE.inquiry, 60, now))) return tooManyRequests(retryAfterSec(60, now));
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ ok: false, error: "VALIDATION", fields: [] }, { status: 400 });

  const result = await submitInquiry(deps, body as InquiryInput, now); // validated inside
  if (result.ok) return Response.json(result);
  return Response.json(result, { status: result.error === "VALIDATION" ? 400 : 502 });
}
