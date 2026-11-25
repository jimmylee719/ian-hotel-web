# Plan 3 — 員工後台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出給飯店員工使用的後台 `/admin`，範圍如下：

- 營運總覽與警示
- 訂單：查詢、詳情時間軸、員工取消、改日期、補收款、櫃檯刷卡機登錄、重寄信件、卡住退款的對帳
- 內容管理：房型（四語＋照片）、消息、FAQ、頁面
- 加購、折扣碼、房價方案設定
- 報表（CSV 匯出）
- 員工帳號與角色權限
- 操作紀錄

登入一律透過 Cloudflare Access。

**Architecture:**

- **身分與權限**
  - 每個 `/admin` 和 `/api/admin` 請求都先經過 `requireStaff()`：
    1. 驗證 Cloudflare Access 的 JWT（`Cf-Access-Jwt-Assertion`），驗簽、檢查 `aud`、`iss` 和到期時間。
    2. 用 email 查 `staff` 表，取出角色和可管理的館別。
    3. 用 `can(staff, permission, propertyId)` 判斷權限。
  - 本機開發（`ENVIRONMENT=local`）可以用 `DEV_STAFF_EMAIL` 略過 JWT。其他環境一律驗證。
- **商業邏輯放在 `lib/admin/*` 的 service**
  - 和 Plan 2 一樣，只接收 `Db`、`Deps`、`now` 和操作的員工，所以可以在 better-sqlite3 上完整測試。
  - 每個寫入動作都要呼叫 `recordAudit()`。
- **重用 Plan 2 的機制**
  - 金額只用 `quote()` 計算。
  - 退款只走 `refundOnce()`，用固定的 idempotency key，避免重複退款。
  - 狀態轉換只走 `transition()`。
  - 庫存只走 `holdStatements`、`releaseInventory`。
  - 寄信只走 `sendOnce`。
- **畫面**
  - 後台介面只做繁體中文。員工都在台灣，spec 也只要求旅客端四語。
  - 視覺沿用 `design/tokens.md` 的色彩與字體，但版面以清楚、資訊密度高為主，不需要精品網站的大圖風格。

**Tech Stack:** 沿用 Plan 1、Plan 2，另外加上 `jose`（在 Workers 上驗證 JWT）。

**Spec:** `docs/superpowers/specs/2026-11-24-nk-hostel-direct-booking-design.md`，主要對應 5.6、5.7、5.8、5.9。

**承接 Plan 2：**

- 執行時的決定和延後處理的小問題，都在 `docs/superpowers/plans/2026-11-25-plan-2-rulings.md`。本計畫要解決其中幾項：
  - 卡在 pending 的退款要能對帳
  - 寄信失敗要能重寄
  - 房型照片改存資料庫
  - `seedContent` 不可以再覆蓋員工編輯過的內容
  - 退款金額不符時，要寄信通知旅客
- 現有的 service：
  - `lib/booking/{create,confirm,manage,notify,payment-notice,state,to-channel,pricing}.ts`
  - `lib/jobs/*`
  - `lib/runtime/deps.ts`：`getDeps`、`getCoreDeps`、`buildDeps`、`bookingDisabledReason`
  - `lib/db/inventory-hold.ts`：`holdStatements`、`releaseInventory`
  - `lib/content-repo.ts`
  - `lib/media.ts`：`mediaUrl`、`findMedia`

## Global Constraints

- **登入與身分**
  - 後台只能透過 Cloudflare Access 登入。
  - JWT 必須驗證簽章（JWKS 取自 `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`）、`aud` 要等於 `CF_ACCESS_AUD`、`iss` 要等於 team domain、`exp` 不能過期。
  - 任何 header 裡的 email（例如 `Cf-Access-Authenticated-User-Email`）都**不能**當作身分依據。
- **權限矩陣**（`lib/admin/permissions.ts`，只有這一份）：

  | 權限 | owner | manager | front_desk | marketing |
  |---|---|---|---|---|
  | `dashboard.view` | ✓ | ✓ | ✓ | ✓ |
  | `reservations.view` | ✓ | ✓ | ✓ | |
  | `reservations.cancel`（依規則退款） | ✓ | ✓ | ✓ | |
  | `reservations.refund_override`（自訂退款金額） | ✓ | ✓ | | |
  | `reservations.modify`（改日期、改人數） | ✓ | ✓ | ✓ | |
  | `payments.front_desk`（登錄刷卡機、現金、匯款） | ✓ | ✓ | ✓ | |
  | `payments.reconcile`（處理卡住的退款） | ✓ | ✓ | | |
  | `notifications.resend` | ✓ | ✓ | ✓ | |
  | `content.edit` | ✓ | ✓ | | ✓ |
  | `commerce.edit`（加購、折扣碼、房價方案、館別設定） | ✓ | ✓ | | |
  | `reports.view` | ✓ | ✓ | | |
  | `staff.manage` | ✓ | | | |
  | `audit.view` | ✓ | ✓ | | |

- **館別範圍**：員工只能看到和操作 `staff.propertyIds` 裡的館別。owner 也一樣受這個限制，不會自動擁有所有館別的權限。
- **操作紀錄**：每個寫入動作都要寫一筆 `auditLog`（staffEmail、action、entity、entityId、before、after、at）。寫入的資料本身和 audit 要放在同一個 `runAtomic` batch，可以的話一律這樣做。
- **重用規則**
  - 金額只能由 `quote()` 算出。
  - 退款只能走 `refundOnce()`，而且要用固定的 key，例如 `staffcancel:<resId>`、`modify:<resId>:<n>`、`override:<resId>:<n>`。
  - 狀態轉換只能走 `transition()`。
  - 不可以存卡號。櫃檯登錄只記末四碼、授權碼、金額。
- **資料一致性**
  - 員工的動作和旅客的動作（例如員工取消、旅客也同時取消）要收斂到同一個退款 intent 和同一個 claim，不能退兩次款。
- **匯出安全**
  - 報表一律匯出 CSV（UTF-8 加 BOM，Excel 才能正確顯示中文）。spec 寫的是「匯出 Excel」，CSV 可以直接用 Excel 開啟，而且不需要在 Workers 上跑很重的 xlsx 套件。
  - 開頭是 `= + - @`、tab 或 CR 的儲存格，前面要加 `'`，防止 CSV 公式注入。
- **上傳**
  - 照片只接受 `image/jpeg`、`image/png`、`image/webp`、`image/avif`，大小不超過 8 MB。
  - 上傳時要檢查檔案開頭的 magic bytes，不能只看 Content-Type。
  - 存到 R2 的 `rooms/<slug>/<uuid>.<ext>`，並產生縮圖版本（沿用 `media:variants` 的尺寸）。

## Review Focus

1. **偽造身分**：沒有 JWT、JWT 簽章錯誤、`aud` 不對、已經過期，或只帶了 email header → 一律 401。JWT 有效，但 email 不在 staff 表、或已停用 → 403。測試寫在 Task 1。
2. **越權**：front_desk 呼叫自訂退款金額、marketing 呼叫訂單 API、員工操作不屬於自己館別的訂單 → 403，資料完全不變。測試寫在 Task 1、5、7。
3. **員工取消和旅客取消同時發生，或在 SiteMinder 重送時取消** → 只退一次款，最後狀態一致。測試寫在 Task 5。
4. **改日期時新日期沒有房** → 回傳 `NOT_AVAILABLE`，原本的訂單和保留的房間完全不變。改到比原本便宜 → 差額經 `refundOnce` 退款，而且不會重複退。測試寫在 Task 7。
5. **自訂退款金額超過可退金額、櫃檯登錄負數或小數金額、CSV 儲存格以 `=` 開頭、上傳偽裝成圖片的 HTML** → 前三種拒絕或轉義，偽裝的圖片拒收。測試寫在 Task 5、6、9、10。

---

### Task 1: 後台身分驗證、權限矩陣、操作紀錄

**Files:**
- Create: `lib/admin/access-jwt.ts`、`lib/admin/permissions.ts`、`lib/admin/auth.ts`、`lib/admin/audit.ts`
- Modify: `middleware.ts`（把 `/admin` 從 i18n middleware 排除）、`wrangler.jsonc`（vars 加 `CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`，本機留空）、`.dev.vars.example`（加 `DEV_STAFF_EMAIL`）、`package.json`（加 `jose`）
- Test: `tests/admin/access-jwt.test.ts`、`tests/admin/permissions.test.ts`、`tests/admin/auth.test.ts`、`tests/admin/audit.test.ts`

**Interfaces:**
- Produces:
  - `verifyAccessJwt(token: string, cfg: { teamDomain: string; aud: string; jwks?: JWTVerifyGetKey }, now?: Date): Promise<{ ok: true; email: string } | { ok: false; error: "MISSING" | "INVALID" | "EXPIRED" | "WRONG_AUD" | "WRONG_ISS" }>`
    - 用 jose 的 `createRemoteJWKSet` 取得金鑰；測試時可以傳入本機的 `jwks`。
    - email 取自 JWT 的 `email` claim，轉成小寫。
  - `type Permission`：權限矩陣中的 13 個字串。`ROLE_PERMISSIONS: Record<StaffRole, Permission[]>` 必須和 Global Constraints 的矩陣完全一致。
  - `can(staff: StaffRow, p: Permission, propertyId?: string): boolean`：如果有傳入 propertyId，也要檢查它在 `staff.propertyIds` 裡。
  - `type StaffContext = { staff: StaffRow; email: string }`
  - `resolveStaff(db, env: AppEnv, headers: Headers, now?: Date): Promise<{ ok: true; ctx: StaffContext } | { ok: false; status: 401 | 403; error: string }>`
    - 只有在 `ENVIRONMENT === "local"` 而且 `env.DEV_STAFF_EMAIL` 有值時，才略過 JWT。
    - 其他情況都必須帶 `Cf-Access-Jwt-Assertion` 並通過驗證。
    - `CF_ACCESS_TEAM_DOMAIN` 或 `CF_ACCESS_AUD` 沒設定時，一律回傳 401，錯誤碼 `ACCESS_NOT_CONFIGURED`（fail closed）。
  - `requireStaff(p: Permission, propertyId?: string): Promise<StaffContext>`：給 Server Component 和 route 用，失敗時丟出 `AdminAuthError(status)`。
  - `withAdmin(p: Permission, handler: (ctx, req) => Promise<Response>)`：route handler 的包裝。401 和 403 回傳 JSON，畫面另由 layout 顯示「無權限」頁。
  - `auditStatement(db, ctx: StaffContext, a: { action: string; entity: string; entityId: string; before?: unknown; after?: unknown }, now: Date)`：回傳一個可以放進 `runAtomic` 的 statement。另外提供 `recordAudit(...)`，直接寫入。

- [ ] **Step 1: 寫失敗的測試。** 先用 jose 的 `generateKeyPair("RS256")` 產生本機 JWKS，再簽出以下幾種 token：
  - 正確的 token → 回傳 `ok: true`，email 是小寫。
  - aud 錯誤 → `WRONG_AUD`。
  - 已過期 → `EXPIRED`。
  - 用另一把金鑰簽的 → `INVALID`。
  - 空字串 → `MISSING`。
- [ ] **Step 2: 寫失敗的權限測試。**
  - 逐一比對 13 個權限 × 4 個角色，結果要和 Global Constraints 的矩陣完全一致。
  - 員工的 `propertyIds = ["A"]`，對 propertyId `"B"` 呼叫 `can` → false。
- [ ] **Step 3: 寫失敗的 `resolveStaff` 測試。**
  - 只帶 `Cf-Access-Authenticated-User-Email` header，沒有 JWT → 401。
  - JWT 有效，但 email 不在 staff 表 → 403。
  - JWT 有效，但員工 `active=false` → 403。
  - `ENVIRONMENT=production` 而且設了 `DEV_STAFF_EMAIL` → 照樣要求 JWT，回傳 401。
  - `ENVIRONMENT=local` 加上 `DEV_STAFF_EMAIL` → ok。
  - `CF_ACCESS_AUD` 沒設定 → 401 `ACCESS_NOT_CONFIGURED`。
- [ ] **Step 4: 寫失敗的 `audit` 測試。** `auditStatement` 和一筆資料更新放在同一個 `runAtomic` 執行後，兩筆都存在；如果資料更新失敗，audit 也不會留下。
- [ ] **Step 5:** 執行 `npx vitest run tests/admin`，預期 FAIL。
- [ ] **Step 6:** 實作上面的介面，安裝 `jose`。
- [ ] **Step 7:** 執行 `npx vitest run`，預期全部 PASS；再執行 `npx tsc --noEmit`，預期沒有錯誤。
- [ ] **Step 8:** Commit：`feat(admin): Cloudflare Access JWT auth, role permissions, audit log`

---

### Task 2: 後台外殼（版面、導覽、館別切換、無權限頁）

**Files:**
- Create: `app/admin/layout.tsx`、`app/admin/page.tsx`（導向 `/admin/dashboard`）、`app/admin/forbidden/page.tsx`、`app/admin/admin.css`、`components/admin/{AdminNav,PropertySwitcher,DataTable,Pagination,ConfirmDialog,Toast,StatusBadge,Money,DateRange}.tsx`、`lib/admin/property-scope.ts`、`lib/admin/paginate.ts`
- Test: `tests/admin/property-scope.test.ts`、`tests/admin/paginate.test.ts`

**Interfaces:**
- Consumes: `requireStaff`、`can`（Task 1）
- Produces:
  - `currentPropertyId(ctx: StaffContext, cookieValue?: string): string`：從 cookie `admin_property` 讀取館別。如果 cookie 沒有值、或不在員工可管理的範圍內，就回傳 `propertyIds[0]`。
  - `paginate<T>(query, { page: number; pageSize: number }): Promise<{ rows: T[]; total: number; page: number; pageCount: number }>`：pageSize 預設 20、上限 100，總筆數用 `count()` 另外查。
  - 導覽列只顯示員工有權限的項目：總覽、訂單、旅客、內容、加購與折扣、房價方案、報表、員工、操作紀錄、系統狀態。
  - 元件：
    - `Money` 用 `NT$4,960` 格式。
    - `StatusBadge` 涵蓋所有訂單狀態和 syncState，用中文標籤和顏色區分。
    - `DataTable` 支援排序參數和空狀態。
    - `ConfirmDialog` 處理需要二次確認的動作。
    - `Toast` 顯示成功或錯誤訊息。

- [ ] **Step 1: 寫失敗的測試。**
  - `currentPropertyId`：cookie 是不在範圍內的館別 → 回傳 `propertyIds[0]`。
  - `paginate`：一共 45 筆、pageSize 20、第 3 頁 → rows 有 5 筆，pageCount 是 3；pageSize 傳 500 → 只回傳 100 筆。
- [ ] **Step 2:** 執行 `npx vitest run tests/admin/property-scope.test.ts tests/admin/paginate.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作。版面和元件先載入 `frontend-design` skill 再做，色彩與字體用 `design/tokens.md`。
- [ ] **Step 4:** 執行 `npx vitest run` 和 `npx tsc --noEmit`，預期 PASS。
- [ ] **Step 5: 手動檢查。** 用 `.dev.vars` 設定 `ENVIRONMENT=local`、`DEV_STAFF_EMAIL=owner@local.test`，並在 seed 中新增這位 owner，執行 `npm run preview`。
  - `/admin` → 導向 dashboard，導覽列項目齊全。
  - 把 `DEV_STAFF_EMAIL` 改成 marketing 員工 → 導覽列只剩總覽和內容；直接打開 `/admin/reservations` 會看到無權限頁。
  - 桌機和平板寬度都截圖。
- [ ] **Step 6:** Commit：`feat(admin): admin shell, navigation, property scope, shared components`

---

### Task 3: 營運總覽與警示

**Files:**
- Create: `lib/admin/dashboard.ts`、`app/admin/dashboard/page.tsx`
- Test: `tests/admin/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 1、2
- Produces: `getDashboard(db, propertyId: string, now: Date): Promise<Dashboard>`，回傳的 `Dashboard` 包含：
  - `arrivalsToday`、`departuresToday`、`inHouse`：都是 `ReservationRow[]`，只算 confirmed，日期以台北時間計算。
  - `pendingPayment: number`
  - `alerts: Alert[]`，`Alert = { kind: "sync_failed" | "sync_pending_stale" | "refund_pending" | "stray_refund_failed" | "email_failed" | "payment_alert"; reservationId?: string; code?: string; detail: string; since: number }`：
    - `sync_failed`：syncState 是 failed。
    - `sync_pending_stale`：syncState 是 pending，而且 nextSyncAt 已經過了 15 分鐘以上。
    - `refund_pending`：退款紀錄是 pending，而且建立超過 10 分鐘。
    - `stray_refund_failed`：`lastSyncError` 以 `STRAY_REFUND_FAILED` 開頭。
    - `email_failed`：notifications 的 status 是 failed。
    - `payment_alert`：最近 7 天的 paymentEvents 裡，verdict 是 amount_mismatch 或 stray_charge。
  - `kpis`：今天和本月的直訂營收（成功收款減成功退款）、間夜數、取消數。

  畫面上的警示依嚴重度排序，每一筆都連到對應的訂單詳情或對帳頁。

- [ ] **Step 1: 寫失敗的測試。**
  - 準備以下資料：今天入住、今天退房、正在住、各一筆；sync failed 一筆；pending 退款 11 分鐘一筆；email failed 一筆。`getDashboard` 回傳的各個清單和 alerts 種類都要正確。
  - 其他館別的訂單不會出現在結果裡。
  - 本月營收等於 charges 減 refunds。
- [ ] **Step 2:** 執行 `npx vitest run tests/admin/dashboard.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作 `getDashboard` 和頁面。
- [ ] **Step 4:** 執行 `npx vitest run`，預期 PASS。
- [ ] **Step 5:** Commit：`feat(admin): operations dashboard with alerts and KPIs`

---

### Task 4: 訂單列表、搜尋、詳情時間軸、旅客列表

**Files:**
- Create: `lib/admin/reservations.ts`、`lib/admin/guests.ts`、`app/admin/reservations/page.tsx`、`app/admin/reservations/[id]/page.tsx`、`app/admin/guests/page.tsx`、`app/admin/guests/[id]/page.tsx`
- Test: `tests/admin/reservations.test.ts`、`tests/admin/guests.test.ts`

**Interfaces:**
- Consumes: `paginate`、`currentPropertyId`（Task 2）、`paidAmount`（Plan 2 notify.ts）
- Produces:
  - `listReservations(db, propertyId, f: { q?: string; status?: ResStatus[]; syncState?: string[]; from?: ISODate; to?: ISODate; dateField?: "checkIn" | "createdAt"; page: number; pageSize: number; sort?: "checkIn" | "-createdAt" }): Promise<Page<ReservationListRow>>`
    - `q` 可以比對訂單代碼（不分大小寫）、旅客姓名、Email、電話。
    - `ReservationListRow` 包含：code、status、syncState、checkIn、checkOut、晚數、房型名稱（zh-TW）、旅客姓名、`total`、`paid`、`refunded`、`balanceDue`、createdAt。
  - `getReservationDetail(db, propertyId, id): Promise<ReservationDetail | null>`：不屬於這個館別的訂單回傳 null。內容包含：
    - 基本資料、quote 明細、房型和方案
    - payments（每筆的 kind、method、status、金額、末四碼、授權碼、idempotencyKey）
    - paymentEvents（rawBody 不顯示原文，只顯示長度和 verdict）
    - notifications、與這筆訂單有關的 auditLog
    - `timeline`：把上面所有項目依時間排序後合併
  - 內部備註：新增表 `reservation_notes(id, reservationId, propertyId, staffEmail, body, createdAt)`，並產生 migration。
    - `addReservationNote(db, ctx, reservationId, body: string, now)`：body 去掉前後空白後要有 1 到 2000 字，需要 `reservations.view` 權限，寫 audit。
    - 詳情頁的 timeline 要包含備註。備註只能新增，不能修改或刪除。
  - `listGuests(db, propertyId, { q, page, pageSize })`、`getGuest(db, propertyId, id)`：旅客的歷史訂單、總消費、住宿次數。
  - 列表頁的篩選條件都放在 URL query string，可以加書籤和分享連結。

- [ ] **Step 1: 寫失敗的測試。**
  - 用小寫的 `nk-abc` 搜得到 `NK-ABC234`。
  - 用旅客姓氏、Email 也都搜得到。
  - 篩選 `status=confirmed` 加上入住日區間，結果正確。
  - 其他館別的訂單不會出現。
  - `getReservationDetail` 的 timeline 有排序，涵蓋 payment、event、notification、audit 四種項目，而且不會出現 rawBody 的原文。
  - `balanceDue` 等於 total 減掉已收淨額。
  - `addReservationNote` 的 body 是空字串或超過 2000 字 → 拒絕；正常新增後會出現在 timeline。
- [ ] **Step 2:** 執行 `npx vitest run tests/admin/reservations.test.ts tests/admin/guests.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作 service 和頁面。詳情頁上方放操作按鈕，依權限顯示；實際的動作由 Task 5–7 接上，這個任務先放停用的按鈕。
- [ ] **Step 4:** 執行 `npx vitest run`，預期 PASS。
- [ ] **Step 5:** 執行 `npm run db:generate` 和 `npm run db:migrate:local`，然後 Commit：`feat(admin): reservation search, detail timeline, notes, guest records`

---

### Task 5: 員工取消、自訂退款、重寄信件、卡住退款的對帳

**Files:**
- Create: `lib/admin/staff-cancel.ts`、`lib/admin/reconcile.ts`、`lib/admin/resend.ts`、`app/api/admin/reservations/[id]/cancel/route.ts`、`app/api/admin/refunds/[paymentId]/reconcile/route.ts`、`app/api/admin/notifications/[id]/resend/route.ts`、`app/admin/refunds/page.tsx`
- Modify: `lib/booking/manage.ts`（抽出取消核心，讓旅客和員工共用，介面不變）、`lib/booking/confirm.ts`（退款金額不符時寄信通知旅客；這是 Plan 2 延後處理的項目）
- Test: `tests/admin/staff-cancel.test.ts`、`tests/admin/reconcile.test.ts`、`tests/admin/resend.test.ts`

**Interfaces:**
- Consumes: `cancelReservation` 的核心（manage.ts）、`refundOnce`（confirm.ts）、`sendOnce`（notify.ts）、`withAdmin`、`auditStatement`（Task 1）
- Produces:
  - `staffCancel(deps: Deps, ctx: StaffContext, reservationId: string, opts: { reason: string; refundOverride?: number; notifyGuest: boolean }, now: Date): Promise<{ ok: true; refunded: number; alreadyCancelled: boolean } | { ok: false; error: "NOT_FOUND" | "FORBIDDEN" | "NOT_CANCELLABLE" | "REFUND_FAILED" | "OVERRIDE_EXCEEDS_PAID" | "INVALID_OVERRIDE" }>`
    - 沒有 `refundOverride` 時，依取消規則退款，key 用 `cancel:<resId>`，和旅客取消用同一個 key，兩邊會收斂到同一筆退款。
    - 有 `refundOverride` 時，需要 `reservations.refund_override` 權限，金額必須是 0 到淨已收之間的整數，key 用 `cancel:<resId>`。intent 已經存在時，以既有的那筆為準。
    - 員工可以取消入住日之後的訂單，但只釋放「今天以後」的晚數，已經住過的晚數不釋放。
    - 每次都寫 audit，內容包含 reason 和退款金額。
  - `listPendingRefunds(db, propertyId)`：列出 pending 的退款紀錄，附上訂單代碼、金額、建立時間、idempotencyKey。
  - `reconcileRefund(deps, ctx, paymentId, action: { kind: "mark_succeeded"; providerRef: string } | { kind: "mark_failed" } | { kind: "retry" }, now)`
    - 需要 `payments.reconcile` 權限。
    - `mark_succeeded`：用條件式更新，只有在 status 是 pending 時才生效；把 `refundedAmount` 加上這筆金額；如果這筆退款屬於一張已經 claim 但還沒完成的取消，就接著完成取消流程。
    - `mark_failed`：只把 status 改成 failed，不會自動重試。
    - `retry`：只有 status 是 failed 時才能用，用原本的 key 重新呼叫 `refundOnce`。
    - 每次都寫 audit。
  - `resendNotification(deps, ctx, notificationId, now)`：只能重寄 status 是 failed 的通知。重新組信寄出後，同一筆紀錄更新為 sent 或 failed，不新增紀錄；status 已經是 sent 的，回傳 `ALREADY_SENT`。

- [ ] **Step 1: 寫失敗的測試。**
  - 員工取消，依規則退款 50% → 和旅客取消的結果一致，key 是 `cancel:<id>`。
  - 員工和旅客同時取消（用 `Promise.all`）→ gateway 只收到一次退款。
  - front_desk 傳了 `refundOverride` → FORBIDDEN，資料不變。
  - manager 傳的 override 超過淨已收 → `OVERRIDE_EXCEEDS_PAID`；傳 `1.5` → `INVALID_OVERRIDE`。
  - 住到第 2 晚時由員工取消 → 只釋放剩下的晚數。
  - 操作其他館別的訂單 → `NOT_FOUND`（不透露訂單是否存在）。
  - `mark_succeeded` 套在卡住的取消退款上 → 訂單變成 cancelled，refundedAmount 正確；對同一筆再呼叫一次 → 不會重複加金額。
  - `retry` 套在 failed 的退款上 → gateway 收到同一個 idempotencyKey。
  - `resend`：failed 的通知重寄成功後變成 sent；已經是 sent 的回傳 `ALREADY_SENT`。
  - 退款金額不符時，旅客會收到通知信。
- [ ] **Step 2:** 執行 `npx vitest run tests/admin/staff-cancel.test.ts tests/admin/reconcile.test.ts tests/admin/resend.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作，並把操作接到詳情頁和 `/admin/refunds`。所有動作都要經過 `ConfirmDialog` 二次確認。
- [ ] **Step 4:** 執行 `npx vitest run`，預期全部 PASS。原本 Plan 2 旅客取消的測試也要全部通過。
- [ ] **Step 5:** Commit：`feat(admin): staff cancellation, refund override, refund reconciliation, email resend`

---

### Task 6: 櫃檯收款登錄（刷卡機、現金、匯款）與待收餘額

**Files:**
- Create: `lib/admin/front-desk.ts`、`app/api/admin/reservations/[id]/payments/route.ts`
- Modify: `lib/booking/notify.ts`（`paidAmount` 的計算要包含 `front_desk` 這種收款，並確認旅客取消和員工取消的退款計算都會把它算進去）
- Test: `tests/admin/front-desk.test.ts`

**Interfaces:**
- Consumes: `withAdmin`、`auditStatement`（Task 1）、`paidAmount`
- Produces:
  - `recordFrontDeskPayment(db, ctx, reservationId, p: { method: "edc" | "cash" | "transfer"; amount: number; last4?: string; authCode?: string; note?: string }, now): Promise<{ ok: true; paymentId: string; balanceDue: number } | { ok: false; error: "NOT_FOUND" | "INVALID_AMOUNT" | "INVALID_LAST4" | "OVERPAY" }>`
    - amount 必須是正整數，而且不能超過 `balanceDue + 0`，也就是不能多收。
    - `last4` 用 `/^\d{4}$/` 驗證；method 是 `edc` 時，`last4` 和 `authCode` 都必填。
    - 寫入 `kind="front_desk"`、`status="succeeded"`，和 audit 放在同一個 batch。
  - `voidFrontDeskPayment(db, ctx, paymentId, reason, now)`：需要 manager 以上的權限，只能作廢當天建立的櫃檯收款。作廢是把 status 改成 failed 並寫 audit，不會刪除資料。
  - 這種收款**不經過**金流 gateway，所以線上退款也不會退到櫃檯收的錢。取消時，櫃檯收款部分的退款金額另外顯示「需由櫃檯退款」，系統不自動退。

- [ ] **Step 1: 寫失敗的測試。**
  - 金額 -100、0、1.5 → `INVALID_AMOUNT`。
  - 超過待收餘額 → `OVERPAY`。
  - method 是 edc 但沒有 last4 → `INVALID_LAST4`；last4 是 `"12a4"` → `INVALID_LAST4`。
  - 正常登錄 → balanceDue 減少，audit 存在。
  - front_desk 作廢收款 → FORBIDDEN；manager 作廢當天的收款 → status 變成 failed，balanceDue 恢復。
  - 取消有櫃檯收款的訂單 → 線上退款只退線上收的部分，回傳的結果另外列出需由櫃檯退的金額。
- [ ] **Step 2:** 執行 `npx vitest run tests/admin/front-desk.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作，並在詳情頁放「登錄收款」表單。
- [ ] **Step 4:** 執行 `npx vitest run`，預期 PASS。
- [ ] **Step 5:** Commit：`feat(admin): front-desk payment entry with balance due and void`

---

### Task 7: 員工修改訂單（改日期、改人數、改房型）

**Files:**
- Create: `lib/admin/modify.ts`、`app/api/admin/reservations/[id]/modify/route.ts`、`app/api/admin/reservations/[id]/modify/preview/route.ts`
- Modify: `lib/booking/to-channel.ts`（修改後要推送 `modifyReservation`）、`lib/jobs/sync-retry.ts`（處理修改失敗後的重試）
- Test: `tests/admin/modify.test.ts`

**Interfaces:**
- Consumes: `searchAvailability`、`quote`（共用的 pricing helper）、`holdStatements`、`releaseInventory`、`refundOnce`、`ChannelManager.modifyReservation`、`transition`
- Produces:
  - `previewModification(db, ctx, reservationId, change: { checkIn: string; checkOut: string; adults: number; children: number; unitTypeSlug?: string; ratePlanSlug?: string }, now): Promise<{ ok: true; newQuote: Quote; difference: number; refundIfLower: number; balanceIfHigher: number } | { ok: false; error: "NOT_FOUND" | "NOT_MODIFIABLE" | "NOT_AVAILABLE" | "INVALID_INPUT" }>`
    - 只有 `confirmed` 而且 `todayInTaipei <= checkIn` 的訂單可以修改。
    - 新報價要保留原本的加購項目，按新晚數和新人數重算。原本的折扣碼照樣套用，但不檢查使用次數。
  - `applyModification(deps, ctx, reservationId, change, opts: { expectedDifference: number; reason: string }, now)`
    - 先重新算一次 preview。如果算出來的差額和 `expectedDifference` 不一樣，回傳 `PRICE_CHANGED`，什麼都不改。
    - 只把新舊兩段住宿「不重疊的晚數」做 hold 和 release，重疊的晚數不動。新增晚數的 hold、釋放晚數的 release、訂單更新、新的 `reservationRooms`、audit，全部放在同一個 `runAtomic` batch。庫存不夠時，CHECK 會讓整個 batch 失敗 → 回傳 `NOT_AVAILABLE`，原本的資料完全不變。
    - 差額是負的：用 `refundOnce` 退差額，key 是 `modify:<resId>:<n>`，n 是這張訂單第幾次修改。
    - 差額是正的：待收餘額增加，由櫃檯收款（Task 6）收取。
    - 推送 `channel.modifyReservation`。失敗時把 syncState 設成 pending，交給 `runSyncRetry`，重試時呼叫 modify 而不是 push。
    - 旅客會收到修改確認信，用新的 notification kind `booking_modified`。這個 kind 加進 schema enum，四種語言的信件範本都要補上。

- [ ] **Step 1: 寫失敗的測試。**
  - 2 晚改成 3 晚 → 差額是正的，balanceDue 增加；新增那一晚的庫存少 1，重疊的晚數不變。
  - 3 晚改成 2 晚 → `refundOnce` 用 key `modify:<id>:1` 退差額；同一個請求重送一次，不會退第二次。
  - 改到沒房的日期 → `NOT_AVAILABLE`，原本的庫存、訂單和 quote 完全不變。
  - `expectedDifference` 和實際差額不符 → `PRICE_CHANGED`。
  - channel 的 modify 第一次失敗，可以重試 → syncState 是 pending；執行 `runSyncRetry` 之後變成 synced，而且呼叫的是 modify。
  - 修改入住日已經過了的訂單 → `NOT_MODIFIABLE`。
  - marketing 角色呼叫 → 403。
- [ ] **Step 2:** 執行 `npx vitest run tests/admin/modify.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作，並在詳情頁放「修改訂單」對話框：先顯示 preview，員工確認後才 apply。
- [ ] **Step 4:** 執行 `npx vitest run`，預期全部 PASS。
- [ ] **Step 5:** Commit：`feat(admin): staff modification of dates, guests and room with price difference`

---

### Task 8: 內容管理（房型四語與照片、消息、FAQ、頁面）

**Files:**
- Create: `lib/admin/content.ts`、`lib/admin/uploads.ts`、`app/admin/content/{page.tsx,rooms/[id]/page.tsx,news/page.tsx,news/[id]/page.tsx,faqs/page.tsx,pages/[id]/page.tsx}`、`app/api/admin/content/*`、`app/api/admin/uploads/route.ts`、`components/admin/I18nField.tsx`、`components/admin/PhotoManager.tsx`
- Modify:
  - `lib/db/schema.ts`：`unitTypes` 新增 `images: text(json) string[] NOT NULL DEFAULT '[]'`，並產生 migration。
  - `lib/db/seed-content.ts`：改成「只新增不存在的資料」，已經存在的資料不覆蓋。
  - `lib/content-repo.ts`：照片改從 `unitTypes.images` 讀取，沒有照片時才退回 `roomImages(slug)`。
  - `scripts/seed-local.ts`：把 `content/old-site.json` 裡的照片 key 寫進 `images` 欄位。
- Test: `tests/admin/content.test.ts`、`tests/admin/uploads.test.ts`、`tests/db/seed-content.test.ts`（修改）

**Interfaces:**
- Produces:
  - `updateUnitType(db, ctx, id, patch: { name?: I18n; description?: I18n; bedType?: I18n; amenities?: string[]; sizeSqm?: number | null; maxAdults?: number; maxOccupancy?: number; sortOrder?: number; active?: boolean; images?: string[] })`
    - 所有 `I18n` 欄位都必須四種語言都有值、不能是空字串。
    - `images` 裡的每個 key 都必須已經存在 R2。
    - 寫 audit。
  - news、faqs、contentPages 的 CRUD：`createNews` / `updateNews` / `deleteNews`（刪除改成把 `publishedAt` 設成 null 來下架，不真的刪掉）等，規則和 `updateUnitType` 相同。
  - `uploadImage(env, ctx, file: { bytes: Uint8Array; contentType: string; filename: string }, prefix: "rooms/<slug>" | "news" | "pages"): Promise<{ ok: true; key: string } | { ok: false; error: "TOO_LARGE" | "BAD_TYPE" }>`
    - 檢查 magic bytes：JPEG 是 `FF D8 FF`，PNG 是 `89 50 4E 47`，WebP 是 `RIFF....WEBP`，AVIF 是 `ftypavif` 或 `ftypavis`。
    - 最大 8 MB。
    - 寫入 R2 後產生縮圖版本。sharp 在 Workers 上不能用，所以縮圖用 Cloudflare Images 的 binding（`IMAGES`）；本機沒有這個 binding 時，直接存原圖，由 `findMedia` 的 fallback 處理。
  - `PhotoManager`：上傳、拖曳排序、刪除（只從清單移除，不刪 R2 檔案）、設定封面（清單中的第一張）。
  - `I18nField`：四個語言分頁，有空值時顯示紅點，四種都填好才能存檔。
  - 修改內容後，公開頁面要立即生效：頁面都是 `force-dynamic`，如果有快取就清除。

- [ ] **Step 1: 寫失敗的測試。**
  - `updateUnitType` 的 ja 欄位是空字串 → 拒絕。
  - 正常更新 → audit 的 before 和 after 都正確。
  - `images` 裡有不存在的 key → 拒絕。
  - 上傳內容是 HTML、但 contentType 寫 `image/jpeg` → `BAD_TYPE`。
  - 上傳 9 MB 的檔案 → `TOO_LARGE`。
  - 上傳正常的 PNG → 回傳的 key 是 `rooms/<slug>/<uuid>.png`。
  - 在 seedContent 之後修改一筆 FAQ，再執行一次 seedContent → 修改的內容還在。
  - `content-repo` 優先使用 `unitTypes.images`。
- [ ] **Step 2:** 執行 `npx vitest run tests/admin/content.test.ts tests/admin/uploads.test.ts tests/db/seed-content.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作，並執行 `npm run db:generate`、`npm run db:migrate:local`。
- [ ] **Step 4:** 執行 `npx vitest run` 和 `npx tsc --noEmit`，預期 PASS。
- [ ] **Step 5: 手動檢查。** 用 `npm run preview`：在後台改 Deluxe 的日文名稱並上傳一張照片 → `/ja/rooms/deluxe-room` 立刻顯示新名稱和新照片。
- [ ] **Step 6:** Commit：`feat(admin): content management for rooms, photos, news, FAQs and pages`

---

### Task 9: 加購、折扣碼、房價方案、館別設定

**Files:**
- Create: `lib/admin/commerce.ts`、`app/admin/commerce/{addons,promos,rate-plans,property}/page.tsx`、`app/api/admin/commerce/*`
- Test: `tests/admin/commerce.test.ts`

**Interfaces:**
- Produces:
  - Addons 的 CRUD：`slug` 必須唯一，`name: I18n` 四種語言都要有，`price` 是正整數，`unit` 是三種 enum 之一，用 `active` 上下架。
  - PromoCodes 的 CRUD：
    - `code` 一律轉大寫，在同一館別內唯一（大小寫視為相同）。這也解決了 Plan 2 延後處理的大小寫碰撞問題。
    - `kind` 是 percent 時，`value` 要在 1 到 100 之間；是 fixed 時要是正整數。
    - 有效期間的 `validFrom` 要小於等於 `validTo`。
    - `maxUses` 留空代表不限次數，`usedCount` 只能讀不能改。
  - RatePlans 的編輯：
    - 可以改：`name: I18n`、`cancelPolicy`（每條規則的 `daysBefore` 是非負整數、`refundPct` 在 0 到 100 之間；同樣的 daysBefore 不能重複；依 daysBefore 由大到小排序後，refundPct 不可以越來越高）、`paymentMode`、`depositPct`（deposit 模式時要在 1 到 99 之間）、`includesBreakfast`、`directOnly`、`active`。
    - 不能改：`smRatePlanCode`，畫面只顯示，因為它由 SiteMinder 決定。
    - 頁面上要說明：「房價與庫存請在 SiteMinder 調整」。
  - 館別設定：各語言的名稱、地址、電話、Email、`sinopacMerchantId` 和 `smPropertyCode` 只顯示不給改（變更走部署設定）、入住和退房時間、交通說明（`I18n`）。
  - 全部都需要 `commerce.edit` 權限，而且都要寫 audit。

- [ ] **Step 1: 寫失敗的測試。**
  - 已經有折扣碼 `welcome10` 的情況下，再建立 `WELCOME10` → 回傳衝突。
  - percent 折扣的 value 是 150 → 拒絕。
  - cancelPolicy 是 `[{3,50},{1,100}]` → 拒絕（離入住越近退越多，不合理）。
  - deposit 模式但 depositPct 是 0 → 拒絕。
  - front_desk 角色呼叫 → 403。
  - 修改成功後，`createReservation` 用的就是新的加購價格。
- [ ] **Step 2:** 執行 `npx vitest run tests/admin/commerce.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作上面的介面。
- [ ] **Step 4:** 執行 `npx vitest run`，預期 PASS。
- [ ] **Step 5:** Commit：`feat(admin): add-ons, promo codes, rate plan and property settings`

---

### Task 10: 報表與 CSV 匯出

**Files:**
- Create: `lib/admin/reports.ts`、`lib/admin/csv.ts`、`app/admin/reports/page.tsx`、`app/api/admin/reports/[kind]/route.ts`
- Test: `tests/admin/reports.test.ts`、`tests/admin/csv.test.ts`

**Interfaces:**
- Produces:
  - `toCsv(rows: Record<string, unknown>[], columns: { key: string; label: string }[]): string`
    - 開頭加 BOM，用 CRLF 換行。
    - 內容含逗號、引號或換行的值，用雙引號包起來並跳脫引號。
    - 開頭是 `= + - @ \t \r` 的值，前面加 `'`。
  - `revenueReport(db, propertyId, { from: ISODate; to: ISODate; groupBy: "day" | "month" })`：每個期間的線上收款、櫃檯收款、退款、淨額。日期以台北時間計算，以付款的 `createdAt` 為準。
  - `occupancyReport(db, propertyId, { from, to })`：每天、每個房型賣出的間夜數，以及住房率（賣出的間夜除以 inventory 快取中「可售加已售」的總數；沒有資料時顯示「—」）。
  - `bookingsReport(db, propertyId, { from, to })`：每張訂單一列，欄位與訂單列表相同，再加上折扣碼和加購明細。
  - `cancellationReport(db, propertyId, { from, to })`：取消數、取消率、退款總額、依取消時距入住的天數分桶統計。
  - API：`GET /api/admin/reports/<kind>?from=&to=&format=json|csv`，需要 `reports.view` 權限，查詢區間最長 366 天。

- [ ] **Step 1: 寫失敗的測試。**
  - `toCsv`：值 `=1+1` 輸出成 `'=1+1`；值 `a,"b"` 輸出成 `"a,""b"""`；輸出的開頭是 BOM。
  - `revenueReport`：準備台北時間跨月的資料（UTC 時間是 23:30 的付款），歸到正確的月份；淨額等於收款減退款。
  - `occupancyReport`：2 晚的訂單在對應的 2 天各算 1 間夜。
  - 查詢區間 400 天 → 回傳 400 錯誤。
  - marketing 角色呼叫 → 403。
- [ ] **Step 2:** 執行 `npx vitest run tests/admin/reports.test.ts tests/admin/csv.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作，報表頁用表格加上簡單的長條圖（純 CSS 即可）。
- [ ] **Step 4:** 執行 `npx vitest run`，預期 PASS。
- [ ] **Step 5:** Commit：`feat(admin): revenue, occupancy, bookings and cancellation reports with CSV export`

---

### Task 11: 員工帳號、操作紀錄檢視、系統狀態、Access 設定文件

**Files:**
- Create: `lib/admin/staff.ts`、`lib/admin/audit-view.ts`、`lib/admin/system-status.ts`、`app/admin/staff/page.tsx`、`app/admin/audit/page.tsx`、`app/admin/system/page.tsx`、`app/api/admin/staff/*`、`scripts/create-owner.ts`
- Modify: `docs/DEPLOY.md`（新增「Cloudflare Access 設定」和「建立第一位 owner」兩節）
- Test: `tests/admin/staff.test.ts`、`tests/admin/audit-view.test.ts`、`tests/admin/system-status.test.ts`

**Interfaces:**
- Produces:
  - `createStaff`、`updateStaff`、`deactivateStaff`（需要 `staff.manage` 權限）
    - email 轉小寫並唯一；`role` 是 enum 之一。
    - `propertyIds` 不能是空陣列，而且只能包含操作者自己可管理的館別。
    - 不可以停用自己，也不可以把自己降級。系統中至少要保留一位 active 的 owner，最後一位 owner 不能被停用或降級。
    - 全部都寫 audit。
  - `listAudit(db, propertyScope: string[], { q?, staffEmail?, entity?, from?, to?, page, pageSize })`：依時間由新到舊排序。before 和 after 用並排的 diff 顯示。
  - `getSystemStatus(db, env)`：顯示以下項目，**不顯示任何秘密值**：
    - PAYMENT_MODE、CHANNEL_MODE、ENVIRONMENT
    - BASE_URL 和 Access 是否已設定
    - 上次排程執行的時間（cron 每次執行要寫入一張新表 `job_runs(name, startedAt, finishedAt, result)`，並產生 migration）
    - 各個 syncState 的筆數
    - 最近 24 小時的 paymentEvents verdict 統計
    - migration 版本
  - `scripts/create-owner.ts <email> <name>`：只能寫入**本機** D1。DEPLOY.md 另外附上遠端執行的 `wrangler d1 execute --remote` SQL 範本，由業主自己執行。
  - DEPLOY.md 要寫清楚的步驟：
    - 在 Cloudflare Zero Trust 建立 Access application，保護 `/admin*` 和 `/api/admin*`。
    - 設定允許的 Email 或 Google Workspace 網域。
    - 要求 owner 和 manager 開啟兩步驟驗證（Access policy 的 require MFA）。
    - 把 aud tag 填進 `CF_ACCESS_AUD`，team domain 填進 `CF_ACCESS_TEAM_DOMAIN`。

- [ ] **Step 1: 寫失敗的測試。**
  - manager 建立員工 → 403。
  - owner 把唯一的 owner（自己）降級 → 拒絕。
  - owner 建立員工時，指定了自己沒有的館別 → 拒絕。
  - 用大寫的 email 建立員工 → 存成小寫，重複時回傳衝突。
  - `listAudit` 不會回傳範圍外館別的紀錄。若 audit 屬於員工這類跨館別的實體，只有 owner 看得到。
  - `getSystemStatus` 的輸出裡沒有任何 `SECRET`、`KEY` 或 `TOKEN` 的值。
  - cron 執行後，`job_runs` 會多一筆紀錄。
- [ ] **Step 2:** 執行 `npx vitest run tests/admin/staff.test.ts tests/admin/audit-view.test.ts tests/admin/system-status.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作，執行 `npm run db:generate` 和 `npm run db:migrate:local`，並更新 DEPLOY.md。
- [ ] **Step 4:** 執行 `npx vitest run` 和 `npx tsc --noEmit`，再執行 `npx opennextjs-cloudflare build`，都要成功。
- [ ] **Step 5: 端對端檢查。** 用 `npm run preview`，用 owner 身分登入，依序操作：
  1. 新增一位 front_desk 員工
  2. 切換成那位員工
  3. 登錄一筆刷卡機收款
  4. 嘗試自訂退款金額，確認被擋下
  5. 切回 owner，執行員工取消
  6. 到 `/admin/audit` 確認以上每個動作都有紀錄
  7. 到 `/admin/system` 確認顯示正確

  結果寫進報告。
- [ ] **Step 6:** Commit：`feat(admin): staff management, audit viewer, system status, Access setup guide`
