import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLE_PERMISSIONS, can, type Permission, type StaffRow } from "@/lib/admin/permissions";

// The Global Constraints matrix, row by row: owner, manager, front_desk, marketing.
const MATRIX: Record<Permission, [boolean, boolean, boolean, boolean]> = {
  "dashboard.view": [true, true, true, true],
  "reservations.view": [true, true, true, false],
  "reservations.cancel": [true, true, true, false],
  "reservations.refund_override": [true, true, false, false],
  "reservations.modify": [true, true, true, false],
  "payments.front_desk": [true, true, true, false],
  "payments.reconcile": [true, true, false, false],
  "notifications.resend": [true, true, true, false],
  "content.edit": [true, true, false, true],
  "commerce.edit": [true, true, false, false],
  "reports.view": [true, true, false, false],
  "staff.manage": [true, false, false, false],
  "audit.view": [true, true, false, false],
};
const ROLES = ["owner", "manager", "front_desk", "marketing"] as const;

const member = (role: StaffRow["role"], propertyIds = ["A"], active = true): StaffRow =>
  ({ id: "s1", email: "x@nk.com", name: "X", role, propertyIds, active });

describe("permission matrix", () => {
  it("lists exactly the 13 permissions", () => {
    expect([...PERMISSIONS].sort()).toEqual(Object.keys(MATRIX).sort());
    expect(PERMISSIONS).toHaveLength(13);
  });

  for (const [p, row] of Object.entries(MATRIX) as [Permission, boolean[]][]) {
    ROLES.forEach((role, i) => {
      it(`${role} ${row[i] ? "has" : "lacks"} ${p}`, () => {
        expect(ROLE_PERMISSIONS[role].includes(p)).toBe(row[i]);
        expect(can(member(role), p)).toBe(row[i]);
      });
    });
  }
});

describe("can: property scope", () => {
  it("allows a property in staff.propertyIds", () => {
    expect(can(member("front_desk", ["A"]), "reservations.view", "A")).toBe(true);
  });
  it("refuses a property outside staff.propertyIds", () => {
    expect(can(member("front_desk", ["A"]), "reservations.view", "B")).toBe(false);
  });
  it("limits owners to their properties too", () => {
    expect(can(member("owner", ["A"]), "staff.manage", "B")).toBe(false);
  });
  it("refuses inactive staff", () => {
    expect(can(member("owner", ["A"], false), "dashboard.view")).toBe(false);
  });
});
