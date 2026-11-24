import type { I18n } from "@/lib/db/schema";

/** zh-TW + en, as published on the old site (nkhostel.com). */
export type Bilingual = { "zh-TW": string; en: string };

/** Raw scrape of the old site; written by scripts/import-old-site.ts to content/old-site.json. */
export type OldSiteScrape = {
  source: string;
  scrapedAt: string;
  rooms: {
    oldId: number;
    slug: string;
    name: Bilingual;
    description: Bilingual;
    notes: Bilingual;
    /** e.g. "NTD880~6000" */
    priceRange: string;
    /** e.g. "1~2" */
    occupancy: string;
    /** Amenity keys (see AMENITY_ICONS), labels live in messages under `amenities.*`. */
    amenities: string[];
    /** R2 keys, e.g. "rooms/rooms_138.jpg". */
    images: string[];
  }[];
  pages: { slug: string; oldPath: string; title: Bilingual; body: Bilingual; images: string[] }[];
  faqs: { slug: string; category: Bilingual; question: Bilingual; answer: Bilingual }[];
  news: { slug: string; oldId: number; date: string | null; title: Bilingual; body: Bilingual; images: string[] }[];
};

/** ja/ko translations keyed by `<kind>.<slug>.<field>` (see translationKey). */
export type Translations = Record<"ja" | "ko", Record<string, string>>;

/** Everything seedContent writes, fully localised. */
export type OldSiteContent = {
  rooms: {
    slug: string;
    description: I18n;
    bedType: I18n;
    sizeSqm: number | null;
    amenities: string[];
    images: string[];
  }[];
  pages: { slug: string; title: I18n; body: I18n; images: string[]; sortOrder: number }[];
  faqs: { slug: string; title: I18n; body: I18n; sortOrder: number }[];
  news: { slug: string; title: I18n; body: I18n; publishedAt: number | null; images: string[] }[];
};
