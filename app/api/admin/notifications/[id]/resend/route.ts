import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { resendNotification } from "@/lib/admin/resend";
import { getCoreDeps } from "@/lib/runtime/deps";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ id: string }> };

/** Resend a failed email. Needs only the email deps, so it works while online payments are off. */
const handle = withAdmin<Route>("notifications.resend", async (ctx, req, { params }) => {
  const { id } = await params;
  const r = await resendNotification(await getCoreDeps(new URL(req.url).origin), ctx, id, new Date());
  if (!r.ok) return actionError(r.error);
  return Response.json(r, { headers: { "Cache-Control": "no-store" } });
});

// Next.js checks the exported handler's signature, so the route context is required here.
export async function POST(req: Request, route: Route): Promise<Response> {
  return handle(req, route);
}
