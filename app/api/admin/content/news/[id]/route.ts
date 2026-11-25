import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { deleteNews, updateNews } from "@/lib/admin/content";
import { contentError, itemPatchOf, jsonBody, ok } from "@/lib/admin/content-api";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ id: string }> };

/** Update a news item: any of `{ slug, title, body, publishedAt, sortOrder }`. */
const patch = withAdmin<Route>("content.edit", async (ctx, req, { params }) => {
  const { id } = await params;
  const b = await jsonBody(req);
  if (!b) return actionError("BAD_REQUEST");
  const r = await updateNews(await getDb(), ctx, id, itemPatchOf(b), new Date());
  return r.ok ? ok() : contentError(r);
});

/** "Delete" a news item: unpublish it (publishedAt = null). The row is kept and can be published again. */
const remove = withAdmin<Route>("content.edit", async (ctx, _req, { params }) => {
  const { id } = await params;
  const r = await deleteNews(await getDb(), ctx, id, new Date());
  return r.ok ? ok() : contentError(r);
});

export async function PATCH(req: Request, route: Route): Promise<Response> {
  return patch(req, route);
}

export async function DELETE(req: Request, route: Route): Promise<Response> {
  return remove(req, route);
}
