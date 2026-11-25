import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { staffCancel } from "@/lib/admin/staff-cancel";
import type { Deps } from "@/lib/booking/notify";
import { BookingDisabledError, getDeps, getOfflineDeps } from "@/lib/runtime/deps";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ id: string }> };

/**
 * Staff cancel. Body: `{ reason: string, notifyGuest: boolean, refundOverride?: number }`.
 * Without online payments it still runs, but only a cancellation refunding 0 can go through
 * (otherwise 503 PAYMENTS_UNAVAILABLE, "線上金流未設定，無法執行退款").
 */
const handle = withAdmin<Route>("reservations.cancel", async (ctx, req, { params }) => {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { reason?: unknown; notifyGuest?: unknown; refundOverride?: unknown } | null;
  if (!body || typeof body.reason !== "string" || (body.refundOverride !== undefined && typeof body.refundOverride !== "number"))
    return actionError("BAD_REQUEST");

  const origin = new URL(req.url).origin;
  let deps: Deps;
  let paymentsUnavailable = false;
  try {
    deps = await getDeps(origin);
  } catch (e) {
    if (!(e instanceof BookingDisabledError)) throw e;
    deps = await getOfflineDeps(origin);
    paymentsUnavailable = true;
  }
  const r = await staffCancel(deps, ctx, id, {
    reason: body.reason,
    notifyGuest: body.notifyGuest !== false,
    refundOverride: body.refundOverride as number | undefined,
    paymentsUnavailable,
  }, new Date());
  if (!r.ok) return actionError(r.error);
  return Response.json(r, { headers: { "Cache-Control": "no-store" } });
});

// Next.js checks the exported handler's signature, so the route context is required here.
export async function POST(req: Request, route: Route): Promise<Response> {
  return handle(req, route);
}
