# Brand and company layer (品牌與企業頁)

Status: owner said "直接開始，按照你分析之後的建議" (2026-11-26) — direction is the controller's call. Builds on the
Lamplight × Editorial redesign (docs/superpowers/specs/2026-11-25-site-visual-redesign-design.md, merged ba301a7).

## Why
The owner wants the site to read well to investors (a New Zealand and a Japanese hotel investor were named) and to
support the ambition of world-class recognition. Today the site is a good booking site but says nothing about the company:
no brand story page, no company information, no sustainability or community story, no place for an investor to start a
conversation, and the guest awards are a small strip. Japanese investors look for 会社概要 first; NZ investors look for
sustainability and evidence.

## Goals
- Four new public pages, in all four languages, built from the existing content system (DB `content_pages`, editable in
  /admin like facilities): `about` 品牌故事, `sustainability` 永續與在地, `company` 公司資訊, `partners` 投資與合作.
- A "關於小公館" footer column linking them (plus 住客評價), and 品牌故事 first in the header nav.
- Home: the intro statement links to the brand story; the ratings strip links to the reviews/awards page.

## Hard rule: no invented facts
Every statement must come from content that already exists: content/old-site.json (home story, news-281 減塑 2025,
news-183 HBL 2019, news-181 cyclist guest, news-184 Booking.com Guest Review Award 2019, review page awards),
content/localized/*, messages/*.json, lib/content/reviews.ts, the property row (address, phone, email, check-in 15:00,
check-out 11:00), the room list (8 room types). Unknown facts — legal company name, 統一編號, 旅宿業登記證號, founding
year, owner/representative, occupancy, revenue, team size — are NOT written and NOT shown as placeholders. The owner adds
them later in /admin (the pages are editable there); the final report lists exactly what to add.

## Pages (layouts from ContentPage)
- about — chapters layout (numbered): 我們的信念 (旅行是生活的延伸；旅途中也可以回家), 用心佈置 (為家人挑選的心情選每一項
  家居用品；350 織精梳棉寢具), 在這裡留下的故事 (2019 HBL 乙級男女組冠軍球隊入住；自由車選手李冠賢). No photos needed beyond
  what fits (reuse home story photos via pageImages fallback if any fit).
- sustainability — chapters: 減塑 (2025-01-01 起備品移至大廳誠實商店、房內不提供瓶裝水、各樓層飲水機), 在地連結 (松山、
  南京東路五段、周邊景點頁已有的事實), 與旅人同行 (運動隊伍與旅人的故事 — only facts above).
- company — list layout: 品牌名稱, 地址, 電話, Email, 櫃台服務 (24 小時), 入住／退房時間, 房型 (8 種，從旅艙到連通房), 公共
  空間樓層 (5F、8F、14F). Nothing else.
- partners — chapters: 品牌定位 (Nanjing E. Rd Sec. 5 humanist hostel, from single cube to connecting room), 住客肯定
  (scores and awards exactly as in lib/content/reviews.ts and the old reviews page, with years where the source gives
  them), 洽談合作 (email the existing address; subject line suggestion「投資與合作洽詢」). No figures beyond those.

## Style
Same visual language (ink PageHead, paper chapters, gold on ink). Company and partners read as corporate: restrained,
no exclamation marks, no emoji. ja copy in polite business register (です／ます), ko in 합니다체.

## Non-goals
No new data model or API, no admin restyle, no booking change, no new photos, no IR financial pages.
