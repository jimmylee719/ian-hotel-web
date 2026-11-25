import { actionError } from "@/lib/admin/action-messages";
import { jsonBody } from "@/lib/admin/content-api";
import { withAdmin } from "@/lib/admin/auth";
import { reconcileRefund, type ReconcileAction } from "@/lib/admin/reconcile";
import { BookingDisabledError, getDeps } from "@/lib/runtime/deps";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ paymentId: string }> };

/** Body: `{ kind: "mark_succeeded", providerRef }`, `{ kind: "mark_failed" }` or `{ kind: "retry" }`. Needs online payments (503 otherwise). */
const handle = withAdmin<Route>("payments.reconcile", async (ctx, req, { params }) => {
  const { paymentId } = await params;
  const action = parseAction(await jsonBody(req));
  if (!action) return actionError("BAD_REQUEST");
  try {
    const r = await reconcileRefund(await getDeps(new URL(req.url).origin), ctx, paymentId, action, new Date());
    if (!r.ok) return actionError(r.error);
    return Response.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof BookingDisabledError) return actionError("PAYMENTS_UNAVAILABLE");
    throw e;
  }
});

// Next.js checks the exported handler's signature, so the route context is required here.
export async function POST(req: Request, route: Route): Promise<Response> {
  return handle(req, route);
}

function parseAction(b: unknown): ReconcileAction | null {
  const o = b as { kind?: unknown; providerRef?: unknown } | null;
  if (o?.kind === "mark_failed" || o?.kind === "retry") return { kind: o.kind };
  if (o?.kind === "mark_succeeded" && typeof o.providerRef === "string") return { kind: "mark_succeeded", providerRef: o.providerRef };
  return null;
}
