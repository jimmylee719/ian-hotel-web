import { actionError } from "@/lib/admin/action-messages";
import { jsonBody } from "@/lib/admin/content-api";
import { withAdmin } from "@/lib/admin/auth";
import { OFFLINE_REFUND_METHODS, reconcileRefund, type OfflineRefundMethod, type ReconcileAction } from "@/lib/admin/reconcile";
import { BookingDisabledError, getDeps, getDepsOrOffline } from "@/lib/runtime/deps";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ paymentId: string }> };

/**
 * Body: `{ kind: "mark_succeeded", providerRef }`, `{ kind: "mark_failed" }`, `{ kind: "retry" }` or
 * `{ kind: "settle_offline", reference, method: "transfer" | "cash" | "edc" }`. settle_offline works without online
 * payments configured (db and email only; the gateway is not asked first); the others need them (503 otherwise).
 */
const handle = withAdmin<Route>("payments.reconcile", async (ctx, req, { params }) => {
  const { paymentId } = await params;
  const action = parseAction(await jsonBody(req));
  if (!action) return actionError("BAD_REQUEST");
  try {
    const origin = new URL(req.url).origin;
    const { deps, paymentsUnavailable } = action.kind === "settle_offline"
      ? await getDepsOrOffline(origin) : { deps: await getDeps(origin), paymentsUnavailable: false };
    const r = await reconcileRefund(deps, ctx, paymentId, action, new Date(), { paymentsUnavailable });
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
  const o = b as { kind?: unknown; providerRef?: unknown; reference?: unknown; method?: unknown } | null;
  if (o?.kind === "mark_failed" || o?.kind === "retry") return { kind: o.kind };
  if (o?.kind === "mark_succeeded" && typeof o.providerRef === "string") return { kind: "mark_succeeded", providerRef: o.providerRef };
  if (o?.kind === "settle_offline" && typeof o.reference === "string" && OFFLINE_REFUND_METHODS.includes(o.method as OfflineRefundMethod))
    return { kind: "settle_offline", reference: o.reference, method: o.method as OfflineRefundMethod };
  return null;
}
