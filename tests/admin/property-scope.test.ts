import { describe, expect, it } from "vitest";
import { currentPropertyId } from "@/lib/admin/property-scope";
import type { StaffContext } from "@/lib/admin/auth";

const ctx = (propertyIds: string[]): StaffContext => ({
  email: "a@b.c",
  staff: { id: "s1", email: "a@b.c", name: "A", role: "manager", propertyIds, active: true },
});

describe("currentPropertyId", () => {
  it("uses the cookie when it names a property the staff member may manage", () => {
    expect(currentPropertyId(ctx(["A", "B"]), "B")).toBe("B");
  });
  it("falls back to the first property when the cookie is out of scope", () => {
    expect(currentPropertyId(ctx(["A", "B"]), "Z")).toBe("A");
  });
  it("falls back to the first property when there is no cookie", () => {
    expect(currentPropertyId(ctx(["A", "B"]))).toBe("A");
  });
});
