import { describe, expect, test } from "vitest";
import { LOCALES } from "@/lib/db/schema";
import { oldSiteContent, REQUIRED_PAGES } from "@/lib/content/old-site";

describe("committed old-site content", () => {
  const content = oldSiteContent();

  test("has all 8 room types, each with a photo and a description in every locale", () => {
    expect(content.rooms.map((r) => r.slug).sort()).toEqual(
      ["buddy-room", "buddy-room-six", "classic-room", "connecting-room", "deluxe-room", "female-cube", "mini-room", "mixed-cube"],
    );
    for (const r of content.rooms) {
      expect(r.images.length, r.slug).toBeGreaterThan(0);
      for (const l of LOCALES) {
        expect(r.description[l].trim(), `${r.slug} ${l}`).not.toBe("");
        expect(r.bedType[l].trim(), `${r.slug} ${l}`).not.toBe("");
      }
    }
  });

  test("has every required content page, faqs and news fully localised", () => {
    expect(content.pages.map((p) => p.slug).sort()).toEqual([...REQUIRED_PAGES].sort());
    expect(content.faqs.length).toBeGreaterThan(10);
    for (const item of [...content.pages, ...content.faqs, ...content.news])
      for (const l of LOCALES) {
        expect(item.title[l].trim(), `${item.slug} ${l}`).not.toBe("");
        expect(item.body[l].trim(), `${item.slug} ${l}`).not.toBe("");
      }
  });
});
