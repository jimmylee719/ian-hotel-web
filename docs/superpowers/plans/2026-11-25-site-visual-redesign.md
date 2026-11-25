# Site Visual Redesign (Lamplight × Editorial) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle every public page of the NK Hostel site into the approved "B 暖光沉浸 + A 人文雜誌" look (ink first screen with arch photo, numbered editorial chapters, alternating ink/paper bands), using only the existing photos at sharp sizes.

**Architecture:** Add an ink theme to the existing token CSS, a pure photo-fit helper backed by a generated photo-dimension manifest, and a small set of shared section components (Band, Chapter, ArchPhoto, PhotoGrid3, PhotoSplit, RatingsStrip, PageHead theme). Rebuild each page from them. Data loading, i18n routing, booking logic and APIs are untouched.

**Tech Stack:** Next.js 15 App Router on Cloudflare Workers (OpenNext), React server components, plain CSS (`app/globals.css`, `app/site.css`, `app/booking.css`), next-intl, Vitest (node env, `tests/**/*.test.ts` only), sharp (dev only, for the manifest script).

**Spec:** `docs/superpowers/specs/2026-11-25-site-visual-redesign-design.md` (approved). Read it before every task. Approved mockup: `.superpowers/brainstorm/58414-1795616818/content/home-combined.html` (git-ignored; open it for the look, but the spec's sizes override it).

## Global Constraints

- Ink-theme tokens, exact values: `--color-ink-surface #352D27`, `--color-on-ink #EFE6D8`, `--color-on-ink-muted #CBBFAE`, `--color-on-ink-faint #A8998A`, `--color-gold #E3C9A6`, `--color-ink-line #4A3F37`. Existing tokens unchanged except muted text carrying information on paper uses `#6B5F54`.
- On ink: links and `:focus-visible` rings use gold, never accent (#8A5A33 on ink is 2.61:1). Accent CTA button keeps accent background + on-accent text.
- The only shadow on the site: the floating booking bar, `0 10px 30px rgba(0,0,0,.18)`.
- Photo sharpness rule (both dimensions): source width ≥ display width × 1.5 AND source height ≥ display height × 1.5; hero arch tolerance ≥ 1.4×. Maxima: arch ≈ 440×340 desktop, ≤ 300 tall mobile; slots fed by 1100×440 sources ≤ 290 tall; by 960×501 sources ≤ 330 tall. Never use `location/location_113.jpg` (parking graphic).
- No new copy except short labels a layout needs; any new message key goes in all four `messages/{zh-TW,en,ja,ko}.json`. Hero English line is the existing `home.taglineEn`. No invented facts.
- Not restyled: `/admin`. No booking-logic, data-model, API or routing change. No new runtime dependencies; no carousel/lightbox/animation libraries; no video; no parallax.
- Motion: keep the single on-load reveal; at most one fade-up per chapter photo group on first view (IntersectionObserver, 600ms, once); everything static under `prefers-reduced-motion: reduce`.
- No text over photos. Headings in order; the vertical tagline stays an `<h1>`.
- All four locales must lay out at 375, 768, 1024, 1440 px with no horizontal page scroll and no header wrapping.
- The existing suite (734 tests) stays green; `npx tsc --noEmit` and `npx eslint` clean.
- Delivery: `npm run deploy:preview` to https://nk-booking-preview.cardboard-vinyl.workers.dev after the final task; never deploy staging/production. Stop the local dev server before running the deploy build (a build overwrites `.next` and breaks a running `next dev`; delete `.next` before restarting it).

## Review Focus

1. **Longest labels (ja/ko) at 1024px** — chapter rails, header, booking bar and footer must not wrap mid-word or overflow; covered by Task 8's locale × width screenshot sweep and Task 2's header test.
2. **A page body with no `## ` headings, or more photos than chapters / fewer photos than chapters** — layout must degrade to a single chapter / chapters without photos, never crash or leave empty frames; Task 6 tests `splitSections` and `assignPhotos` for these.
3. **A room with no image or no price** — editorial rows must still align and show no broken frame or "NT$null"; Task 5 test of `roomRowProps`.
4. **Keyboard focus inside ink bands** — focus ring must be gold and visible; Task 1 CSS and Task 8 check (tab through home).
5. **Reduced motion** — no reveal or fade-up runs; content visible immediately; Task 3 test of `revealEnabled` and Task 8 check with emulated reduced motion.

---

### Task 1: Ink theme tokens and the photo-fit rule

**Files:**
- Modify: `app/globals.css` (add ink tokens to `:root`, `.band-ink` scope that remaps text/link/focus/line colours; darken information-carrying muted text), `design/tokens.md` (append section "12. Ink theme (2026-11-25 redesign)" with the token table, gold-on-ink rule, the one shadow, and the sharpness rule — copy values from the spec §5.1/§5.2)
- Create: `scripts/photo-dimensions.ts`, `lib/content/photo-dimensions.json` (generated), `lib/design/photo-fit.ts`
- Test: `tests/design/photo-fit.test.ts`

**Interfaces:**
- Produces:
  - `PHOTO_DIMENSIONS: Record<string, { w: number; h: number }>` (default export of the JSON via `lib/design/photo-fit.ts` re-export) keyed by R2 key like `"rooms/rooms_76.jpg"`.
  - `photoFits(key: string, slot: { w: number; h: number }, tolerance = 1.5): boolean` — true when the source is at least `tolerance ×` the slot in both dimensions; unknown key → false.
  - `maxSlotHeight(key: string, slotWidth: number, tolerance = 1.5): number` — largest display height that still fits (min of `h / tolerance` and the height implied by width), rounded down; unknown key → 0.
  - CSS: class `.band-ink` (full-bleed ink band; inside it `color: var(--color-on-ink)`, `a` and focus ring gold, hairlines `--color-ink-line`); class `.band-paper`.

- [ ] **Step 1:** Write `scripts/photo-dimensions.ts`: walks `content/images`, reads each file's width/height with `sharp(file).metadata()`, writes sorted JSON `{ "<dir>/<file>": { "w": n, "h": n } }` to `lib/content/photo-dimensions.json`. Run it: `npx tsx scripts/photo-dimensions.ts` → 125 entries.
- [ ] **Step 2: Write the failing test** `tests/design/photo-fit.test.ts`:
  - manifest has an entry for every file under `content/images` (readdir, same key format) and nothing else;
  - `PHOTO_DIMENSIONS["rooms/rooms_76.jpg"]` equals `{ w: 1100, h: 440 }`; `["amenities/amenities_32.jpg"]` equals `{ w: 960, h: 501 }`;
  - `photoFits("amenities/amenities_32.jpg", { w: 440, h: 340 }, 1.4)` is `true`; `photoFits("amenities/amenities_32.jpg", { w: 400, h: 500 })` is `false`;
  - `photoFits("rooms/rooms_76.jpg", { w: 600, h: 290 })` is `true`; `{ w: 600, h: 300 }` is `false`;
  - `photoFits("nope.jpg", { w: 1, h: 1 })` is `false`; `maxSlotHeight("rooms/rooms_76.jpg", 600)` is `293`.
- [ ] **Step 3:** Run `npx vitest run tests/design/photo-fit.test.ts` → FAIL (module missing).
- [ ] **Step 4:** Implement `lib/design/photo-fit.ts` and the CSS tokens/classes.
- [ ] **Step 5:** Run the test → PASS; run `npx vitest run` → all pass.
- [ ] **Step 6:** Commit `feat(site): ink theme tokens and photo-fit rule`.

---

### Task 2: Header theme, full-bleed layout and ink footer

**Files:**
- Create: `lib/design/header-theme.ts`
- Modify: `app/[locale]/layout.tsx` (header no longer inside `.wrap`; wrap it in a full-bleed band whose class follows the theme; footer in a full-bleed `.band-ink`), `components/layout/Header.tsx` (grid `1fr auto 1fr`: nav left, brand centred with `header.brand` + small caps "NK HOSTEL · TAIPEI" from `header.brandEn` uppercased via CSS, language switcher + 立即訂房 right; keep the menu button ≤900px and the ≤1240px short-label rule from commit 011ba35; open menu panel uses the band's colours), `components/layout/Footer.tsx` (three columns per spec §5.2 "Ink footer": brand + address/phone/email/social; main links; secondary links incl. reviews/news/groups/manage booking/privacy/terms — reuse existing `FOOTER_LINKS`, split into two lists), `app/globals.css` / `app/site.css` header + footer rules
- Test: `tests/design/header-theme.test.ts`

**Interfaces:**
- Consumes: `.band-ink` / `.band-paper` from Task 1.
- Produces: `headerTheme(pathname: string): "ink" | "paper"` — `"paper"` when the locale-less path is `/book`, starts with `/book/`, is `/manage` or starts with `/manage/`; otherwise `"ink"`. Header reads `usePathname()` (next-intl, locale-less) and sets `data-theme` on its band.

- [ ] **Step 1: Write the failing test**: `headerTheme("/")` → `"ink"`; `"/rooms"`, `"/rooms/deluxe-room"`, `"/faq"`, `"/news/news-281"` → `"ink"`; `"/book"`, `"/book/details"`, `"/book/return"`, `"/manage"`, `"/manage/NK-ABC123"` → `"paper"`; `"/booking-terms"` → `"ink"` (prefix must be a whole segment).
- [ ] **Step 2:** Run `npx vitest run tests/design/header-theme.test.ts` → FAIL.
- [ ] **Step 3:** Implement `headerTheme`, the layout/header/footer markup and CSS.
- [ ] **Step 4:** Run the test → PASS; `npx vitest run` → all pass (keys-used test catches any new message key missing in zh-TW).
- [ ] **Step 5:** Start `site-preview` (`.claude/launch.json`), screenshot `/zh-TW` and `/ko` header at 375/1024/1440 and `/zh-TW/book` (paper header). No wrapping; menu button ≤900px.
- [ ] **Step 6:** Commit `feat(site): ink/paper header themes, full-bleed bands, ink footer`.

---

### Task 3: Shared section components

**Files:**
- Create: `components/site/sections/Band.tsx`, `Chapter.tsx`, `ArchPhoto.tsx`, `PhotoGrid3.tsx`, `PhotoSplit.tsx`, `RatingsStrip.tsx`, `Reveal.tsx` (client), `lib/design/motion.ts`
- Modify: `components/site/PageHead.tsx` (add `theme?: "ink" | "paper"` default `"ink"`, optional `en` small-caps label and optional `photo` key; ink renders inside a full-bleed band, paper is the compact head for booking pages), `app/site.css` (section styles)
- Test: `tests/design/motion.test.ts`

**Interfaces:**
- Consumes: `photoFits`, `maxSlotHeight`, `PHOTO_DIMENSIONS` (Task 1); `Photo` (existing).
- Produces (props exact; all server components except `Reveal`):
  - `Band({ theme: "ink" | "paper"; children; id?: string; className?: string })` — full-bleed, inner `.wrap`.
  - `Chapter({ num?: number; title: string; en?: string; children; headingLevel?: 2 | 3 })` — left rail: numeral formatted two-digit (`01`) in Newsreader, title, small-caps `en`; rail above content ≤900px. No numeral when `num` is undefined.
  - `ArchPhoto({ src: string; alt: string; priority?: boolean })` — fixed frame 440×340 desktop / ≤300 tall mobile, rounded top radius = half width.
  - `PhotoGrid3({ lead: { src; alt }; items: { src; alt; caption?: string; captionEn?: string }[]; children? })` — wide lead + up to two captioned items + text slot; each frame's CSS height ≤ `maxSlotHeight` of its source at its slot width.
  - `PhotoSplit({ large: { src; alt }; small?: { src; alt }; children })`.
  - `RatingsStrip({ awards: { platform: string; score: string; scale: string }[] })` — consumes existing `HOME_AWARDS` shape.
  - `revealEnabled(matchMedia: (q: string) => { matches: boolean }): boolean` — false when `(prefers-reduced-motion: reduce)` matches. `Reveal({ children })` adds class `is-visible` once on first intersection (threshold 0.15), only when `revealEnabled(window.matchMedia)`; otherwise renders children visible.

- [ ] **Step 1: Write the failing test** `tests/design/motion.test.ts`: `revealEnabled(q => ({ matches: q.includes("reduce") }))` → `false`; `revealEnabled(() => ({ matches: false }))` → `true`.
- [ ] **Step 2:** Run it → FAIL.
- [ ] **Step 3:** Implement the components, `motion.ts` and CSS per spec §5.2 (chapter numeral 52px accent on paper / gold on ink; zh title 16px 600 .2em; frames `object-fit: cover`).
- [ ] **Step 4:** Run the test → PASS; `npx vitest run` → all pass.
- [ ] **Step 5:** Commit `feat(site): shared section components (band, chapter, arch, photo layouts, ratings, reveal)`.

---

### Task 4: Home page

**Files:**
- Modify: `app/[locale]/page.tsx`, `components/layout/BookingBar.tsx` / `components/site/BookingDock.tsx` styles only (floating bar with the one shadow, overlapping the ink/paper edge by half its height; dock restyled to match), `app/site.css`, `messages/{zh-TW,en,ja,ko}.json` (chapter English labels if not reusing an existing string: `home.chapterRoomsEn` "Rooms", `home.chapterSpacesEn` "Shared spaces", `home.chapterAccessEn` "Getting here" — same English text in all four files)
- Create: `lib/content/home-photos.ts`
- Test: `tests/design/home-photos.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `HOME_PHOTOS: { arch: string; spacesLarge: string; spacesSmall: string; access: string }` and `HOME_SLOTS` (same keys → `{ w; h }` desktop slot sizes) in `lib/content/home-photos.ts`. Rooms chapter uses the featured rooms' cover images (existing `FEATURED_ROOMS` + `loadRooms`).

- [ ] **Step 1: Write the failing test**: for every key in `HOME_PHOTOS`, `photoFits(HOME_PHOTOS[k], HOME_SLOTS[k], k === "arch" ? 1.4 : 1.5)` is `true`; no value equals `"location/location_113.jpg"`; every value exists in `PHOTO_DIMENSIONS`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the page per spec §5.3 Home: ink band (header + hero: left `home.taglineEn` italic gold + `home.intro`; centre `ArchPhoto` priority; right vertical `<h1>` tagline with existing per-locale `lang` rule) → floating BookingBar (keep `INLINE_BOOKING_ID`) → paper intro statement (`home.storyLead` + `home.storyBody1` as one large paragraph) → `Chapter 01` rooms (paper, `PhotoGrid3` from featured rooms + link `home.allRooms`) → `Chapter 02` spaces (ink, `PhotoSplit` + `home.facilitiesBody` + link) → `Chapter 03` access (paper, address, `home.locationBody`, directions + map links, one photo) → `RatingsStrip` (ink) with link to `/reviews`. Keep `JsonLd`, metadata, `dynamic`.
- [ ] **Step 4:** Run the test → PASS; `npx vitest run` → all pass.
- [ ] **Step 5:** Screenshot `/zh-TW`, `/en`, `/ja`, `/ko` at 375 and 1440; compare with the mockup's structure; check the arch image is not soft at 2× (DevTools device-pixel-ratio 2).
- [ ] **Step 6:** Commit `feat(site): home page in the Lamplight × Editorial layout`.

---

### Task 5: Rooms list and room detail

**Files:**
- Modify: `app/[locale]/rooms/page.tsx`, `app/[locale]/rooms/[slug]/page.tsx`, `components/site/RoomCard.tsx` (becomes the editorial row; keep its export name and props `{ room, locale, headingLevel }`, add `flip?: boolean`), `components/site/RoomGallery.tsx` (restyle into grid3/split frames within the sharpness rule, no lightbox), `app/site.css`
- Create: `lib/design/room-row.ts`
- Test: `tests/design/room-row.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `RoomCard` type from `lib/content-repo`.
- Produces: `roomRowProps(room: RoomCard): { hasPhoto: boolean; price: string | null; photoHeight: number }` — `price` is `formatPrice(fromPrice)` or `null`; `photoHeight` is `min(290, maxSlotHeight(room.image, 520))` (0 when no image).

- [ ] **Step 1: Write the failing test**: a room with `image: "rooms/rooms_76.jpg"`, `fromPrice: 2980` → `{ hasPhoto: true, price: formatPrice(2980), photoHeight: 290 }`; `image: null` → `hasPhoto: false, photoHeight: 0`; `fromPrice: null` → `price: null`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: rooms list = ink `PageHead` + rows alternating photo left/right (`flip` on odd rows), name, English name, summary, facts, price row ("起／晚"), "訂這間"; no empty frame when no photo, no price text when null. Room detail = ink head with room name + English name → gallery in grid3/split → spec list on paper → ink CTA band linking to `/book?room=<slug>`.
- [ ] **Step 4:** Run → PASS; `npx vitest run` → all pass.
- [ ] **Step 5:** Screenshot `/zh-TW/rooms`, `/ja/rooms/deluxe-room` at 375 and 1440.
- [ ] **Step 6:** Commit `feat(site): editorial rooms list and room detail`.

---

### Task 6: Content pages (facilities, location, attractions, groups, FAQ, privacy, terms, reviews, news)

**Files:**
- Create: `lib/content/sections.ts`
- Modify: `components/site/ContentPage.tsx` (chapters from sections; keeps props `locale, slug, captions, plain, aside, children, maxPhotos`; adds `layout?: "chapters" | "list"`), `components/site/RichText.tsx` only if a helper is needed to render one section's body, `app/[locale]/{facilities,location,attractions,groups,faq,privacy,terms,reviews}/page.tsx`, `app/[locale]/news/page.tsx`, `app/[locale]/news/[slug]/page.tsx`, `app/site.css`
- Test: `tests/content/sections.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `loadPage(slug, locale)` (existing; for the English label also `loadPage(slug, "en")`).
- Produces:
  - `splitSections(body: string): { heading: string | null; body: string }[]` — splits on lines starting with `## `; text before the first heading is a section with `heading: null` (omitted when blank); a body with no `## ` → one section with `heading: null`.
  - `englishLabels(sections, enSections): (string | null)[]` — label i is the i-th English section's heading when both lists have the same number of headed sections; otherwise all `null`.
  - `assignPhotos(photos: string[], chapterCount: number): string[][]` — distributes in order, at most 2 per chapter, remaining chapters get `[]`; `chapterCount` 0 → `[]`.

- [ ] **Step 1: Write the failing tests**:
  - `splitSections("intro\n## 5F\na\n## 8F\nb")` → `[{heading:null, body:"intro"}, {heading:"5F", body:"a"}, {heading:"8F", body:"b"}]`;
  - `splitSections("no headings here")` → `[{heading:null, body:"no headings here"}]`; leading blank intro omitted;
  - `englishLabels` with 3 vs 3 headed sections → the three English headings; with 3 vs 2 → `[null,null,null]`;
  - `assignPhotos(["a","b","c"], 2)` → `[["a","b"],["c"]]`; `assignPhotos(["a"], 3)` → `[["a"],[],[]]`; `assignPhotos([], 2)` → `[[],[]]`.
- [ ] **Step 2:** Run `npx vitest run tests/content/sections.test.ts` → FAIL.
- [ ] **Step 3:** Implement and wire pages:
  - facilities: `layout="chapters"` — one numbered `Chapter` per headed section (2–4 sections), photos via `assignPhotos` in `PhotoSplit`;
  - location, attractions, groups: `layout="list"` — one unnumbered chapter, sections as a two-column list with hairline dividers, photos in one `PhotoGrid3`/`PhotoSplit` (respect sharpness; drop photos that fit no slot);
  - faq, privacy, terms, news article: ink `PageHead` + paper reading column max ~680px, body 17px/1.85;
  - reviews, news list: ink head; reviews scores reuse `RatingsStrip` styling.
- [ ] **Step 4:** Run → PASS; `npx vitest run` → all pass.
- [ ] **Step 5:** Screenshot `/zh-TW/facilities`, `/en/location`, `/ko/faq`, `/ja/news` at 375 and 1024.
- [ ] **Step 6:** Commit `feat(site): chapter and reading layouts for content pages`.

---

### Task 7: Booking, manage, under-construction notice and 404

**Files:**
- Modify: `app/[locale]/book/page.tsx`, `app/[locale]/book/details/page.tsx`, `app/[locale]/book/return/*`, `app/[locale]/manage/page.tsx`, `app/[locale]/manage/[code]/*` (use `PageHead theme="paper"`), `components/booking/BookingDisabledNotice.tsx` (centred paper panel, same content), `app/[locale]/not-found.tsx` (ink head with existing copy), `app/booking.css` (typography/colour alignment only; form structure, fields, validation and button behaviour unchanged)

**Interfaces:**
- Consumes: Tasks 1–3 (`PageHead`, `headerTheme`).
- Produces: nothing new.

- [ ] **Step 1:** Run `npx vitest run tests/booking tests/api` → note the passing baseline (these must stay green; no logic changes).
- [ ] **Step 2:** Implement the restyle.
- [ ] **Step 3:** `npx vitest run` → all pass; `npx tsc --noEmit` clean.
- [ ] **Step 4:** With `BOOKING_OPEN=false` (site-preview): screenshot `/zh-TW/book` and `/en/manage` (建置中 panel, paper header). Then run `npm run dev` without the override (`.dev.vars` mock modes) and click through search → details → mock pay → return on `/zh-TW` at 375px to confirm the flow still completes.
- [ ] **Step 5:** Commit `feat(site): booking pages and notices aligned with the new look`.

---

### Task 8: Cross-locale verification and preview deploy

**Files:**
- Modify: whatever the sweep finds (CSS fixes only unless a component bug).

- [ ] **Step 1:** Sweep with the browser pane: every public route × {zh-TW, en, ja, ko} × {375, 768, 1024, 1440}. For each: no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`), header height constant (no wrap), no frame displayed taller than `maxSlotHeight` of its source (JS: for each `img` in a frame, `naturalHeight >= clientHeight * 1.4`). Record failures and fix them.
- [ ] **Step 2:** Keyboard: tab through `/zh-TW` from the top; every focusable element inside ink bands shows a gold ring.
- [ ] **Step 3:** Emulate `prefers-reduced-motion: reduce`; reload `/zh-TW`; hero and chapter photos are visible immediately.
- [ ] **Step 4:** `npx vitest run`, `npx tsc --noEmit`, `npx eslint` → clean.
- [ ] **Step 5:** Stop the local dev server; `CI=1 npm run deploy:preview`; then `rm -rf .next`. Check the public URL: `/zh-TW`, `/en/rooms`, `/ja/facilities`, `/ko/book` return 200 and render the new look.
- [ ] **Step 6:** Commit any sweep fixes `fix(site): redesign polish from the locale/width sweep` and push.
