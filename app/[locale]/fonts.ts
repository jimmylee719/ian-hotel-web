import { Newsreader } from "next/font/google";

// design/tokens.md section 2. Newsreader (Latin, small) goes through next/font and is preloaded.
// The CJK serifs are self-hosted by scripts/fetch-fonts.ts and loaded without blocking rendering
// by components/layout/CjkFonts.tsx; their CSS variables are set in app/globals.css.
const en = Newsreader({ subsets: ["latin"], style: ["normal", "italic"], weight: ["300", "400", "500", "600"], variable: "--font-en", display: "swap" });

export const fontVariables = en.variable;
