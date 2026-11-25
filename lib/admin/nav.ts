import { can, type Permission, type StaffRow } from "./permissions";

export type NavItem = { href: string; label: string; permission: Permission };

/** Every admin section, in menu order, with the permission needed to see (and open) it. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/admin/dashboard", label: "總覽", permission: "dashboard.view" },
  { href: "/admin/reservations", label: "訂單", permission: "reservations.view" },
  { href: "/admin/guests", label: "旅客", permission: "reservations.view" },
  { href: "/admin/content", label: "內容", permission: "content.edit" },
  { href: "/admin/commerce", label: "加購與折扣", permission: "commerce.edit" },
  { href: "/admin/rate-plans", label: "房價方案", permission: "commerce.edit" },
  { href: "/admin/reports", label: "報表", permission: "reports.view" },
  { href: "/admin/staff", label: "員工", permission: "staff.manage" },
  { href: "/admin/audit", label: "操作紀錄", permission: "audit.view" },
  { href: "/admin/system", label: "系統狀態", permission: "audit.view" },
];

/** The menu items this staff member may open. */
export function navItemsFor(member: StaffRow): NavItem[] {
  return NAV_ITEMS.filter((i) => can(member, i.permission));
}

export const ROLE_LABELS: Record<StaffRow["role"], string> = {
  owner: "店主",
  manager: "經理",
  front_desk: "櫃檯",
  marketing: "行銷",
};
