import type { staff } from "@/lib/db/schema";

export type StaffRow = typeof staff.$inferSelect;
export type StaffRole = StaffRow["role"];

export const PERMISSIONS = [
  "dashboard.view",
  "reservations.view",
  "reservations.cancel",
  "reservations.refund_override",
  "reservations.modify",
  "payments.front_desk",
  "payments.reconcile",
  "notifications.resend",
  "content.edit",
  "commerce.edit",
  "reports.view",
  "staff.manage",
  "audit.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** The one permission matrix (plan 3 Global Constraints). */
export const ROLE_PERMISSIONS: Record<StaffRole, Permission[]> = {
  owner: [...PERMISSIONS],
  manager: PERMISSIONS.filter((p) => p !== "staff.manage"),
  front_desk: [
    "dashboard.view",
    "reservations.view",
    "reservations.cancel",
    "reservations.modify",
    "payments.front_desk",
    "notifications.resend",
  ],
  marketing: ["dashboard.view", "content.edit"],
};

/**
 * Whether this staff member may do `p`, and, when `propertyId` is given, do it at that property.
 * Every role, owner included, is limited to `staff.propertyIds`. Inactive staff may do nothing.
 */
export function can(member: StaffRow, p: Permission, propertyId?: string): boolean {
  if (!member.active) return false;
  if (!ROLE_PERMISSIONS[member.role].includes(p)) return false;
  if (propertyId !== undefined && !member.propertyIds.includes(propertyId)) return false;
  return true;
}
