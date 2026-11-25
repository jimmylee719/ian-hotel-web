import { cookies } from "next/headers";
import type { StaffContext } from "./auth";

export const PROPERTY_COOKIE = "admin_property";

/**
 * The property the admin is currently working in: the `admin_property` cookie when it names one the staff
 * member may manage, otherwise their first property. The cookie is only a preference; it is never trusted.
 */
export function currentPropertyId(ctx: StaffContext, cookieValue?: string): string {
  const ids = ctx.staff.propertyIds;
  return cookieValue && ids.includes(cookieValue) ? cookieValue : ids[0];
}

/** Server Components: `currentPropertyId` using this request's cookie. */
export async function currentProperty(ctx: StaffContext): Promise<string> {
  return currentPropertyId(ctx, (await cookies()).get(PROPERTY_COOKIE)?.value);
}
