# 官網視覺改版：暖光沉浸 × 人文雜誌（Lamplight × Editorial）

Status: draft for owner approval · 2026-11-25 · Builds on `design/tokens.md` (Direction A 溫潤人文) and the
public preview at https://nk-booking-preview.cardboard-vinyl.workers.dev.

## 1. Why

The user's words: the site must look like the websites of listed hotel groups (上市櫃飯店); today it is "有一點陽春".
We compared Aman Tokyo, Rosewood Hong Kong and Hoshinoya with the current homepage. What they share: the photograph
leads, a quiet header, few words with generous space, and a clear rhythm of large image → short text → cards. The current
site reads like a well-set document: the hero photo sits small inside a lot of beige, sections look alike, and nothing
creates depth or atmosphere.

The owner will **not** reshoot for now. Every photo is the old-site set, at most 1100px wide (many 960×500). So the
upgrade has to come from layout, colour, typography and rhythm, with photos always shown at sizes where they stay sharp.

## 2. Decision (chosen by the user from three mockups)

**B 暖光沉浸 as the base, with A 人文雜誌's numbered chapters.** The approved mockup is
`.superpowers/brainstorm/58414-1795616818/content/home-combined.html` (git-ignored; a copy of its structure is in §5).

- A dark ink (walnut) first screen, like a lamp lit at dusk: centred brand, an arch-framed photo, the vertical Chinese
  tagline 「旅行是生活的延伸」, a short italic English line and three lines of copy.
- Below it, the page alternates paper and ink bands. Content is told as numbered chapters — 01 房型, 02 公共空間, 03 交通 —
  each with a big Newsreader numeral, a Chinese title and a small-caps English label, then an asymmetric photo layout.
- Guest ratings as large numerals on ink; an ink footer.

The other mockups (A alone, C 三景並置 triptych) were shown and not chosen.

## 3. Goals, non-goals, anti-goals

Goals
- First impression on desktop and mobile reads as a premium boutique hotel: atmosphere, depth, confident typography.
- One visual language across **all public pages**: home, rooms list and room detail, facilities, location, FAQ,
  attractions, groups, reviews, news list and article, privacy, terms, 404, booking pages and manage-booking pages.
- Photos never shown larger than their source supports (no visible softness on a 2× screen at common widths).
- No regression in accessibility (WCAG 2.x AA), performance, SEO, four languages, or the booking flow.

Non-goals
- No new content, copy rewriting or new photos. Copy comes from `messages/*.json` and the DB as today; if a layout needs
  a new short label (e.g. chapter English labels "ROOMS"), add it to all four message files.
- The staff admin (`/admin`) is not restyled.
- No booking-logic, data-model, i18n-routing or API change.
- No video, no autoplay media, no carousel/slider libraries.

Anti-goals (a failure even if it "works")
- Text placed on top of photos, or photos stretched beyond their source width (looks cheap and soft).
- The booking flow becoming harder to use for the sake of mood (forms stay on paper, plain and readable).
- Dark sections that fail contrast (accent #8A5A33 on ink is only 2.61:1 — see §6).
- Scroll-jacking, parallax or heavy animation; anything that ignores `prefers-reduced-motion`.
- Inventing facts in copy (sizes, years, walking times). Use only what the content already says.

## 4. Approaches considered

1. **Shared section components, then restyle page by page (chosen, controller's call).** Build a small set of reusable
   pieces (ink hero, arch photo, chapter block, band, ratings strip, ink footer, page head for inner pages) and rebuild each
   page from them. Data, i18n and booking code untouched. Consistent look; new pages reuse the pieces.
2. CSS-only reskin, components untouched. Fastest, but inner pages would not match the new homepage — two websites.
3. Rebuild with a UI framework (e.g. Tailwind). Rewrites most markup for no gain; the existing token-based CSS is sound.

The user described outcomes and did not pick a method, so the controller chose 1.

## 5. Design

### 5.1 Tokens (amend `design/tokens.md`; keep everything else in it)

Keep ink/paper/accent/line/surface and the four font families. Add a dark theme used only inside ink bands:

| Token | Value | Use | Contrast on ink #2B241F |
|---|---|---|---|
| `--color-ink-surface` | #352D27 | raised panels inside ink bands | — |
| `--color-on-ink` | #EFE6D8 | text on ink | 12.35:1 |
| `--color-on-ink-muted` | #CBBFAE | secondary text on ink | 8.44:1 |
| `--color-on-ink-faint` | #A8998A | labels, captions on ink (≥12px) | 5.52:1 |
| `--color-gold` | #E3C9A6 | numerals, English lines, **links and focus ring on ink** | 9.58:1 |
| `--color-ink-line` | #4A3F37 | hairlines on ink | decorative |

Rules: on ink, links and focus rings use gold, never accent. The accent CTA button keeps accent background with
on-accent text (5.44:1). One soft shadow is allowed, only on the floating booking bar
(`0 10px 30px rgba(0,0,0,.18)`); tokens.md §5 "no shadows" is amended for that single element.
Also apply tokens.md §10's pending fix: muted text that carries information uses a darkened muted (~#6B5F54) on paper.

### 5.2 Shared pieces

- **Header (`components/layout/Header.tsx`)** — two variants: `ink` (on the home hero and any page whose head is ink)
  and `paper`. Grid `1fr auto 1fr`: nav left, brand centred (zh name + "NK HOSTEL · TAIPEI" small caps), language switcher
  + 立即訂房 right. Existing breakpoints keep working: ≤1240px short language labels, ≤900px menu button (the open menu
  panel uses the header's own variant colours). Never wraps (fix shipped 011ba35).
- **Ink hero (home only)** — grid `1fr 440px 1fr` (gap 44px): left italic English line (the existing
  `home.taglineEn`, "Travel is an extension of life."; the mockup's "A lamp left on for you." was placeholder copy and is
  not used — controller's call, no new copy) + the existing intro copy; centre
  arch photo (≈440×340, rounded top, within the sharpness rule); right vertical tagline
  (`writing-mode: vertical-rl`, existing tagline strings). Mobile: arch photo full-width minus gutters (max 300px tall),
  tagline horizontal above it, copy below.
- **Floating booking bar** — the existing BookingBar, restyled: paper background, shadow, overlapping the ink/paper edge
  by half its height. Mobile keeps today's stacked layout. The sticky BookingDock keeps its behaviour, restyled to match.
- **Chapter** — `<section>` with a left rail (Newsreader numeral 52px in accent on paper / gold on ink, zh title 16px
  600 .2em, small-caps English label) and a content area. Rail collapses above the content on ≤900px.
- **Band** — full-bleed paper or ink wrapper (content stays within `.wrap` 1240px). Pages alternate bands.
- **Photo sharpness rule (owner's decision: keep the shapes, make frames shorter)** — almost every source is a short
  landscape (1100×440, 960×501; only `rooms/rooms_409.jpg` is portrait, 703×915). With `object-fit: cover` the frame's
  height drives enlargement, so the rule applies to **both** dimensions: source width ≥ display width × 1.5 **and**
  source height ≥ display height × 1.5 (small tolerance: ≥ 1.4× for the hero arch). Resulting maxima: arch ≈ 440 wide
  × 340 tall on desktop (≤ 300 tall on mobile); any slot fed by a 1100×440 source ≤ 290 tall; by a 960×501 source
  ≤ 330 tall. The approved mockup's taller frames (arch 400×500, tall slot 480, large photo 380) are reduced accordingly;
  the arch keeps its rounded top (radius = half its width).
- **Photo layouts** — `grid3` (one wide lead photo + two smaller with captions + text; the lead no longer spans two rows
  of 480px — it is a wide frame within the height maxima above), `split` (large + small photo with text). Use
  `mediaSrcSet` + `sizes`; if a source is too small for a slot, it goes in a smaller slot.
- **Ratings strip** — the existing `HOME_AWARDS` on ink: large Newsreader numerals in gold, platform in small caps.
- **Inner-page head** — ink band with breadcrumb-free title: zh title (30px/24px, .16em), English small-caps label, one
  lead line, and optionally one photo at right (≤560px wide). Replaces today's `PageHead` look; same props.
- **Ink footer** — three columns (brand + address/phone/email, main links, secondary links), hairline top.
- **Motion** — keep the single on-load reveal (arch photo clip-path 1.4s; tagline fade 1.6s). Add at most a gentle
  fade-up for chapter photos on first scroll into view (IntersectionObserver, 600ms, once), disabled by
  `prefers-reduced-motion`. No parallax.

### 5.3 Page by page

- **Home**: ink header+hero → floating booking bar → paper intro statement (storyLead + storyBody1 as one large
  paragraph, A's style) → 01 房型 (paper, grid3 with featured rooms + link to all) → 02 公共空間 (ink, split, facilities
  copy + link) → 03 交通 (paper, address/MRT copy + map link + one photo) → ratings strip (ink) → footer.
  Keeps JSON-LD, metadata, `INLINE_BOOKING_ID`.
- **Rooms list**: ink page head → rooms as alternating editorial rows (photo left/right alternating, name, English name,
  description, "起／晚" price, 訂這間) instead of the uniform 3-column grid.
- **Room detail**: ink head with room name → gallery as grid3 / split (no lightbox library; existing RoomGallery
  restyled) → spec list on paper → booking call to action band (ink).
- **Facilities, location, attractions, groups**: ink head → chapters built from the page's existing `## ` sections
  (controller's call): pages with 2–4 sections (facilities 5F/8F/14F) get one numbered chapter per section; pages with
  more (location 7, attractions 6, groups ~5) get a single chapter whose sections render as a compact two-column list with
  hairline dividers, not numbered. The chapter's English small-caps label is the matching `## ` heading from the page's
  English text (existing content, not new copy); if no match, no label. The page's flat photo list is distributed in
  order across chapters (or shown as one split/grid3 for single-chapter pages).
- **FAQ, privacy, terms, news article**: ink head → paper reading column (max ~680px, body 17px/1.85).
- **Reviews, news list**: ink head → paper; scores/awards reuse the ratings strip style.
- **Booking (`/book`, details, return) and manage pages**: paper header variant, compact paper page head, forms
  unchanged apart from typography/colour alignment. The 建置中 notice gets a centred paper panel.
- **404**: ink head with the existing copy.

All four locales must lay out correctly (ja/ko labels are longer; vertical tagline uses existing per-locale rules).

## 6. Constraints

- Stack unchanged: Next.js 15 App Router on Cloudflare Workers (OpenNext), plain CSS files (`app/globals.css`,
  `app/site.css`, `app/booking.css`), next-intl, fonts per tokens.md. No new runtime dependencies.
- Photos via existing `/media` keys and `mediaSrcSet`; WebP variants 480/800/1100 already exist.
- Accessibility: contrast per §5.1; real headings order; vertical tagline still an `<h1>`; focus visible on both themes.
- Performance: no layout shift from the hero (explicit sizes/aspect ratios); LCP image `fetchPriority="high"`.
- Tests: existing 734 tests must stay green; add tests only where markup changes break existing selectors or for new
  components with logic (e.g. header variant choice). Visual verification by screenshots at 375, 768, 1024, 1440 px
  in all four locales.
- Delivery: deploy to the public preview (`npm run deploy:preview`) for the owner to review before merge to main.

## 7. Left to the builder

- Exact component file split under `components/site/` and how CSS is organised between the three files.
- Which existing photo goes in each slot, within §5.2's size rule (prefer room cover images and the facility photos the
  home page uses today; avoid the parking-lot graphic `location/location_113.jpg`).
- Fine spacing and type sizes not fixed above, consistent with tokens.md.
