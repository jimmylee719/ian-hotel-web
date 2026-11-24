import type { Metadata } from "next";
import { LOCALES, type Locale } from "@/lib/db/schema";
import { mediaUrl } from "@/lib/media";

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.nkhostel.com";
export const DEFAULT_LOCALE: Locale = "zh-TW";
const DEFAULT_IMAGE = "rooms/rooms_76.jpg";

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
