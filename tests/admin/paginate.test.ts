import { describe, expect, it } from "vitest";
import { count } from "drizzle-orm";
import { paginate } from "@/lib/admin/paginate";
import { faqs, properties } from "@/lib/db/schema";
import { createTestDb } from "../helpers/test-db";

function setup(n: number) {
  const db = createTestDb();
  db.insert(properties).values({
    id: "P", slug: "p", type: "hotel", name: { "zh-TW": "P" }, timezone: "Asia/Taipei", currency: "TWD",
    address: { "zh-TW": "x" }, phone: "1", email: "p@x.y", createdAt: 0,
  } as never).run();
  for (let i = 0; i < n; i++)
    db.insert(faqs).values({ id: `f${i}`, propertyId: "P", slug: `f${i}`, title: { "zh-TW": "q" }, body: { "zh-TW": "a" }, sortOrder: i } as never).run();
  return {
    rows: (limit: number, offset: number) => db.select().from(faqs).orderBy(faqs.sortOrder).limit(limit).offset(offset),
    total: async () => (await db.select({ n: count() }).from(faqs))[0].n,
  };
}

describe("paginate", () => {
  it("returns the last partial page", async () => {
    const r = await paginate(setup(45), { page: 3, pageSize: 20 });
    expect(r.rows).toHaveLength(5);
    expect(r).toMatchObject({ total: 45, page: 3, pageCount: 3 });
  });
  it("caps pageSize at 100", async () => {
    const r = await paginate(setup(150), { page: 1, pageSize: 500 });
    expect(r.rows).toHaveLength(100);
    expect(r.pageCount).toBe(2);
  });
  it("defaults pageSize to 20 and clamps the page into range", async () => {
    const r = await paginate(setup(45), { page: 99 });
    expect(r.page).toBe(3);
    expect(r.rows).toHaveLength(5);
    const first = await paginate(setup(45), { page: 0 });
    expect(first.page).toBe(1);
    expect(first.rows).toHaveLength(20);
  });
  it("reports one empty page when there are no rows", async () => {
    const r = await paginate(setup(0), { page: 1 });
    expect(r).toMatchObject({ rows: [], total: 0, page: 1, pageCount: 1 });
  });
});
