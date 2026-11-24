import { describe, expect, test } from "vitest";
import { createTestDb, rawSqlite } from "@/tests/helpers/test-db";
import { seedNk } from "@/lib/db/seed-nk";
import { properties, ratePlans, unitTypes } from "@/lib/db/schema";
import { asc } from "drizzle-orm";

describe("NK seed", () => {
  test("creates the NK Hostel property", async () => {
    const db = createTestDb();
    await seedNk(db);
    const rows = await db.select().from(properties);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("nk-hostel");
    expect(rows[0].type).toBe("hotel");
    expect(rows[0].timezone).toBe("Asia/Taipei");
  });

  test("creates the 8 room types in display order", async () => {
    const db = createTestDb();
    await seedNk(db);
    const rows = await db.select().from(unitTypes).orderBy(asc(unitTypes.sortOrder));
    expect(rows.map((r) => r.slug)).toEqual([
      "mixed-cube", "female-cube", "buddy-room", "buddy-room-six",
      "mini-room", "classic-room", "deluxe-room", "connecting-room",
    ]);
    expect(rows.map((r) => r.maxOccupancy)).toEqual([2, 2, 4, 6, 2, 2, 2, 4]);
    expect(rows[0].name["zh-TW"]).toBe("男.女混合雙人旅艙");
    expect(Object.keys(rows[0].name).sort()).toEqual(["en", "ja", "ko", "zh-TW"]);
  });

  test("creates the direct-only flexible rate plan", async () => {
    const db = createTestDb();
    await seedNk(db);
    const [rp] = await db.select().from(ratePlans);
    expect(rp.slug).toBe("direct-flex");
    expect(rp.directOnly).toBe(true);
    expect(rp.cancelPolicy).toEqual({ rules: [{ daysBefore: 3, refundPct: 100 }, { daysBefore: 1, refundPct: 50 }] });
  });

  test("seeding twice does not duplicate the property", async () => {
    const db = createTestDb();
    const a = await seedNk(db);
    const b = await seedNk(db);
    expect(b.propertyId).toBe(a.propertyId);
    expect(await db.select().from(properties)).toHaveLength(1);
  });
});

test("payments table has no card data columns", () => {
  const db = createTestDb();
  const cols = rawSqlite(db).prepare("PRAGMA table_info(payments)").all() as { name: string }[];
  expect(cols.length).toBeGreaterThan(0);
  expect(cols.filter((c) => /card|cvv|pan|expir/i.test(c.name))).toEqual([]);
});
