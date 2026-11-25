import { actionError } from "@/lib/admin/action-messages";
import { jsonBody } from "@/lib/admin/content-api";
import { withAdmin } from "@/lib/admin/auth";
import { parseModificationChange, previewModification } from "@/lib/admin/modify";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ id: string }> };

/**
 * What a modification would cost, changing nothing. Body: `{ checkIn, checkOut, adults, children, unitTypeSlug?, ratePlanSlug? }`.
 * Answers `{ ok, newQuote, difference, refundIfLower, frontDeskRefundIfLower, balanceIfHigher }`.
 */
const handle = withAdmin<Route>("reservations.modify", async (ctx, req, { params }) => {
  const { id } = await params;
  const change = parseModificationChange((await jsonBody(req)) as Record<string, unknown> | null);
  if (!change) return actionError("BAD_REQUEST");
  const r = await previewModification(await getDb(), ctx, id, change, new Date());
  if (!r.ok) return actionError(r.error, r.detail);
  return Response.json(r, { headers: { "Cache-Control": "no-store" } });
});

// Next.js checks the exported handler's signature, so the route context is required here.
export async function POST(req: Request, route: Route): Promise<Response> {
  return handle(req, route);
}
