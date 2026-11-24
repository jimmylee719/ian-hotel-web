# Plan 1 — 基礎與核心（Foundation & Core Domain）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建好跑在 Cloudflare 上的專案骨架和多館資料庫，並完成訂房的核心邏輯：可訂查詢、報價、退款計算、SiteMinder 介面（含模擬器）、防超賣。最後提供一支可以實際呼叫的可訂查詢 API。

**Architecture:** 核心邏輯一律寫成純函式（`lib/domain/*`），不依賴資料庫和平台，用 Vitest 直接測。資料存取放在 `lib/db/*`，用 Drizzle 的 SQLite 方言。正式環境接 D1，測試環境用 better-sqlite3 跑同一份 schema 和 migration。SiteMinder 透過 `ChannelManager` 介面存取，Plan 1 只實作 `MockChannelManager`。

**Tech Stack:** Next.js 15（App Router）+ TypeScript strict、@opennextjs/cloudflare、Wrangler、Cloudflare D1、Drizzle ORM + drizzle-kit、Vitest、better-sqlite3（只在測試用）、date-fns + date-fns-tz、zod。

**Spec:** `docs/superpowers/specs/2026-11-24-nk-hostel-direct-booking-design.md`

**後續計畫：** Plan 2 官網加直訂流程和永豐金流 → Plan 3 員工後台 → Plan 4 正式串接 SiteMinder 和上線。

## Global Constraints

- 平台全部使用 Cloudflare（Workers + D1 + R2），不使用 Supabase 和 Vercel。
- 日期一律用半開區間 `[checkIn, checkOut)`，以 `YYYY-MM-DD` 字串表示，時區是 `Asia/Taipei`。
- 金額一律用整數新台幣元（`number`，必須是整數），所有訂單金額只能由 `quote()` 這一個函式算出來。
- 房價和庫存的唯一真實來源是 SiteMinder。本地的 `ari_daily` 只是快取，每一列都要記錄 `source` 和 `syncedAt`。
- 任何資料表都不能有卡號、CVV、卡片有效期限的欄位。
- 所有面向旅客的文字都要有 `zh-TW`、`en`、`ja`、`ko` 四種語言，存成 JSON 物件 `{ "zh-TW": ..., "en": ..., "ja": ..., "ko": ... }`。
- 每張業務資料表都要有 `propertyId`，不能有寫死只適用單一館別的邏輯。
- D1 沒有 RLS，所以存取控制統一寫在 API 層（Plan 3 實作）。Plan 1 的 API 只開放唯讀的可訂查詢。

## Review Focus

1. **退房日不晚於入住日，或日期格式不對** → `searchAvailability` 要回傳驗證錯誤，不可以回傳空陣列（否則旅客會誤以為「沒房」）。測試寫在 Task 4。
2. **住宿期間中有任何一晚停售、庫存為 0、或沒有 ARI 資料** → 這個方案整段都不可訂。沒有資料要當成「不可訂」，不可以當成「有房」。測試寫在 Task 4。
3. **兩筆訂單同時搶最後一間房** → 只能有一筆成功扣到庫存，另一筆要回傳 `SOLD_OUT`。測試寫在 Task 6。
4. **折扣大於房費小計** → 總額最低是 0，不可以出現負數；而且折扣只套用在房費，不套用在加購項目。測試寫在 Task 5。
5. **取消時間剛好落在退款規則的分界點**（例如入住前剛好 3 天的 00:00，台北時間）→ 依規則「入住前 N 天（含）以前」計算，邊界時間點視為符合。測試寫在 Task 5。

---

### Task 1: 專案骨架（Next.js on Cloudflare）、git、測試環境

**Files:**
- Create: `package.json`、`tsconfig.json`、`next.config.ts`、`open-next.config.ts`、`wrangler.jsonc`、`vitest.config.ts`、`.gitignore`、`.dev.vars.example`、`app/layout.tsx`、`app/page.tsx`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces: npm scripts `dev`、`build`、`preview`（OpenNext 本機預覽）、`deploy`、`test`（`vitest run`）、`db:generate`（drizzle-kit generate）、`db:migrate:local`（`wrangler d1 migrations apply nk-booking --local`）。D1 binding 名稱固定為 `DB`，資料庫名稱固定為 `nk-booking`。

- [ ] **Step 1:** 在 `/Users/jimmy/AI_Project/ian-hotel-web` 執行 `git init`；並在 `.gitignore` 加入 `node_modules`、`.next`、`.open-next`、`.wrangler`、`.dev.vars`。
- [ ] **Step 2:** 依照 @opennextjs/cloudflare 官方的「現有專案」指南，建立 Next.js 15 + TypeScript strict + Tailwind 的骨架。`wrangler.jsonc` 加上 D1 binding `DB`。`database_id` 先填 `"local"`，部署時再替換成實際值。
- [ ] **Step 3:** 寫 `tests/smoke.test.ts`：`expect(1 + 1).toBe(2)`。
- [ ] **Step 4:** 執行 `npm test`，預期 1 passed；執行 `npm run build`，預期成功。
- [ ] **Step 5:** Commit：`chore: scaffold Next.js on Cloudflare with D1 and Vitest`（設計文件和這份計畫一起提交）。

---

### Task 2: 日期和金額的基本工具

**Files:**
- Create: `lib/domain/dates.ts`、`lib/domain/money.ts`
- Test: `tests/domain/dates.test.ts`、`tests/domain/money.test.ts`

**Interfaces:**
- Produces:
  - `type ISODate = string`（`YYYY-MM-DD`）
  - `parseStay(checkIn: string, checkOut: string): { ok: true; nights: ISODate[] } | { ok: false; error: "INVALID_DATE" | "CHECKOUT_NOT_AFTER_CHECKIN" | "STAY_TOO_LONG" }`，住宿最長 30 晚
  - `todayInTaipei(now?: Date): ISODate`
  - `daysBefore(checkIn: ISODate, at: Date): number`：以台北時間的日曆日計算，入住當天回傳 0
  - `assertTwd(n: number): number`：不是整數或小於 0 就丟出錯誤
  - `percentOf(amount: number, pct: number): number`：四捨五入到整數元

- [ ] **Step 1:** 寫失敗的測試：
  - `parseStay("2026-12-01","2026-12-03")` 回傳 nights 為 `["2026-12-01","2026-12-02"]`。
  - `parseStay("2026-12-03","2026-12-03")` 回傳 `CHECKOUT_NOT_AFTER_CHECKIN`。
  - `parseStay("2026-13-01","2026-12-03")` 回傳 `INVALID_DATE`。
  - 住 31 晚回傳 `STAY_TOO_LONG`。
  - `daysBefore("2026-12-10", new Date("2026-12-06T16:00:00Z"))` 回傳 `3`（台北時間 12/07 00:00）。
  - `daysBefore("2026-12-10", new Date("2026-12-06T15:59:59Z"))` 回傳 `4`。
  - `percentOf(1999, 10)` 回傳 `200`。
  - `assertTwd(1.5)` 會丟出錯誤。
- [ ] **Step 2:** 執行 `npx vitest run tests/domain`，預期 FAIL（模組不存在）。
- [ ] **Step 3:** 用 date-fns-tz 的 `toZonedTime`，依照上面的簽名實作。
- [ ] **Step 4:** 執行 `npx vitest run tests/domain`，預期 PASS。
- [ ] **Step 5:** Commit：`feat(domain): half-open stay dates and integer TWD helpers`

---

### Task 3: 多館資料庫 schema、migration、種子資料

**Files:**
- Create: `lib/db/schema.ts`、`drizzle.config.ts`、`drizzle/migrations/*`（產生出來的）、`lib/db/seed-nk.ts`、`tests/helpers/test-db.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Produces（Drizzle sqlite-core 的表；所有 id 用 `text` 存 UUID，時間戳用 `integer` 存 epoch ms，`I18n` 是型別 `Record<"zh-TW"|"en"|"ja"|"ko", string>` 的 JSON 欄位）：
  - `properties`：`id, slug, type("hotel"|"campsite"), name:I18n, timezone, currency, address:I18n, phone, email, smPropertyCode?, sinopacMerchantId?, createdAt`
  - `unitTypes`：`id, propertyId, slug, name:I18n, description:I18n, maxAdults, maxOccupancy, bedType:I18n, sizeSqm?, amenities(JSON string[]), sortOrder, smRoomCode?, active`
  - `units`：`id, propertyId, unitTypeId, label, active`
  - `ratePlans`：`id, propertyId, slug, name:I18n, smRatePlanCode?, directOnly(boolean), paymentMode("full"|"deposit"), depositPct(int), cancelPolicy(JSON CancelPolicy), includesBreakfast(boolean), active`
  - `ariDaily`：主鍵 `(unitTypeId, ratePlanId, date)`，欄位 `propertyId, available(int), price(int), minStay(int, 預設 1), closedToArrival, closedToDeparture, stopSell, source("siteminder"|"local"), syncedAt`
  - `guests`：`id, propertyId, firstName, lastName, email, phone, country, locale, createdAt`
  - `reservations`：`id, propertyId, code(唯一、人類可讀，例如 NK-7K3P9Q), guestId, status("pending_payment"|"paid_pending_confirm"|"confirmed"|"confirm_failed_refunded"|"cancelled"), channel("direct"|"siteminder_ota"), smConfirmation?, checkIn, checkOut, adults, children, locale, quote(JSON Quote), totalAmount(int), promoCode?, syncState("not_required"|"pending"|"synced"|"failed"), createdAt, updatedAt`
  - `reservationRooms`：`id, reservationId, unitTypeId, ratePlanId, nightlyPrices(JSON int[])`
  - `payments`：`id, reservationId, kind("charge"|"preauth"|"capture"|"refund"|"front_desk"), method("sinopac_online"|"edc"|"cash"|"transfer"), amount(int), status("pending"|"succeeded"|"failed"), providerRef?, authCode?, last4?, createdAt` ← **不可以有**卡號、CVV、有效期限欄位
  - `addons`：`id, propertyId, slug, name:I18n, price(int), unit("per_stay"|"per_night"|"per_person_night"), active`
  - `promoCodes`：`id, propertyId, code, kind("percent"|"fixed"), value(int), validFrom?, validTo?, maxUses?, usedCount, active`
  - `staff`：`id, email(唯一), name, role("owner"|"manager"|"front_desk"|"marketing"), propertyIds(JSON string[]), active`
  - `auditLog`：`id, staffEmail, action, entity, entityId, before(JSON)?, after(JSON)?, at`
  - `contentPages`、`news`、`faqs`：`id, propertyId, slug, title:I18n, body:I18n, publishedAt?, sortOrder`
  - 預留表 `members`：`id, guestId, tier, points`
  - `createTestDb(): BetterSQLite3Database<typeof schema>`：建立記憶體資料庫，並套用 `drizzle/migrations`。
  - `seedNk(db): Promise<{ propertyId: string }>`

- [ ] **Step 1:** 寫失敗的測試：
  - `createTestDb()` 之後執行 `seedNk`，`properties` 有 1 筆，slug 為 `nk-hostel`，type 為 `hotel`。
  - `unitTypes` 有 8 筆，slug 依序為 `mixed-cube`、`female-cube`、`buddy-room`、`buddy-room-six`、`mini-room`、`classic-room`、`deluxe-room`、`connecting-room`。
  - `payments` 的欄位名稱中，沒有任何一個符合 `/card|cvv|pan|expir/i`（用 `PRAGMA table_info(payments)` 檢查）。
- [ ] **Step 2:** 執行 `npx vitest run tests/db`，預期 FAIL。
- [ ] **Step 3:** 實作 schema，執行 `npm run db:generate` 產生 migration，再寫 `test-db.ts` 和 `seed-nk.ts`。
  - 種子資料的房型（zh-TW / en；ja 和 ko 先放英文，Plan 2 再翻譯；maxOccupancy 依序 2,2,4,6,2,2,2,4）：男.女混合雙人旅艙 MIXED CUBE、女性雙人旅艙 FEMALE CUBE、旅伴四人客房 BUDDY ROOM、六人行客房 BUDDY ROOM FOR SIX、迷你雙人套房 MINI ROOM、經典雙人套房 CLASSIC ROOM、景緻雙人套房 DELUXE ROOM、行政四人套房（連通房）CONNECTING ROOM。
  - 館別資料：地址「105 台北市松山區南京東路五段399號5樓」／「5F, No.399, Sec. 5, Nanjing E. Rd, Songshan Dist., Taipei City 105, Taiwan」，電話 `+886 2 2769 0200`，Email `info@nkhostel.com`，時區 `Asia/Taipei`，幣別 `TWD`。
  - 種子房價方案：`direct-flex`（官網專屬，`directOnly=true`，全額付款，取消規則 `{ rules: [{daysBefore:3,refundPct:100},{daysBefore:1,refundPct:50}] }`，其餘情況 0%）。
- [ ] **Step 4:** 執行 `npx vitest run tests/db`，預期 PASS；再執行 `npm run db:migrate:local`，預期成功套用。
- [ ] **Step 5:** Commit：`feat(db): multi-property schema, migrations, NK seed`

---

### Task 4: 可訂查詢（純邏輯 + 查詢資料庫）

**Files:**
- Create: `lib/domain/availability.ts`、`lib/db/ari-repo.ts`
- Test: `tests/domain/availability.test.ts`、`tests/db/ari-repo.test.ts`

**Interfaces:**
- Consumes: `parseStay`（Task 2）、`ariDaily`、`unitTypes`、`ratePlans`（Task 3）
- Produces:
  - `type AriNight = { date: ISODate; available: number; price: number; minStay: number; closedToArrival: boolean; closedToDeparture: boolean; stopSell: boolean }`
  - `type Offer = { unitTypeId: string; ratePlanId: string; nightlyPrices: number[]; roomSubtotal: number; availableUnits: number }`
  - `evaluateOffer(nights: ISODate[], checkOut: ISODate, rows: AriNight[], rooms: number): Offer | null`
    - 每一晚都要有資料、未停售、`available >= rooms`。
    - 第一晚不可以是 `closedToArrival`。
    - 退房日那一列如果存在而且 `closedToDeparture=true`，就不可訂。
    - 住宿晚數要 `>=` 第一晚的 `minStay`。
    - `availableUnits` 取所有晚數中的最小值。
  - `searchAvailability(db, q: { propertyId: string; checkIn: string; checkOut: string; adults: number; rooms?: number }): Promise<{ ok: true; offers: (Offer & { unitType; ratePlan })[] } | { ok: false; error: string }>`
    - 篩掉 `maxOccupancy < ceil(adults / rooms)` 的房型。
    - 只回傳 `active` 的房型和方案。
    - 依房型的 `sortOrder` 排序，同房型再依 `roomSubtotal` 由低到高排序。

- [ ] **Step 1:** 寫失敗的測試（`evaluateOffer`）：
  - 兩晚都有房，價格 [2000, 2400]，回傳 roomSubtotal 為 4400。
  - 第二晚 `stopSell` 回傳 null。
  - 第二晚沒有資料列回傳 null。
  - 第二晚 `available` 為 0 回傳 null。
  - 第一晚 `closedToArrival` 回傳 null。
  - 只住一晚但第一晚 `minStay=2` 回傳 null。
  - `rooms=2` 但某一晚 `available=1` 回傳 null。
- [ ] **Step 2:** 寫失敗的測試（`searchAvailability`，用 createTestDb + seedNk + 手動插入 ARI）：
  - `checkOut <= checkIn` 回傳 `{ ok:false, error:"CHECKOUT_NOT_AFTER_CHECKIN" }`。
  - adults=5 只會出現 `buddy-room-six`。
  - 回傳結果的順序符合 sortOrder。
- [ ] **Step 3:** 執行 `npx vitest run tests/domain/availability.test.ts tests/db/ari-repo.test.ts`，預期 FAIL。
- [ ] **Step 4:** 實作。`searchAvailability` 用一次查詢取出 `date IN nights ∪ {checkOut}` 的資料，在記憶體裡依 `(unitTypeId, ratePlanId)` 分組後，交給 `evaluateOffer` 判斷。
- [ ] **Step 5:** 執行同樣的測試，預期 PASS。
- [ ] **Step 6:** Commit：`feat(domain): availability evaluation and search`

---

### Task 5: 報價（唯一的金額入口）和取消退款計算

**Files:**
- Create: `lib/domain/quote.ts`、`lib/domain/cancellation.ts`
- Test: `tests/domain/quote.test.ts`、`tests/domain/cancellation.test.ts`

**Interfaces:**
- Consumes: `Offer`（Task 4）、`percentOf`、`daysBefore`（Task 2）
- Produces:
  - `type AddonLine = { addonId: string; unit: "per_stay"|"per_night"|"per_person_night"; unitPrice: number; qty: number }`
  - `type Promo = { code: string; kind: "percent"|"fixed"; value: number }`
  - `type Quote = { nights: number; roomSubtotal: number; addonLines: { addonId: string; amount: number }[]; addonSubtotal: number; discount: number; total: number; payNow: number; payLater: number; promoCode?: string }`
  - `quote(input: { offer: Offer; nights: number; adults: number; rooms: number; addons: AddonLine[]; promo?: Promo; paymentMode: "full"|"deposit"; depositPct: number }): Quote`
    - roomSubtotal 等於 `offer.roomSubtotal × rooms`。
    - 加購金額：`per_stay` 是 `unitPrice × qty`；`per_night` 是 `unitPrice × qty × nights`；`per_person_night` 是 `unitPrice × qty × adults × nights`。
    - 折扣只套用在 roomSubtotal，最多等於 roomSubtotal。
    - `total = roomSubtotal − discount + addonSubtotal`。
    - full 模式 `payNow = total`；deposit 模式 `payNow = percentOf(total, depositPct)`，`payLater = total − payNow`。
  - `type CancelPolicy = { rules: { daysBefore: number; refundPct: number }[] }`（依 daysBefore 由大到小，取第一個符合 `daysBefore(checkIn, at) >= rule.daysBefore` 的規則；都不符合就是 0%）
  - `refundAmount(policy: CancelPolicy, paid: number, checkIn: ISODate, at: Date): number`

- [ ] **Step 1:** 寫失敗的測試：
  - 房費 4400 × 1 間、percent 10% 折扣、早餐 per_person_night 250 × qty 1、2 大人 2 晚：discount 440，addonSubtotal 1000，total 4960。
  - fixed 折扣 9999 套用在房費 4400：discount 4400，total 等於 addonSubtotal，不會是負數。
  - deposit 模式 30%、total 4960：payNow 1488，payLater 3472。
  - 用 Task 3 種子的取消規則、已付 4960、入住 2026-12-10：
    - 在 `2026-12-06T16:00:00Z` 取消（剛好入住前 3 天）退 4960。
    - 在 `2026-12-08T16:00:00Z` 取消（入住前 1 天）退 2480。
    - 在 `2026-12-09T16:00:00Z` 取消（入住當天）退 0。
- [ ] **Step 2:** 執行 `npx vitest run tests/domain/quote.test.ts tests/domain/cancellation.test.ts`，預期 FAIL。
- [ ] **Step 3:** 依照上面的簽名實作，輸出前用 `assertTwd` 驗證每一個金額欄位。
- [ ] **Step 4:** 執行同樣的測試，預期 PASS。
- [ ] **Step 5:** Commit：`feat(domain): single-entry quote and cancellation refund`

---

### Task 6: ChannelManager 介面、SiteMinder 模擬器、ARI 同步、防超賣扣庫存

**Files:**
- Create: `lib/channel/types.ts`、`lib/channel/mock.ts`、`lib/db/atomic.ts`、`lib/db/ari-sync.ts`、`lib/db/inventory-hold.ts`
- Test: `tests/channel/mock.test.ts`、`tests/db/ari-sync.test.ts`、`tests/db/inventory-hold.test.ts`

**Interfaces:**
- Consumes: `ariDaily`、`reservations`（Task 3）、`ISODate`（Task 2）
- Produces:
  - `type AriUpdate = { smRoomCode: string; smRatePlanCode: string; date: ISODate; available?: number; price?: number; minStay?: number; closedToArrival?: boolean; closedToDeparture?: boolean; stopSell?: boolean }`
  - `type ChannelReservation = { code: string; smPropertyCode: string; checkIn: ISODate; checkOut: ISODate; rooms: { smRoomCode: string; smRatePlanCode: string; nightlyPrices: number[] }[]; guest: { firstName: string; lastName: string; email: string; phone: string }; total: number; paidAmount: number; addons: { name: string; amount: number }[]; promoCode?: string }`
  - `interface ChannelManager { pushReservation(r: ChannelReservation): Promise<{ ok: true; smConfirmation: string } | { ok: false; retryable: boolean; error: string }>; modifyReservation(r: ChannelReservation): Promise<同上>; cancelReservation(code: string): Promise<{ ok: boolean; retryable: boolean; error?: string }> }`
  - `class MockChannelManager implements ChannelManager`：建構子參數 `{ failNext?: number; retryable?: boolean }`，可以模擬前 N 次失敗；`pushed: ChannelReservation[]` 方便測試檢查。
  - `applyAriUpdates(db, propertyId: string, updates: AriUpdate[], now: Date): Promise<{ applied: number; unknownCodes: string[] }>`：用 sm code 對應到本地 id，upsert 時寫入 `source="siteminder"` 和 `syncedAt=now`。沒有省略的欄位才覆寫。
  - `holdInventory(db, items: { unitTypeId: string; ratePlanId: string; nights: ISODate[]; rooms: number }[]): Promise<{ ok: true } | { ok: false; error: "SOLD_OUT" }>`：
    - 每一晚都用條件式 `UPDATE ari_daily SET available = available - :rooms, source='local' WHERE ... AND available >= :rooms AND stop_sell = 0`。
    - 只要有任何一列影響 0 列，整筆就回滾。
    - D1 用 `db.batch`，測試環境用 transaction。
    - 用 `lib/db/atomic.ts` 裡的 `runAtomic(db, statements)` 抽象掉兩者的差異（D1 是 batch，better-sqlite3 是 transaction）。
  - `releaseInventory(db, items: 同上): Promise<void>`

- [ ] **Step 1:** 寫失敗的測試：
  - `applyAriUpdates` 套用 2 筆已知 code 和 1 筆未知 code：applied 為 2，unknownCodes 為 `["XX"]`；資料列的 source 為 `siteminder`。
  - 只更新 price 時，原本的 available 不會被覆寫。
  - `holdInventory` 在 available=1 時，連續呼叫兩次：第一次 ok，第二次回傳 `SOLD_OUT`，最後 available 為 0。
  - 兩晚中第二晚 available=0：回傳 `SOLD_OUT`，第一晚的 available **維持原值**（已回滾）。
  - `MockChannelManager({ failNext: 1, retryable: true })` 第一次 push 回傳 `{ok:false, retryable:true}`，第二次回傳 ok，並帶有 `smConfirmation`。
- [ ] **Step 2:** 執行 `npx vitest run tests/channel tests/db/ari-sync.test.ts tests/db/inventory-hold.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作上面的介面。
- [ ] **Step 4:** 執行同樣的測試，預期 PASS；再執行 `npm test`，確認全部 PASS。
- [ ] **Step 5:** Commit：`feat(channel): ChannelManager contract, SiteMinder mock, ARI sync, atomic inventory hold`

---

### Task 7: 可訂查詢 API（在 Workers 上接 D1），可以實際呼叫

**Files:**
- Create: `lib/db/client.ts`（`getDb()`：用 `getCloudflareContext().env.DB` 搭配 `drizzle-orm/d1`）、`app/api/availability/route.ts`、`scripts/seed-local.ts`（把 seedNk 和 14 天的假 ARI 寫進本地 D1，價格 2000 到 3200，available 為 3）
- Test: `tests/api/availability.test.ts`

**Interfaces:**
- Consumes: `searchAvailability`（Task 4）、`seedNk`（Task 3）
- Produces: `GET /api/availability?property=nk-hostel&checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&adults=N&rooms=N`
  - 回傳 200 `{ offers: [{ unitType: { slug, name }, ratePlan: { slug, name }, nightlyPrices, roomSubtotal, availableUnits }] }`。
  - 驗證錯誤回傳 400 `{ error }`；找不到館別回傳 404。
  - 回應標頭 `Cache-Control: no-store`。
  - Route 匯出 `dynamic = "force-dynamic"`。
  - 查詢參數用 zod 驗證：adults 是 1 到 12 的整數，rooms 是 1 到 6 的整數。

- [ ] **Step 1:** 寫失敗的測試：把 route handler 的核心抽成 `handleAvailability(db, url: URL): Promise<Response>`，用 createTestDb 測試：
  - checkIn 等於 checkOut 回傳 400。
  - 未知的 property 回傳 404。
  - 正常查詢回傳 200，`Cache-Control` 為 `no-store`，`offers.length > 0`。
- [ ] **Step 2:** 執行 `npx vitest run tests/api`，預期 FAIL。
- [ ] **Step 3:** 實作 `handleAvailability`，讓 `route.ts` 的 GET 呼叫它並傳入 `getDb()`。
- [ ] **Step 4:** 執行 `npx vitest run tests/api`，預期 PASS。
- [ ] **Step 5:** 依序執行 `npm run db:migrate:local`、`npx tsx scripts/seed-local.ts`（透過 `wrangler d1 execute nk-booking --local` 寫入）、`npm run preview`。接著用 `curl "http://localhost:8787/api/availability?property=nk-hostel&checkIn=<明天>&checkOut=<後天>&adults=2"`，預期回傳 200 JSON，而且包含 `mixed-cube`。
- [ ] **Step 6:** Commit：`feat(api): availability endpoint on Cloudflare Workers + D1`
