import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { createFaq, type ContentItemInput } from "@/lib/admin/content";
import { contentError, itemPatchOf, jsonBody, ok } from "@/lib/admin/content-api";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/** Create a FAQ at the current property. Body: `{ slug, title, body, publishedAt, sortOrder? }`; answers `{ ok, id }`. */
const handle = withAdmin("content.edit", async (ctx, req) => {
  const b = await jsonBody(req);
  if (!b) return actionError("BAD_REQUEST");
  const input = { publishedAt: null, ...itemPatchOf(b) } as ContentItemInput;
  const r = await createFaq(await getDb(), ctx, await currentProperty(ctx), input, new Date());
  return r.ok ? ok(r) : contentError(r);
});

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}
