import scrape from "@/content/old-site.json";
import { faqText } from "@/content/localized/faqs";
import { newsText } from "@/content/localized/news";
import { pageText } from "@/content/localized/pages";
import { roomText } from "@/content/localized/rooms";
import type { OldSiteContent, OldSiteScrape } from "./types";

/** Content pages every locale must have (slug -> old-site pages whose photos it reuses). */
export const PAGE_SOURCES: Record<string, string[]> = {
  facilities: ["facilities"],
  access: ["access"],
  attractions: ["attractions"],
  groups: ["groups", "long-stay"],
  privacy: [],
  "booking-terms": [],
};
export const REQUIRED_PAGES = Object.keys(PAGE_SOURCES);

const data = scrape as OldSiteScrape;

/**
 * The migrated content, fully localised: structure, photos and amenities from the scrape
 * (content/old-site.json), edited text in four languages from content/localized/*.
 */
export function oldSiteContent(): OldSiteContent {
  const rooms = data.rooms.map((r) => {
    const text = roomText[r.slug];
    if (!text) throw new Error(`no localized text for room ${r.slug}`);
    return { slug: r.slug, description: text.description, bedType: text.bedType, sizeSqm: text.sizeSqm, amenities: r.amenities, images: r.images };
  });

  const pages = REQUIRED_PAGES.map((slug, sortOrder) => {
    const text = pageText[slug];
    if (!text) throw new Error(`no localized text for page ${slug}`);
    const images = PAGE_SOURCES[slug].flatMap((s) => data.pages.find((p) => p.slug === s)?.images ?? []);
    return { slug, title: text.title, body: text.body, images, sortOrder };
  });

  const faqs = data.faqs
    .filter((f) => faqText[f.slug])
    .map((f, sortOrder) => ({ slug: f.slug, ...faqText[f.slug], sortOrder }));

  const news = data.news
    .filter((n) => newsText[n.slug])
    .map((n) => ({
      slug: n.slug,
      ...newsText[n.slug],
      publishedAt: n.date ? Date.parse(`${n.date}T00:00:00+08:00`) : null,
      images: n.images,
    }));

  return { rooms, pages, faqs, news };
}

/** Photos of a room type (R2 keys), first is the cover. */
export function roomImages(slug: string): string[] {
  return data.rooms.find((r) => r.slug === slug)?.images ?? [];
}
