import { describe, expect, it } from "vitest";
import { navItemsFor } from "@/lib/admin/nav";
import type { StaffRow } from "@/lib/admin/permissions";

const member = (role: StaffRow["role"], active = true): StaffRow => ({
  id: "s", email: "s@x.y", name: "S", role, propertyIds: ["A"], active,
});
const labels = (role: StaffRow["role"]) => navItemsFor(member(role)).map((i) => i.label);

describe("navItemsFor", () => {
  it("shows everything to the owner", () => {
    expect(labels("owner")).toEqual(["總覽", "訂單", "旅客", "退款對帳", "內容", "加購與折扣", "房價方案", "報表", "員工", "操作紀錄", "系統狀態"]);
  });
  it("hides staff management from managers", () => {
    expect(labels("manager")).not.toContain("員工");
    expect(labels("manager")).toContain("操作紀錄");
  });
  it("shows front desk only the booking screens", () => {
    expect(labels("front_desk")).toEqual(["總覽", "訂單", "旅客"]);
  });
  it("shows marketing only the dashboard and content", () => {
    expect(labels("marketing")).toEqual(["總覽", "內容"]);
  });
  it("shows inactive staff nothing", () => {
    expect(navItemsFor(member("owner", false))).toEqual([]);
  });
});
