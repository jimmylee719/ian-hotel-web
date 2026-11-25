import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { applyModification, parseModificationChange } from "@/lib/admin/modify";
import type { Deps } from "@/lib/booking/notify";
import { BookingDisabledError, getDeps, getOfflineDeps } from "@/lib/runtime/deps";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ id: string }> };

/**
 * Modify a booking. Body: the preview's fields plus `{ expectedDifference: number, reason: string, expectedUpdatedAt?: number }`
 * (the difference and booking version the staff member saw; a different difference is 409 PRICE_CHANGED, a
 * booking changed since the preview 409 CONFLICT).
 * Without online payments it still runs, but a modification that refunds online cannot (503 PAYMENTS_UNAVAILABLE);
 * the channel modify then waits in syncState pending for the retry job.
 */
const handle = withAdmin<Route>("reservations.modify", async (ctx, req, { params }) => {
  const { id } = await params;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const change = parseModificationChange(b);
  if (!change || typeof b?.expectedDifference !== "number" || typeof b.reason !== "string"
    || (b.expectedUpdatedAt !== undefined && typeof b.expectedUpdatedAt !== "number")) return actionError("BAD_REQUEST");

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
  const r = await applyModification(deps, ctx, id, change, {
    expectedDifference: b.expectedDifference, reason: b.reason, paymentsUnavailable,
    ...(typeof b.expectedUpdatedAt === "number" ? { expectedUpdatedAt: b.expectedUpdatedAt } : {}),
  }, new Date());
  if (!r.ok) return actionError(r.error, r.detail);
  return Response.json(r, { headers: { "Cache-Control": "no-store" } });
});

// Next.js checks the exported handler's signature, so the route context is required here.
export async function POST(req: Request, route: Route): Promise<Response> {
  return handle(req, route);
}
