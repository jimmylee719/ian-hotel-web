import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { jsonBody, ok } from "@/lib/admin/content-api";
import { deactivateStaff, updateStaff, type StaffPatch } from "@/lib/admin/staff";
import { staffError } from "@/lib/admin/staff-api";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Route = { params: Promise<{ id: string }> };

/** Edit a staff member: any of `{ email, name, role, propertyIds, active }`. Owners only. */
const patch = withAdmin<Route>("staff.manage", async (ctx, req, { params }) => {
  const { id } = await params;
  const b = await jsonBody(req);
  if (!b) return actionError("BAD_REQUEST");
  const r = await updateStaff(await getDb(), ctx, id, b as StaffPatch, new Date());
  return r.ok ? ok() : staffError(r);
});

/** Deactivate a staff member (the row is kept; PATCH `{ active: true }` brings them back). Owners only. */
const remove = withAdmin<Route>("staff.manage", async (ctx, _req, { params }) => {
  const { id } = await params;
  const r = await deactivateStaff(await getDb(), ctx, id, new Date());
  return r.ok ? ok() : staffError(r);
});

export async function PATCH(req: Request, route: Route): Promise<Response> {
  return patch(req, route);
}

export async function DELETE(req: Request, route: Route): Promise<Response> {
  return remove(req, route);
}
