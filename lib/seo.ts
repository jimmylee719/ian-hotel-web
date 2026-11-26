import type { Metadata, MetadataRoute } from "next";
import { LOCALES, type Locale } from "@/lib/db/schema";
import { mediaUrl } from "@/lib/media";

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.nkhostel.com";
export const DEFAULT_LOCALE: Locale = "zh-TW";
const DEFAULT_IMAGE = "rooms/rooms_76.jpg";

/**
 * May search engines index this copy of the site? Only production (ENVIRONMENT "production", trimmed). Every other
 * copy — the public preview on workers.dev, staging, local dev, and an unset or mistyped ENVIRONMENT — is kept out of
 * search: robots.txt disallows everything, pages carry `noindex, nofollow`, and worker.ts adds X-Robots-Tag.
 * Defaulting to "not indexable" means a test copy can never be indexed by mistake; production pins its ENVIRONMENT
 * in wrangler.jsonc (tests/ops/wrangler-config.test.ts).
 */
export function isIndexable(env: { ENVIRONMENT?: string }): boolean {
  return env.ENVIRONMENT?.trim() === "production";
}

/** The page metadata `robots` of a copy that must not be indexed. */
export const NOINDEX = { index: false, follow: false } as const;

/** The X-Robots-Tag header value for the same. */
export const NOINDEX_HEADER = "noindex, nofollow";

/** robots.txt. Production: crawl everything but /api and /dev, with the sitemap. Every other copy: disallow everything. */
export function robotsFor(env: { ENVIRONMENT?: string }): MetadataRoute.Robots {
  if (!isIndexable(env)) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/dev/"] }],
    sitemap: new URL("/sitemap.xml", SITE_URL).toString(),
  };
}

const OG_LOCALE: Record<Locale, string> = { "zh-TW": "zh_TW", en: "en_US", ja: "ja_JP", ko: "ko_KR" };

/** `/{locale}{path}` with no trailing slash ("/" -> "/en"). */
export function localizedPath(locale: Locale, path: string): string {
  const p = path === "/" || path === "" ? "" : path.startsWith("/") ? path : `/${path}`;
  return `/${locale}${p}`;
}

export function buildMetadata(opts: { locale: Locale; path: string; title: string; description: string; image?: string }): Metadata {
  const { locale, path, title, description } = opts;
  const url = localizedPath(locale, path);
  const languages: Record<string, string> = Object.fromEntries(LOCALES.map((l) => [l, localizedPath(l, path)]));
  languages["x-default"] = localizedPath(DEFAULT_LOCALE, path);
  const image = mediaUrl(opts.image ?? DEFAULT_IMAGE);

  return {
    metadataBase: new URL(SITE_URL),
    title,
    description,
    alternates: { canonical: url, languages },
    openGraph: {
      type: "website",
      siteName: "NK Hostel 小公館人文旅舍",
      title,
      description,
      url,
      locale: OG_LOCALE[locale],
      alternateLocale: LOCALES.filter((l) => l !== locale).map((l) => OG_LOCALE[l]),
      images: [{ url: image }],
    },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}
