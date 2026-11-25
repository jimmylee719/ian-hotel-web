import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { createAddon, type AddonInput } from "@/lib/admin/commerce";
import { commerceError } from "@/lib/admin/commerce-api";
import { jsonBody, ok } from "@/lib/admin/content-api";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/** Create an add-on at the current property. Body: `{ slug, name, price, unit, active? }`; answers `{ ok, id }`. */
const handle = withAdmin("commerce.edit", async (ctx, req) => {
  const b = await jsonBody(req);
  if (!b) return actionError("BAD_REQUEST");
  const r = await createAddon(await getDb(), ctx, await currentProperty(ctx), b as AddonInput, new Date());
  return r.ok ? ok(r) : commerceError(r);
});

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}
