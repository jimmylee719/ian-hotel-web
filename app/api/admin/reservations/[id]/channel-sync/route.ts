import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { retryChannelSync } from "@/lib/admin/channel-sync";
import type { Deps } from "@/lib/booking/notify";
import { getChannelDeps } from "@/lib/runtime/deps";
import { log } from "@/lib/runtime/log";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ id: string }> };

/**
 * Staff's manual retry of a booking's SiteMinder hand-off (「尚未同步到 SiteMinder」 on the reservation page).
 * Needs the channel configured (503 CHANNEL_UNAVAILABLE otherwise), not the payment gateway. Answers the booking's
 * syncState afterwards. Runs inline (no ctx.waitUntil): staff wait for the answer.
 */
const handle = withAdmin<Route>("reservations.modify", async (ctx, req, { params }) => {
  const { id } = await params;
  let deps: Deps;
  try {
    deps = await getChannelDeps(new URL(req.url).origin);
  } catch (e) {
    log.warn(`channel retry: channel unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return actionError("CHANNEL_UNAVAILABLE");
  }
  const r = await retryChannelSync(deps, ctx, id, new Date());
  if (!r.ok) return actionError(r.error);
  return Response.json(r, { headers: { "Cache-Control": "no-store" } });
});

// Next.js checks the exported handler's signature, so the route context is required here.
export async function POST(req: Request, route: Route): Promise<Response> {
  return handle(req, route);
}
