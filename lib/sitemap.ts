import type { MetadataRoute } from "next";
import { LOCALES } from "@/lib/db/schema";
import { DEFAULT_LOCALE, localizedPath, SITE_URL } from "@/lib/seo";

/** Public pages without a database slug, as locale-less paths. */
export const STATIC_PATHS = ["/", "/rooms", "/facilities", "/location", "/attractions", "/news", "/faq", "/reviews", "/groups", "/privacy", "/terms"];

/** One entry per locale × page, each listing every language version (hreflang) plus x-default. */
export function sitemapEntries(roomSlugs: string[], newsSlugs: string[]): MetadataRoute.Sitemap {
  const paths = [...STATIC_PATHS, ...roomSlugs.map((s) => `/rooms/${s}`), ...newsSlugs.map((s) => `/news/${s}`)];
  const abs = (p: string) => new URL(p, SITE_URL).toString().replace(/\/$/, "");
  return paths.flatMap((path) => {
    const languages: Record<string, string> = Object.fromEntries(LOCALES.map((l) => [l, abs(localizedPath(l, path))]));
    languages["x-default"] = abs(localizedPath(DEFAULT_LOCALE, path));
    return LOCALES.map((locale) => ({
      url: abs(localizedPath(locale, path)),
      changeFrequency: path === "/" || path.startsWith("/rooms") ? ("weekly" as const) : ("monthly" as const),
      priority: path === "/" ? 1 : path.startsWith("/rooms") ? 0.8 : 0.5,
      alternates: { languages },
    }));
  });
}
