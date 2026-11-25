import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { toCsv } from "@/lib/admin/csv";
import { can } from "@/lib/admin/permissions";
import { currentProperty } from "@/lib/admin/property-scope";
import { REPORT_KINDS, runReport, validateRange, type ReportKind } from "@/lib/admin/reports";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ kind: string }> };

/**
 * `GET /api/admin/reports/<revenue|occupancy|bookings|cancellations>?from=&to=&format=json|csv[&groupBy=day|month]`.
 * Needs `reports.view` at the current property; from ≤ to, at most 366 days. CSV comes as an attachment named
 * `<kind>-<from>-<to>.csv` (ASCII), never cached.
 */
const handle = withAdmin<Route>("reports.view", async (ctx, req, { params }) => {
  const { kind } = await params;
  if (!(REPORT_KINDS as readonly string[]).includes(kind)) return actionError("NOT_FOUND");
  const propertyId = await currentProperty(ctx);
  if (!propertyId || !can(ctx.staff, "reports.view", propertyId)) return actionError("FORBIDDEN");

  const q = new URL(req.url).searchParams;
  const from = q.get("from") ?? "";
  const to = q.get("to") ?? "";
  const format = q.get("format") ?? "json";
  const groupBy = q.get("groupBy") ?? "day";
  if (format !== "json" && format !== "csv") return actionError("BAD_REQUEST");
  if (groupBy !== "day" && groupBy !== "month") return actionError("BAD_REQUEST");
  const range = validateRange(from, to);
  if (!range.ok) return actionError(range.error);

  const out = await runReport(await getDb(), propertyId, kind as ReportKind, { from, to }, groupBy);
  const noStore = { "Cache-Control": "no-store" };
  if (format === "json") return Response.json(out.data, { headers: noStore });
  return new Response(toCsv(out.csv.rows, out.csv.columns), {
    headers: {
      ...noStore,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${kind}-${from}-${to}.csv"`,
    },
  });
});

// Next.js checks the exported handler's signature, so the route context is required here.
export async function GET(req: Request, route: Route): Promise<Response> {
  return handle(req, route);
}
