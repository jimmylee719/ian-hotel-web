import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { updatePromo, type PromoPatch } from "@/lib/admin/commerce";
import { commerceError } from "@/lib/admin/commerce-api";
import { jsonBody, ok } from "@/lib/admin/content-api";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ id: string }> };

/** Update a promo code: any of `{ code, kind, value, validFrom, validTo, maxUses, active }`. `usedCount` is refused. */
const patch = withAdmin<Route>("commerce.edit", async (ctx, req, { params }) => {
  const { id } = await params;
  const b = await jsonBody(req);
  if (!b) return actionError("BAD_REQUEST");
  const r = await updatePromo(await getDb(), ctx, id, b as PromoPatch, new Date());
  return r.ok ? ok() : commerceError(r);
});

export async function PATCH(req: Request, route: Route): Promise<Response> {
  return patch(req, route);
}
