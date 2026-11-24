import { expect, test } from "vitest";
import { ratePlans, unitTypes } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import { createTestDb } from "@/tests/helpers/test-db";

test("room type and rate plan names are translated into all four languages", async () => {
  const db = createTestDb();
  await seedNk(db);
  const rows = [...(await db.select().from(unitTypes)), ...(await db.select().from(ratePlans))];
  expect(rows.length).toBe(9);
  for (const r of rows) {
    const n = r.name;
    expect(new Set([n["zh-TW"], n.en, n.ja, n.ko]).size, JSON.stringify(n)).toBe(4);
  }
});
