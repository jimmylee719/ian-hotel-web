import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { updateAddon, type AddonPatch } from "@/lib/admin/commerce";
import { commerceError } from "@/lib/admin/commerce-api";
import { jsonBody, ok } from "@/lib/admin/content-api";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ id: string }> };

/** Update an add-on: any of `{ slug, name, price, unit, active }`. Switch `active` off to take it off sale. */
const patch = withAdmin<Route>("commerce.edit", async (ctx, req, { params }) => {
  const { id } = await params;
  const b = await jsonBody(req);
  if (!b) return actionError("BAD_REQUEST");
  const r = await updateAddon(await getDb(), ctx, id, b as AddonPatch, new Date());
  return r.ok ? ok() : commerceError(r);
});

export async function PATCH(req: Request, route: Route): Promise<Response> {
  return patch(req, route);
}
