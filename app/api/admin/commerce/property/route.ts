import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { updateProperty, type PropertyPatch } from "@/lib/admin/commerce";
import { commerceError } from "@/lib/admin/commerce-api";
import { jsonBody, ok } from "@/lib/admin/content-api";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/** Update the current property's details, check-in/out times and directions. The payment and channel ids are refused. */
const patch = withAdmin("commerce.edit", async (ctx, req) => {
  const b = await jsonBody(req);
  if (!b) return actionError("BAD_REQUEST");
  const r = await updateProperty(await getDb(), ctx, await currentProperty(ctx), b as PropertyPatch, new Date());
  return r.ok ? ok() : commerceError(r);
});

export async function PATCH(req: Request): Promise<Response> {
  return patch(req);
}
