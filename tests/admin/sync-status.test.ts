import { describe, expect, test } from "vitest";
import { syncStatusLabel } from "@/lib/admin/sync-status";

describe("syncStatusLabel (M-3)", () => {
  test("a pending sync with no channel configured says so instead of 同步中", () => {
    expect(syncStatusLabel("pending", false)).toEqual(["通路未設定，待同步", "amber"]);
    expect(syncStatusLabel("pending", true)).toEqual(["同步中", "amber"]);
  });

  test("other states read the same either way; unknown values show as-is", () => {
    for (const configured of [true, false]) {
      expect(syncStatusLabel("synced", configured)).toEqual(["已同步", "green"]);
      expect(syncStatusLabel("failed", configured)).toEqual(["同步失敗", "red"]);
      expect(syncStatusLabel("not_required", configured)).toEqual(["無需同步", "grey"]);
      expect(syncStatusLabel("weird", configured)).toEqual(["weird", "grey"]);
    }
  });
});
