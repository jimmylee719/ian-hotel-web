import type { Locale } from "@/lib/db/schema";

/**
 * Loads the self-hosted CJK font stylesheets (scripts/fetch-fonts.ts) without blocking the first
 * render: an inline script appends the <link>s, so text shows at once in the fallback serif and
 * swaps (font-display: swap). Noto Serif TC on every locale (brand name, zh text in en pages);
 * Shippori Mincho / Gowun Batang only on /ja and /ko. Without JavaScript the fallback serif stays.
 */
export function CjkFonts({ locale }: { locale: Locale }) {
  const sheets = ["/fonts/zh.css", ...(locale === "ja" ? ["/fonts/ja.css"] : []), ...(locale === "ko" ? ["/fonts/ko.css"] : [])];
  const script = `${JSON.stringify(sheets)}.forEach(function(h){var l=document.createElement("link");l.rel="stylesheet";l.href=h;document.head.appendChild(l)})`;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
