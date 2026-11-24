import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createTestDb } from "@/tests/helpers/test-db";
import { seedNk } from "@/lib/db/seed-nk";
import { seedContent } from "@/lib/db/seed-content";
import { contentPages, faqs, news, unitTypes, type I18n } from "@/lib/db/schema";
import type { OldSiteContent } from "@/lib/content/types";

const t = (s: string): I18n => ({ "zh-TW": `${s}-zh`, en: `${s}-en`, ja: `${s}-ja`, ko: `${s}-ko` });

const data = (): OldSiteContent => ({
  rooms: [
    { slug: "deluxe-room", description: t("desc"), bedType: t("king"), sizeSqm: 30, amenities: ["wifi", "bathtub"], images: ["rooms/a.jpg"] },
    { slug: "no-such-room", description: t("x"), bedType: t("x"), sizeSqm: 1, amenities: [], images: [] },
  ],
  pages: [
    { slug: "facilities", title: t("fac"), body: t("fac-body"), images: [], sortOrder: 0 },
    { slug: "privacy", title: t("priv"), body: t("priv-body"), images: [], sortOrder: 1 },
  ],
  faqs: [
    { slug: "qa-1", title: t("q1"), body: t("a1"), sortOrder: 0 },
    { slug: "qa-2", title: t("q2"), body: t("a2"), sortOrder: 1 },
  ],
  news: [{ slug: "news-1", title: t("n1"), body: t("nb1"), publishedAt: Date.UTC(2024, 11, 28), images: [] }],
});

describe("seedContent", () => {
  test("writes room details onto existing unit types", async () => {
    const db = createTestDb();
    const { propertyId } = await seedNk(db);
    await seedContent(db, propertyId, data());
    const [room] = await db.select().from(unitTypes).where(and(eq(unitTypes.propertyId, propertyId), eq(unitTypes.slug, "deluxe-room")));
    expect(room.description.ja).toBe("desc-ja");
    expect(room.bedType.en).toBe("king-en");
    expect(room.sizeSqm).toBe(30);
    expect(room.amenities).toEqual(["wifi", "bathtub"]);
    expect(room.name.en).toBe("DELUXE ROOM"); // untouched
  });

  test("running twice does not duplicate faqs, news or pages", async () => {
    const db = createTestDb();
    const { propertyId } = await seedNk(db);
    await seedContent(db, propertyId, data());
    const counts = async () => [
      (await db.select().from(faqs)).length,
      (await db.select().from(news)).length,
      (await db.select().from(contentPages)).length,
    ];
    const first = await counts();
    expect(first).toEqual([2, 1, 2]);
    await seedContent(db, propertyId, data());
    expect(await counts()).toEqual(first);
  });

  test("re-running updates text in place by slug and keeps ids", async () => {
    const db = createTestDb();
    const { propertyId } = await seedNk(db);
    await seedContent(db, propertyId, data());
    const [before] = await db.select().from(faqs).where(eq(faqs.slug, "qa-1"));
    const changed = data();
    changed.faqs[0].title = t("q1-edited");
    await seedContent(db, propertyId, changed);
    const [after] = await db.select().from(faqs).where(eq(faqs.slug, "qa-1"));
    expect(after.id).toBe(before.id);
    expect(after.title.ko).toBe("q1-edited-ko");
    expect(after.publishedAt).toBe(before.publishedAt);
    const [n] = await db.select().from(news);
    expect(n.publishedAt).toBe(Date.UTC(2024, 11, 28));
  });
});
