import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { updateRatePlan, type RatePlanPatch } from "@/lib/admin/commerce";
import { commerceError } from "@/lib/admin/commerce-api";
import { jsonBody, ok } from "@/lib/admin/content-api";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ id: string }> };

/** Update a rate plan's terms. `smRatePlanCode` (and anything not listed in lib/admin/commerce) is refused. */
const patch = withAdmin<Route>("commerce.edit", async (ctx, req, { params }) => {
  const { id } = await params;
  const b = await jsonBody(req);
  if (!b) return actionError("BAD_REQUEST");
  const r = await updateRatePlan(await getDb(), ctx, id, b as RatePlanPatch, new Date());
  return r.ok ? ok() : commerceError(r);
});

export async function PATCH(req: Request, route: Route): Promise<Response> {
  return patch(req, route);
}
