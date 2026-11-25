"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/admin/auth";
import { PROPERTY_COOKIE } from "@/lib/admin/property-scope";
import { appEnv } from "@/lib/runtime/env";

/** Remember which property the admin is working in. The value must be one this staff member manages. */
export async function setAdminProperty(propertyId: string): Promise<{ ok: boolean }> {
  const { staff } = await requireStaff("dashboard.view");
  if (typeof propertyId !== "string" || !staff.propertyIds.includes(propertyId)) return { ok: false };
  const secure = (await appEnv()).ENVIRONMENT !== "local";
  (await cookies()).set(PROPERTY_COOKIE, propertyId, {
    path: "/admin", httpOnly: true, sameSite: "lax", secure, maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/admin", "layout");
  return { ok: true };
}
