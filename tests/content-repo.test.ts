import { beforeAll, describe, expect, test } from "vitest";
import { oldSiteContent } from "@/lib/content/old-site";
import { getPage, getProperty, getRoomType, getRoomTypes, getNews, listFaqs, listNews } from "@/lib/content-repo";
import { seedContent } from "@/lib/db/seed-content";
import { seedNk } from "@/lib/db/seed-nk";
import { todayInTaipei } from "@/lib/domain/dates";
import { createTestDb, type TestDb } from "./helpers/test-db";
import { fillAri, idsFor, setAri } from "./helpers/ari";

const NOW = new Date("2026-12-01T04:00:00Z"); // 12:00 in Taipei

async function seeded() {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  await seedContent(db, propertyId, oldSiteContent());
  return { db, propertyId };
}

describe("rooms", () => {
  let db: TestDb;
  beforeAll(async () => ({ db } = await seeded()));

  test("getRoomType returns the localised room, or null for an unknown slug", async () => {
    const room = await getRoomType(db, "nk-hostel", "deluxe-room", "en", NOW);
    expect(room?.name).toBe("DELUXE ROOM");
    expect(room?.images.length).toBeGreaterThan(0);
    expect(room?.amenities).toContain("bathtub");
    expect(room?.description).not.toBe("");
    expect(await getRoomType(db, "nk-hostel", "no-such-room", "en", NOW)).toBeNull();
    expect(await getRoomType(db, "no-such-hotel", "deluxe-room", "en", NOW)).toBeNull();
  });

  test("getRoomTypes lists all eight in sort order with a cover photo and no price without ARI", async () => {
    const rooms = await getRoomTypes(db, "nk-hostel", "zh-TW", NOW);
    expect(rooms.map((r) => r.slug)).toEqual([
      "mixed-cube", "female-cube", "buddy-room", "buddy-room-six", "mini-room", "classic-room", "deluxe-room", "connecting-room",
    ]);
    expect(rooms[0].name).toBe("男.女混合雙人旅艙");
    expect(rooms[0].nameEn).toBe("MIXED CUBE");
    for (const r of rooms) {
      expect(r.image, r.slug).toMatch(/^rooms\//);
      expect(r.fromPrice).toBeNull();
    }
  });
});

describe("lowest price over the next 7 days", () => {
  test("ignores sold-out, stop-sell and out-of-window nights", async () => {
    const { db, propertyId } = await seeded();
    const today = todayInTaipei(NOW); // 2026-12-01
    await fillAri(db, propertyId, today, 10, { price: 3000 });
    const { unitTypeId, ratePlanId } = await idsFor(db, "deluxe-room");
    await setAri(db, unitTypeId, ratePlanId, "2026-12-02", { price: 1000, available: 0 }); // sold out
    await setAri(db, unitTypeId, ratePlanId, "2026-12-03", { price: 1100, stopSell: true });
    await setAri(db, unitTypeId, ratePlanId, "2026-12-08", { price: 1200 }); // day 8: outside the window
    await setAri(db, unitTypeId, ratePlanId, "2026-12-07", { price: 2500 }); // day 7: inside
    const room = await getRoomType(db, "nk-hostel", "deluxe-room", "en", NOW);
    expect(room?.fromPrice).toBe(2500);
    const cards = await getRoomTypes(db, "nk-hostel", "en", NOW);
    expect(cards.find((c) => c.slug === "classic-room")?.fromPrice).toBe(3000);
  });
});

describe("pages, news and FAQs", () => {
  let db: TestDb;
  beforeAll(async () => ({ db } = await seeded()));

  test("getProperty", async () => {
    expect((await getProperty(db, "nk-hostel"))?.name.en).toBe("NK Hostel");
    expect(await getProperty(db, "nope")).toBeNull();
  });

  test("getPage returns the localised page or null", async () => {
    const page = await getPage(db, "nk-hostel", "access", "ja");
    expect(page?.title).toBe("アクセス");
    expect(page?.body).not.toBe("");
    expect(await getPage(db, "nk-hostel", "missing", "ja")).toBeNull();
  });

  test("listNews is newest first; getNews finds one by slug", async () => {
    const items = await listNews(db, "nk-hostel", "en");
    expect(items.map((n) => n.slug)).toEqual(["news-281", "news-184"]); // only localised items are seeded
    const dates = items.map((n) => n.publishedAt ?? 0);
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    const one = await getNews(db, "nk-hostel", "news-184", "ko");
    expect(one?.title).not.toBe("");
    expect(one?.images.length).toBeGreaterThan(0);
    expect(await getNews(db, "nk-hostel", "news-0", "ko")).toBeNull();
  });

  test("listFaqs returns all FAQs in order", async () => {
    const faqs = await listFaqs(db, "nk-hostel", "en");
    expect(faqs.length).toBe(18);
    expect(faqs[0].slug).toBe("qa-8-1");
    expect(faqs[0].question).not.toBe("");
  });
});
