import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { FRONT_DESK_METHODS, recordFrontDeskPayment, type FrontDeskMethod } from "@/lib/admin/front-desk";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ id: string }> };

const optionalString = (v: unknown) => v === undefined || v === null || typeof v === "string";

/**
 * Record a front-desk payment. Body: `{ method: "edc" | "cash" | "transfer", amount: number, last4?, authCode?, note? }`.
 * Answers `{ ok, paymentId, balanceDue }`. Works without online payments: the gateway is not involved.
 */
const handle = withAdmin<Route>("payments.front_desk", async (ctx, req, { params }) => {
  const { id } = await params;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || !FRONT_DESK_METHODS.includes(b.method as FrontDeskMethod) || typeof b.amount !== "number"
    || !optionalString(b.last4) || !optionalString(b.authCode) || !optionalString(b.note))
    return actionError("BAD_REQUEST");
  const r = await recordFrontDeskPayment(await getDb(), ctx, id, {
    method: b.method as FrontDeskMethod,
    amount: b.amount,
    last4: (b.last4 as string | null) ?? undefined,
    authCode: (b.authCode as string | null) ?? undefined,
    note: (b.note as string | null) ?? undefined,
  }, new Date());
  if (!r.ok) return actionError(r.error);
  return Response.json(r, { headers: { "Cache-Control": "no-store" } });
});

// Next.js checks the exported handler's signature, so the route context is required here.
export async function POST(req: Request, route: Route): Promise<Response> {
  return handle(req, route);
}
