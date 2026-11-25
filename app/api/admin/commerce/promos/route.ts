import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { createPromo, type PromoInput } from "@/lib/admin/commerce";
import { commerceError } from "@/lib/admin/commerce-api";
import { jsonBody, ok } from "@/lib/admin/content-api";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/** Create a promo code at the current property. Body: `{ code, kind, value, validFrom?, validTo?, maxUses?, active? }`. */
const handle = withAdmin("commerce.edit", async (ctx, req) => {
  const b = await jsonBody(req);
  if (!b) return actionError("BAD_REQUEST");
  const r = await createPromo(await getDb(), ctx, await currentProperty(ctx), b as PromoInput, new Date());
  return r.ok ? ok(r) : commerceError(r);
});

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}
