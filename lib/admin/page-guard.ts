import { redirect } from "next/navigation";
import { AdminAuthError, requireStaff, type StaffContext } from "./auth";
import type { Permission } from "./permissions";

/**
 * For admin pages: `requireStaff`, but a 403 sends the signed-in staff member to the no-access page.
 * (A 401 never reaches a page: the admin layout stops rendering children first.)
 */
export async function requirePage(p: Permission, propertyId?: string): Promise<StaffContext> {
  try {
    return await requireStaff(p, propertyId);
  } catch (e) {
    if (e instanceof AdminAuthError && e.status === 403) redirect("/admin/forbidden");
    throw e;
  }
}
