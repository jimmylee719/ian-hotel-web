# Design tokens: Direction A 溫潤人文 (Warm Humanist)

Chosen by the hotel owner, as is, with no mixing with B or C.
Source of truth: `design/proposals/a.html` (desktop and `?m` mobile preview) and its caption in `design/proposals/index.html`:
"米白宣紙底、胡桃深褐文字、柚木色按鈕 / Noto Serif TC 與 Newsreader，全站襯線 / 像翻開一本旅行散文，直書標語搭配暖燈下的套房照片".
Task 7 implements from this file. Values below are copied from a.html; do not invent new ones.

## 1. Colour

```css
:root {
  --color-ink:     #2B241F; /* 胡桃深褐: all text */
  --color-paper:   #EFE8DC; /* 米白宣紙: page background */
  --color-accent:  #8A5A33; /* 柚木: buttons, links, focus ring */
  --color-muted:   #7A6D61; /* secondary text (large or non-essential only, see section 9) */
  --color-line:    #D6CAB6; /* dividers, borders */

  /* extra tokens actually used in a.html */
  --color-surface: #F7F2E9; /* cards, form surfaces */
  --color-accent-hover: #744A28; /* CTA hover (a.html .cta:hover) */
  --color-on-accent:    #FBF6EE; /* text on accent button (a.html .cta color) */
}
```

Other literal colours in a.html: the phone-frame preview border uses `--color-ink` (preview chrome only, not part of the site).
Photos are slightly warmed: `filter: saturate(.85) sepia(.08)`.

## 2. Fonts (all Google Fonts)

| Role | zh-TW | en | ja | ko |
|---|---|---|---|---|
| Heading | Noto Serif TC 500 / 600 | Newsreader 300 italic (taglines), 400 | Shippori Mincho 500 | Gowun Batang 400 (no bold used in the proposal; 700 available) |
| Body | Noto Serif TC 400 | Newsreader 400 | Shippori Mincho 400 | Gowun Batang 400 |

Notes:
- a.html body uses `font-family: var(--font-en), var(--font-zh)`: Latin glyphs come from Newsreader, CJK glyphs fall through to Noto Serif TC. Keep this stacking.
- a.html only loads Shippori Mincho 500; add 400 for ja body text.
- Newsreader is a variable font with optical size (`opsz` 6..72) and weights 300..600, plus italic.

`next/font/google` import names:

```ts
import { Newsreader, Noto_Serif_TC, Shippori_Mincho, Gowun_Batang } from "next/font/google";

const en = Newsreader({ subsets: ["latin"], style: ["normal", "italic"], weight: ["300","400","500","600"], variable: "--font-en", display: "swap" });
const zh = Noto_Serif_TC({ weight: ["400","500","600"], variable: "--font-zh", display: "swap", preload: false });
const ja = Shippori_Mincho({ weight: ["400","500"], variable: "--font-ja", display: "swap", preload: false });
const ko = Gowun_Batang({ weight: ["400","700"], variable: "--font-ko", display: "swap", preload: false });
```

(CJK families ship as unicode-range slices; `preload: false` avoids preloading dozens of slices. Load ja/ko variables only on `/ja` and `/ko` layouts. Verify the `subsets` option against the installed Next version; Noto Serif TC may need no `subsets`.)

CSS variables and fallback stacks:

```css
--font-zh: "Noto Serif TC", "Songti TC", "PMingLiU", serif;
--font-en: "Newsreader", Georgia, "Times New Roman", serif;
--font-ja: "Shippori Mincho", "Hiragino Mincho ProN", "Yu Mincho", serif;
--font-ko: "Gowun Batang", "Nanum Myeongjo", "Batang", serif;
```

Per-locale body stack: zh-TW `var(--font-en), var(--font-zh)`; en `var(--font-en), var(--font-zh)`; ja `var(--font-en), var(--font-ja), var(--font-zh)`; ko `var(--font-en), var(--font-ko), var(--font-zh)`. Set `<html lang>` so the right CJK glyph variants are chosen. Whole site is serif; no sans-serif UI font.

## 3. Type scale (desktop / mobile <=700px)

| Use | Size | Line-height | Weight, tracking |
|---|---|---|---|
| Body | 17px / 16px | 1.85 | 400 |
| Hero tagline (vertical, `writing-mode: vertical-rl`) | 42px / 25px | 1.5 | 500, letter-spacing .26em / .2em |
| Hero English line | 26px / 21px | 1.35 | 300 italic |
| Section heading h2 | 30px / 24px | normal | 500, .16em |
| Spec/sub heading h2 | 22px | normal | 500, .14em |
| Room name h3 | 21px | normal | 600, .1em |
| Brand | 21px | normal | 600, .12em |
| Nav | 15px | normal | .08em |
| Booking field value | 22px / 19px | 1.4 | 400 |
| Room price | 20px | normal | 400 |
| Intro paragraph / room description | 16px / 15px | 1.85 / 1.9 | 400 |
| Small label, caption, address, "起／晚" | 13 to 15px | 1.5 to 1.7 | muted, italic for English captions |
| CTA button | 17px | normal | .2em |

`-webkit-font-smoothing: antialiased`. CJK headings get generous letter-spacing (.08em to .26em); English italic uses none.

## 4. Spacing scale

a.html uses these values (px): 4, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 40, 48, 56, 64, 72, 80, 96, 120. Suggested tokens:

| Token | px |
|---|---|
| --space-1 | 8 |
| --space-2 | 12 |
| --space-3 | 16 |
| --space-4 | 24 |
| --space-5 | 32 |
| --space-6 | 40 |
| --space-7 | 56 |
| --space-8 | 80 |
| --space-9 | 120 |

Used for: page gutter 48px (20px mobile); card grid gap 40px (48px stacked on mobile); hero grid gap 56px (32px at <=1100px, 16px mobile); section top padding 120px (72px mobile); booking field padding 18px 24px (14px mobile).

## 5. Radius, shadows, lines

- Radius: `--radius: 2px` on photos and swatches; CTA and form fields are square (0). No pill shapes.
- Shadows: none. Depth comes from hairline borders only: 1px `--color-line`, and 1px `--color-ink` for strong rules (top of booking bar, top of spec section).
- Focus: `outline: 2px solid var(--color-accent); outline-offset: 3px` on `:focus-visible`.

## 6. Image treatment

- Hero photo: `aspect-ratio: 5/4` desktop, `3/4` mobile; `object-fit: cover; object-position: 30% 50%`.
- Room card photo: `aspect-ratio: 4/3`, `object-fit: cover`, `loading="lazy"`.
- Treatment: `filter: saturate(.85) sepia(.08)`, radius 2px. No overlays, gradients or text on photos. Captions sit below the image, 14px italic muted ("景緻雙人套房，午後三點的光").
- Alt text describes the room ("景緻雙人套房：皮革床頭、壁燈與落地紗簾").

## 7. Motion

- Easing: `--ease: cubic-bezier(.2,.7,.1,1)` (fast start, long soft settle).
- One reveal on load only, wrapped in `@media (prefers-reduced-motion: no-preference)`:
  - hero photo: `clip-path: inset(0 0 100% 0)` to `inset(0)`, 1.4s, delay .1s
  - vertical tagline: opacity 0 to 1, 1.6s, delay .5s
- Hover: colour change only (nav to accent, CTA to `--color-accent-hover`); no transforms, no scroll-triggered animation. Keep any added transition to about 150 to 200ms.
- With reduced motion, show everything immediately.

## 8. Breakpoints and width

- Max content width: 1240px (`.wrap`), centred, horizontal padding 48px (20px at <=700px).
- Breakpoints: `<=1100px` (hero becomes 2 columns: 110px tagline + photo; intro spans full row), `<=700px` mobile. Design target for mobile is 375px.

## 9. Component notes

**Header.** Flex, space-between, top padding 28px (18px mobile). Brand: 21px zh semibold, .12em tracking, with italic English "NK Hostel, Taipei" in muted (hidden on mobile). Nav 15px, 34px gap, hover accent (hidden on mobile). Language switcher text 14px muted ("中文 / EN / 日本語 / 한국어"; mobile shows "中 / EN" at 13px).

**Hero.** Desktop grid `150px 1fr 300px`, gap 56px, align end, top padding 64px. Left: vertical tagline "旅行 / 是一種生活的延伸" (two spans; second offset down 1.6em), 580px tall. Centre: photo with caption. Right: English italic line, zh paragraph, address in muted 14px. Mobile: grid `1fr 64px`; photo 3:4 on the left, tagline 25px / 340px tall in the narrow right column; intro below.

**Room card.** Column flex. Photo 4:3, then h3 (21px/600) with English name in italic muted 16px, description 15px / 1.9, then a meta row pinned to the bottom: 1px `--color-line` top border, 20px top padding, price (20px, "NT$2,980" with "起／晚" in muted 13px) left, "訂這間" link right (accent, 15px, .1em). Grid: 3 columns, 40px gap; 1 column on mobile. Section header row: h2 left, italic "全部 N 種房型" link right, 1px line below.

**Booking bar.** Desktop: single row, grid `1fr 1fr 1fr auto`; 1px ink top border, 1px line bottom border; three field buttons (入住, 退房, 人數) each with a 13px muted label above a 22px value (small italic muted suffix such as weekday or "2 晚"), separated by 1px line right borders; first field has no left padding; CTA at the right. Mobile: 2 columns (入住, 退房), people field spans the full row under a 1px line, CTA spans full width (16px padding) so a thumb can hit it. Fields are real `<button>`s opening pickers.

**Buttons.** Primary: background `--color-accent`, text `--color-on-accent`, 17px, letter-spacing .2em, padding 0 48px, no border, radius 0; hover `--color-accent-hover`. No secondary filled style in the proposal; secondary actions are text links.

**Links.** Inline: inherit colour (ink). Nav links: no underline, hover accent. Action links ("訂這間"): accent, no underline. "View all" link: italic ink 16px. All keep the 2px accent focus ring.

## 10. Accessibility (WCAG 2.x AA; normal text needs 4.5:1, large text and UI 3:1)

Computed contrast ratios:

| Foreground on background | Ratio | Verdict |
|---|---|---|
| ink #2B241F on paper #EFE8DC | 12.54:1 | AAA, use for all body text |
| ink on surface #F7F2E9 | 13.70:1 | AAA |
| accent #8A5A33 on paper | 4.80:1 | AA for body text (narrow margin) |
| accent on surface | 5.24:1 | AA |
| on-accent #FBF6EE on accent (CTA) | 5.44:1 | AA |
| on-accent on accent-hover #744A28 | 7.09:1 | AAA |
| muted #7A6D61 on paper | 4.12:1 | FAILS AA for normal text; passes only for large text (>=24px, or >=18.66px bold) and 3:1 UI |
| muted on surface | 4.50:1 | Borderline pass (4.495 rounds up; treat as fail) |
| line #D6CAB6 on paper | 1.33:1 | Decorative hairlines only; not enough for input borders that must be perceivable |

Avoid for body text: muted on paper (fails AA; a.html uses muted at 13 to 16px for labels, captions and address, so Task 7 should darken muted to about #6B5F54 or use ink at reduced size instead for text that carries information); accent on line; muted on line (3.10:1); line colour as text or as the only border of an input (use ink or accent for input borders and focus). Do not place text on photos. Accent text at 15px ("訂這間") passes AA but with little headroom, so keep it on paper or surface, never on line.
Also: keep `:focus-visible` rings, honour `prefers-reduced-motion`, and do not rely on vertical writing alone to convey the tagline (provide it as a normal `<h1>` with `writing-mode` applied only visually; screen readers read it in order).

## 11. Photography

The old-site photos (`nkhostel.com/upload_image/rooms/*`, `images/index-fancy.jpg`) are at most 1100px wide. That is enough for the 4:3 room cards (about 400px wide at 3 columns) but too small and soft for the full-width or retina hero (the hero photo column is about 700px wide on desktop, so 2x needs 1400px+) and for any full-bleed use. Recommendation: ask the owner for the original camera files, or commission a short reshoot (hero, each room type, public spaces, window view toward Taipei 101) at 2400px on the long edge or larger, landscape 5:4 and 4:3 crops in mind, warm natural light to match the "午後三點的光" tone. Until then, do not upscale; cap displayed hero width so it does not exceed the source resolution, and serve via `next/image` with explicit `sizes`.

## 12. Ink theme (2026-11-25 redesign)

A dark theme used only inside ink bands (`.band-ink`; `.band-paper` is the default paper band). Source: docs/superpowers/specs/2026-11-25-site-visual-redesign-design.md §5.1 and §5.2.

| Token | Value | Use | Contrast on ink #2B241F |
|---|---|---|---|
| `--color-ink-surface` | #352D27 | raised panels inside ink bands | n/a |
| `--color-on-ink` | #EFE6D8 | text on ink | 12.35:1 |
| `--color-on-ink-muted` | #CBBFAE | secondary text on ink | 8.44:1 |
| `--color-on-ink-faint` | #A8998A | labels, captions on ink (12px and up) | 5.52:1 |
| `--color-gold` | #E3C9A6 | numerals, English lines, links and focus ring on ink | 9.58:1 |
| `--color-ink-line` | #4A3F37 | hairlines on ink | decorative |

Rules:

- Gold-on-ink: on ink, links and focus rings use gold, never accent. The accent CTA button keeps the accent background with on-accent text (5.44:1).
- Muted text: informational small text on paper uses `--color-muted-text` (#6B5F54, 5.09:1 on paper); `--color-muted` (#7A6D61) is for large or decorative text only. This applies the pending fix from section 10.
- The one shadow: `--shadow-float` (`0 10px 30px rgba(0,0,0,.18)`), allowed only on the floating booking bar. Section 5 "no shadows" is amended for that single element.
- Sharpness rule (photos): keep the frame shapes but make frames shorter. Source width >= display width x 1.5 and source height >= display height x 1.5 (>= 1.4x for the hero arch). Sources are short landscapes (1100x440, 960x501; `rooms/rooms_409.jpg` is portrait 703x915), so: arch about 440 wide x 340 tall on desktop (<= 300 tall on mobile); any slot fed by a 1100x440 source <= 290 tall; by a 960x501 source <= 330 tall. Use `photoFits` and `maxSlotHeight` from `lib/design/photo-fit.ts` (sizes in `lib/content/photo-dimensions.json`, regenerate with `npx tsx scripts/photo-dimensions.ts`).
