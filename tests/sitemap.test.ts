import { describe, expect, test } from "vitest";
import { SITE_URL } from "@/lib/seo";
import { sitemapEntries, STATIC_PATHS } from "@/lib/sitemap";

describe("sitemapEntries", () => {
  const entries = sitemapEntries(["deluxe-room", "classic-room"], ["news-281"]);

  test("one entry per locale × page × room × news item", () => {
    expect(entries).toHaveLength(4 * (STATIC_PATHS.length + 2 + 1));
    const urls = entries.map((e) => e.url);
    expect(urls).toContain(`${SITE_URL}/zh-TW`);
    expect(urls).toContain(`${SITE_URL}/ja/rooms/deluxe-room`);
    expect(urls).toContain(`${SITE_URL}/ko/news/news-281`);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("every entry lists all four languages plus x-default", () => {
    for (const e of entries) expect(Object.keys(e.alternates!.languages!).sort()).toEqual(["en", "ja", "ko", "x-default", "zh-TW"]);
    const room = entries.find((e) => e.url.endsWith("/en/rooms/classic-room"))!;
    expect(room.alternates!.languages!["ja"]).toBe(`${SITE_URL}/ja/rooms/classic-room`);
    expect(room.alternates!.languages!["x-default"]).toBe(`${SITE_URL}/zh-TW/rooms/classic-room`);
  });
});
