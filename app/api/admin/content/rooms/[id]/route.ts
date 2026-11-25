import { getCloudflareContext } from "@opennextjs/cloudflare";
import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { updateUnitType } from "@/lib/admin/content";
import { contentError, jsonBody, ok, unitTypePatchOf } from "@/lib/admin/content-api";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ id: string }> };

/** Update a room type: any of name / description / bedType (I18n), amenities, numbers, active, images (R2 keys). */
const handle = withAdmin<Route>("content.edit", async (ctx, req, { params }) => {
  const { id } = await params;
  const b = await jsonBody(req);
  if (!b) return actionError("BAD_REQUEST");
  const { env } = await getCloudflareContext({ async: true });
  const r = await updateUnitType(await getDb(), ctx, id, unitTypePatchOf(b), env.MEDIA, new Date());
  return r.ok ? ok() : contentError(r);
});

export async function PATCH(req: Request, route: Route): Promise<Response> {
  return handle(req, route);
}
