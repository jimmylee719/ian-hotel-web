# Translations and content awaiting human review

Everything listed here was translated or written by Claude (machine translation), not by a native
speaker or the owner. Please have each language checked before launch, then delete its entry.

Legend: **MT** = machine-translated, **NEW** = written from scratch (the old site had no such text),
**EDIT** = old-site text edited (shortened, reordered or corrected).

## 1. UI messages (`messages/*.json`)

zh-TW is the source. Brand names (`header.brand`, `header.brandEn`), `localeNames.*`,
`localeShort.*`, `home.taglineEn`, `footer.facebook` and `footer.instagram` are identical in every
locale on purpose.

| Keys | en | ja | ko |
|---|---|---|---|
| `meta.siteName`, `meta.title`, `meta.description` | MT | MT | MT |
| `header.home`, `header.mainNav`, `header.menu`, `header.bookNow`, `header.language`, `header.skipToContent` | MT | MT | MT |
| `nav.*` (rooms, facilities, access, attractions, groups, faq, news) | MT | MT | MT |
| `home.taglineFirst`, `home.taglineSecond` | kept in Chinese (vertical tagline is a design element, marked `lang="zh-TW"`) | MT ("旅は / 暮らしの延長", the phrase from design/proposals/a.html) | MT ("여행은 / 삶의 연장입니다", from a.html) |
| `home.intro`, `home.nearMrt`, `home.heroAlt`, `home.heroCaption` | MT | MT | MT |
| `booking.*` (title, checkIn, checkOut, guests, adults, children, rooms, guestSummary, nights, decrease, increase, done, search, checkOutAfterCheckIn, selectDate) | MT | MT | MT |
| `footer.address`, `footer.nearMrt` | en address from the old /en/ site; nearMrt MT | MT (check the Japanese address form) | MT (check the Korean address form) |
| `footer.phone`, `footer.email`, `footer.line`, `footer.privacy`, `footer.terms`, `footer.copyright`, `footer.contact`, `footer.siteLinks`, `footer.legal` | MT | MT | MT |
| `amenities.*` (33 keys) | old /en/ icon labels, EDIT (capitalisation, "Safety" -> "Safe", "public bath" -> "Shared bathroom") | MT | MT |
| `notFound.*` | MT | MT | MT |
| `nav.reviews`, `booking.openSearch`, `booking.close` (Task 8) | MT | MT | MT |
| `home.story*`, `home.rooms*`, `home.allRooms`, `home.facilities*`, `home.reviews*`, `home.location*`, `home.directions`, `home.openMap` (Task 8) | MT; story text is EDIT of the old /en/ home page | MT | MT |
| `rooms.*` (Task 8, room list and room pages) | MT | MT | MT |
| `pages.*` (Task 8, meta descriptions, photo alt text, address heading) | MT | MT | MT |
| `facilityPhoto.*` (Task 8, captions written from the photos) | MT | MT | MT |
| `news.*`, `faq.*` (Task 8) | MT | MT | MT |
| `reviews.*` (Task 8); award names follow the wording on each platform's certificate | MT | MT | MT |
| `inquiry.*` (Task 8, group inquiry form) | MT | MT | MT |
| `book.*`, `checkout.*`, `bookingStatus.*`, `manage.*`, `footer.manageBooking` (Task 9, booking flow: search results, details form, payment return, manage booking) | MT | MT | MT |
| `nav.about`, `nav.sustainability`, `nav.company`, `nav.partners`, `footer.aboutTitle`, `home.storyMore`, `pages.aboutDescription`, `pages.sustainabilityDescription`, `pages.companyDescription`, `pages.partnersDescription`, `pages.partnersMailSubject`, `pages.partnersMailLink` (brand and company layer) | MT | MT | MT |

zh-TW keys that are NEW (not on the old site): `meta.title`, `meta.description`, `home.intro`,
`home.heroCaption`, `home.heroAlt` (from design/proposals/a.html), `footer.nearMrt`, `booking.*`,
`notFound.*`, everything added in Task 9 (`book.*`, `checkout.*`, `bookingStatus.*`, `manage.*`), and everything added in Task 8 except `home.storyBody*` (EDIT of the old home page text).

Task 8 also hard-codes, in four languages, the hotel amenity names in `lib/jsonld.ts` (`HOTEL_AMENITIES`, MT) and the PostalAddress parts there (ja/ko reuse the zh-TW/en forms; please check). The ratings in `lib/content/reviews.ts` were read off the old award images; the owner should confirm they are still current before launch.

Task 9 notes for review: `checkout.payNote` names Bank SinoPac (永豐銀行) as the payment page; `checkout.policyNote`
and `manage.cancelledRefund` ("7 to 14 working days") state refund rules and timing the owner must confirm.
The country list on the details form uses the browser's own region names (`Intl.DisplayNames`), not our translations.

## 2. Database content (`content/localized/*.ts`, seeded by `lib/db/seed-content.ts`)

The old site's /en/ pages mostly still carried the Chinese text, so English is machine-translated too
unless stated.

### Rooms (`content/localized/rooms.ts`): `description`, `bedType` for all 8 room types

| Field | zh-TW | en | ja | ko |
|---|---|---|---|---|
| `description` (8 rooms, incl. the shared "house rules" blocks) | EDIT | MT | MT | MT |
| `bedType` (8 rooms) | NEW (derived from the old descriptions) | MT | MT | MT |
| `sizeSqm` | from the old descriptions (capsules: 3 m² is the capsule, not a room) | | | |

### Content pages (`content/localized/pages.ts`)

| Page | zh-TW | en | ja | ko | Owner to confirm |
|---|---|---|---|---|---|
| `facilities` | EDIT (amenities.php) | MT | MT | MT | laundry prices, 14F access rule |
| `access` | EDIT, condensed (location.php; bus fares and the full parking list dropped) | MT | MT | MT | bus routes, pick-up prices NT$1,600 / NT$2,000, B2 parking NT$300 |
| `attractions` | NEW short descriptions (attractions.php only had names) | MT | MT | MT | walking/ride times are estimates |
| `groups` | EDIT (group.php + group2.php) | EDIT of old /en/ text + MT | MT | MT | long-stay: old zh page said 15 nights, old en page said 30 nights; both are offered in the copy |
| `privacy` | NEW | NEW | NEW | NEW | needs legal review (Taiwan PDPA) |
| `booking-terms` | NEW, follows the seeded `direct-flex` rate plan (100% refund >= 3 days, 50% at 1-2 days, 0 on the day) | NEW | NEW | NEW | needs owner/legal sign-off |
| `about` (brand layer) | EDIT of the old home page (main.php), rooms.intro, news-183 and news-181 | MT | MT | MT | romanised/transliterated name of cyclist 李冠賢 (en "Lee Kuan-hsien", ko "리관셴") |
| `sustainability` (brand layer) | EDIT of news-281, access/attractions/groups pages, news-183/181 | MT | MT | MT | |
| `company` (brand layer) | NEW arrangement of existing facts (property row, FAQ check-in/out, facilities, rooms) | MT | MT | MT | add legal name, 統一編號, 旅宿業登記證號, founding year, representative in /admin |
| `partners` (brand layer) | NEW arrangement; ratings exactly as lib/content/reviews.ts | MT | MT | MT | |

### FAQs (`content/localized/faqs.ts`): all 18 (`qa-8-1` ... `qa-5-3`)

zh-TW EDIT, en/ja/ko MT, title and body. Notes:
- `qa-8-1` keeps the old OTA cancellation rule (first-night based), which differs from the direct
  rate plan in `booking-terms`; a sentence points direct bookers to their confirmation email.
  The owner should decide whether the FAQ should simply state the direct-booking rule.
- `qa-8-4` (pre-authorisation) gained a NEW sentence that direct bookings are paid in full online.
- `qa-8-5` lists the "家庭四人房" (Family Room), which no longer exists; it was dropped from the list.

### News (`content/localized/news.ts`)

| Slug | zh-TW | en | ja | ko |
|---|---|---|---|---|
| `news-281` (2025 plastic reduction) | EDIT | MT | MT | MT |
| `news-184` (Booking.com award) | EDIT | MT | MT | MT |

Not migrated (scraped into `content/old-site.json` but not seeded): `news-183`, `news-181`,
`news-185` (2019 guest stories with outdated links).

### Room type and rate plan names (`lib/db/seed-nk.ts`, Task 9)

zh-TW and en are the old site's names; **ja and ko are MT** (previously the English names were stored for ja/ko):

| slug | ja | ko |
|---|---|---|
| `mixed-cube` | 男女共用ダブルカプセル | 남녀 공용 2인 캡슐 |
| `female-cube` | 女性専用ダブルカプセル | 여성 전용 2인 캡슐 |
| `buddy-room` | バディルーム（4名） | 버디 룸 (4인) |
| `buddy-room-six` | バディルーム（6名） | 버디 룸 (6인) |
| `mini-room` | ミニダブルルーム | 미니 더블룸 |
| `classic-room` | クラシックダブルルーム | 클래식 더블룸 |
| `deluxe-room` | デラックスダブルルーム | 디럭스 더블룸 |
| `connecting-room` | コネクティングルーム（4名） | 커넥팅 룸 (4인) |
| rate plan `direct-flex` | 公式サイト限定・フレキシブルプラン | 공식 홈페이지 전용 · 유연한 취소 |

The property name stays "NK Hostel" in ja/ko (brand, as in the UI messages).

### Local-only seed data (`scripts/seed-local.ts`, Task 9)

A breakfast add-on (早餐 / Breakfast / 朝食 / 조식, NT$250 per adult per night, ja/ko MT) and a `WELCOME10`
promo code are seeded for local testing only. The owner sets the real add-ons and prices (Plan 3 admin).
