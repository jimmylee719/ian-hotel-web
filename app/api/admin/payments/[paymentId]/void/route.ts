import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { voidFrontDeskPayment } from "@/lib/admin/front-desk";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ paymentId: string }> };

/** Void a front-desk payment taken today (owner or manager). Body: `{ reason: string }`. */
const handle = withAdmin<Route>("payments.front_desk", async (ctx, req, { params }) => {
  const { paymentId } = await params;
  const b = (await req.json().catch(() => null)) as { reason?: unknown } | null;
  if (!b || typeof b.reason !== "string") return actionError("BAD_REQUEST");
  const r = await voidFrontDeskPayment(await getDb(), ctx, paymentId, b.reason, new Date());
  if (!r.ok) return actionError(r.error);
  return Response.json(r, { headers: { "Cache-Control": "no-store" } });
});

// Next.js checks the exported handler's signature, so the route context is required here.
export async function POST(req: Request, route: Route): Promise<Response> {
  return handle(req, route);
}
