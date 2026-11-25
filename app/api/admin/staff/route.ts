import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { jsonBody, ok } from "@/lib/admin/content-api";
import { createStaff, type StaffInput } from "@/lib/admin/staff";
import { staffError } from "@/lib/admin/staff-api";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/** Add a staff member. Body: `{ email, name, role, propertyIds }`; answers `{ ok, id }`. Owners only. */
const handle = withAdmin("staff.manage", async (ctx, req) => {
  const b = await jsonBody(req);
  if (!b) return actionError("BAD_REQUEST");
  const r = await createStaff(await getDb(), ctx, b as StaffInput, new Date());
  return r.ok ? ok(r) : staffError(r);
});

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}
