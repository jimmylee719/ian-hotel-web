import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { retryChannelSync } from "@/lib/admin/channel-sync";
import { BookingDisabledError, getDeps } from "@/lib/runtime/deps";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ id: string }> };

/**
 * Staff's manual retry of a booking's SiteMinder hand-off (「尚未同步到 SiteMinder」 on the reservation page).
 * Needs the channel configured (503 CHANNEL_UNAVAILABLE otherwise). Answers the booking's syncState afterwards.
 */
const handle = withAdmin<Route>("reservations.modify", async (ctx, req, { params }) => {
  const { id } = await params;
  let deps;
  try {
    deps = await getDeps(new URL(req.url).origin);
  } catch (e) {
    if (!(e instanceof BookingDisabledError)) throw e;
    return actionError("CHANNEL_UNAVAILABLE");
  }
  // Inline, not deferred: staff wait for the answer.
  const r = await retryChannelSync({ ...deps, defer: undefined }, ctx, id, new Date());
  if (!r.ok) return actionError(r.error);
  return Response.json(r, { headers: { "Cache-Control": "no-store" } });
});

// Next.js checks the exported handler's signature, so the route context is required here.
export async function POST(req: Request, route: Route): Promise<Response> {
  return handle(req, route);
}
