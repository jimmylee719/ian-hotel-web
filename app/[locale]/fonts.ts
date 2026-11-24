import { Gowun_Batang, Newsreader, Noto_Serif_TC, Shippori_Mincho } from "next/font/google";
import type { Locale } from "@/lib/db/schema";

// design/tokens.md section 2. CJK families ship as unicode-range slices: no preload.
const en = Newsreader({ subsets: ["latin"], style: ["normal", "italic"], weight: ["300", "400", "500", "600"], variable: "--font-en", display: "swap" });
const zh = Noto_Serif_TC({ weight: ["400", "500", "600"], variable: "--font-zh", display: "swap", preload: false });
const ja = Shippori_Mincho({ weight: ["400", "500"], variable: "--font-ja", display: "swap", preload: false });
const ko = Gowun_Batang({ weight: ["400", "700"], variable: "--font-ko", display: "swap", preload: false });

/** Font CSS variables for a locale: Newsreader + Noto Serif TC everywhere, plus the ja/ko serif there. */
export function fontVariables(locale: Locale): string {
  const extra = locale === "ja" ? ja.variable : locale === "ko" ? ko.variable : "";
  return [en.variable, zh.variable, extra].filter(Boolean).join(" ");
}
