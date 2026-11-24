# Plan 2 — 官網、直訂流程與永豐金流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成四語系的品牌官網，以及從查詢、選房、付款到確認信的完整直訂流程。旅客要能自己查詢和取消訂單（依規則自動退款）。訂單回推到 SiteMinder 時有自動重試，回推失敗就自動退款。金流和 SiteMinder 都先用模擬器實作，介面和正式版一致。

**Architecture:**
- 訂房相關的規則集中在 `lib/booking/*` 的 service 函式。這些函式只接收 `Db`、`ChannelManager`、`PaymentGateway`、`EmailSender` 四個介面和 `now`，不碰平台 API，所以可以在 better-sqlite3 上完整測試。
- 訂單狀態的轉換只能透過 `lib/booking/state.ts`。
- 頁面用 next-intl 的 `[locale]` 路由。資料都由 Server Components 從 D1 讀取，只有日期選擇、表單這些互動元件是 Client Components。
- 背景工作（訂單回推重試、逾時未付款的釋放）由 Cloudflare Cron Trigger 呼叫 `lib/jobs/*`。

**Tech Stack:** 沿用 Plan 1，另外加上：
- next-intl（四語系）
- react-day-picker（日期選擇）
- Resend REST API（寄信，直接用 `fetch` 呼叫，不裝 SDK）
- Cloudflare R2（照片）
- OpenNext 自訂 worker（cron）

**Spec:** `docs/superpowers/specs/2026-11-24-nk-hostel-direct-booking-design.md`

**不在本計畫：** 永豐正式金流 adapter（要等業主拿到永豐的技術文件和測試商店代號，排在 Plan 4，介面就是本計畫的 `PaymentGateway`）；櫃檯刷卡機登錄（Plan 3）。

**承接 Plan 1：** 程式碼已經在 `main`，相關介面有：
- `searchAvailability`、`quote`、`refundAmount`、`holdInventory` / `releaseInventory`（以房型計庫存）
- `ChannelManager` / `MockChannelManager`、`applyAriUpdates`、`runAtomic`、`Db`
- `handleAvailability(db, url, today?)`、`seedNk`

## Global Constraints

- 所有面向旅客的頁面和文字都要有 `zh-TW`、`en`、`ja`、`ko` 四種語言。預設語言是 `zh-TW`，網址前綴是 `/zh-TW`、`/en`、`/ja`、`/ko`，根目錄 `/` 依 Accept-Language 轉址。
- 每一頁都要有 hreflang（四種語言加 `x-default`）、canonical、OG 圖片。
- 金額只能由 `quote()` 算出來。付款回呼中的金額必須**等於**訂單的 `payNow`，不一致就拒絕並記錄下來。
- 卡號不進我們的伺服器。付款一律跳轉到金流方的頁面，我們只記錄 `providerRef`、`authCode`、`last4`。
- 付款結果以**伺服器端的回呼**（notify）為準。旅客瀏覽器跳轉回來的頁面只能「查詢狀態」，不可以改變訂單狀態。
- 訂單一旦付款成功就要回推 SiteMinder。可重試的失敗由排程每 5 分鐘重試一次，最多 6 次。不可重試的失敗（例如已售完），或重試用完，就全額退款，並寄道歉信。
- 已鎖定但未付款的庫存，**20 分鐘**後釋放，訂單狀態改為 `expired`。
- 取消：旅客線上取消時，依房價方案的 `cancelPolicy` 自動退款，不需要員工審核。改日期不開放線上自助，只顯示館方的聯絡方式。
- 品質：Lighthouse（手機）效能 ≥ 90、無障礙 ≥ 95、SEO = 100。圖片用 AVIF 或 WebP，並設定寬高，避免版面跳動。
- 文案：zh-TW 和 en 取自舊站（https://www.nkhostel.com），ja 和 ko 先用機器翻譯。機器翻譯的每一筆 key 都要列在 `messages/_review.md`，等人工校稿。

## Review Focus

1. **金流回呼被重送或重放**（同一個 providerRef 收到兩次）→ 第二次不能重複推 SiteMinder、重複寄信或重複記帳，只回應 200。測試寫在 Task 5。
2. **回呼的簽章不對、金額不符、或訂單已經逾時（expired）才付款成功** → 簽章錯就回 400 並記錄；金額不符就不確認訂單、全額退款、寫入警示；逾時後才付成功的，要先試著重新鎖定庫存，鎖得到就照常確認，鎖不到就自動退款。測試寫在 Task 5。
3. **旅客重複按「確認付款」**（同一個 idempotency key 送出兩次）→ 只建立一筆訂單、只鎖一次庫存，第二次回傳同一筆訂單代碼。測試寫在 Task 4。
4. **入住當天或之後才取消、重複取消、或用錯誤的 Email 查詢** → 退款金額依規則算（可能是 0），訂單照樣取消並回推 SiteMinder；重複取消回傳原本的結果，不會重複退款；Email 不符就回傳「找不到訂單」（不透露訂單是否存在）。測試寫在 Task 6。
5. **某個語言缺少翻譯的 key** → 建置時就要失敗（測試檢查四種語言的 key 集合完全相同），不可以在上線後才在頁面上顯示 key 名稱。測試寫在 Task 7。

---

### Task 1: 視覺方向提案（★業主決策點）

**Files:**
- Create: `design/proposals/index.html`、`design/proposals/a.html`、`design/proposals/b.html`、`design/proposals/c.html`（純靜態檔，不進 app）

**Interfaces:**
- Produces: `design/tokens.md`，記錄業主選定的方向：色票（CSS 變數名稱 `--color-ink`、`--color-paper`、`--color-accent`、`--color-muted`、`--color-line`）、字體（中文和英文的標題字體與內文字體，必須是 Google Fonts，並包含日文和韓文字體）、間距尺度、圓角、動效原則。Task 7 會照這份文件實作。

- [ ] **Step 1:** 載入 `frontend-design` skill。依照舊站的品牌語氣（「旅行是生活的延伸」、「家」、溫度、台北一隅）做 **3 個方向**，每個方向都要有首頁首屏、房型卡、訂房列的桌機版和手機版：
  - **A. 溫潤人文**：米白底、木質暖色、襯線字。
  - **B. 都會極簡**：大量留白、黑白搭配單一強調色。
  - **C. 台北記憶**：底片質感的照片、復古綠和磚紅。

  圖片用舊站的照片（`https://www.nkhostel.com/upload_image/rooms/*`、`images/index-fancy.jpg`）。
- [ ] **Step 2:** 用 Artifact 發布 `design/proposals/index.html`（三個方向並排比較），把連結給使用者。**停下來等業主選擇**（這是 spec 5.5 規定的業主決策，屬於 executing-plans 允許停止的情況）。
- [ ] **Step 3:** 依照業主的選擇（或混搭的指示）寫好 `design/tokens.md`。
- [ ] **Step 4:** Commit：`design: visual direction proposals and chosen tokens`

---

### Task 2: Schema 補充（訂單逾時、idempotency、回推重試、通知紀錄）

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `drizzle/migrations/0003_*.sql`（產生出來的）
- Test: `tests/db/schema-plan2.test.ts`

**Interfaces:**
- Produces（新增或修改的欄位）：
  - `reservations.status` 的 enum 加上 `"expired"`。
  - `reservations` 新增欄位：
    - `holdExpiresAt: integer`（epoch ms；null 表示沒有鎖庫存）
    - `idempotencyKey: text`（唯一）
    - `syncAttempts: integer`（預設 0）
    - `nextSyncAt: integer?`
    - `lastSyncError: text?`
    - `cancelledAt: integer?`
    - `refundedAmount: integer`（預設 0）
    - `guestEmailLower: text`（查詢用，加索引）
  - `payments.providerRef` 加唯一索引（允許 null）。
  - 新表 `paymentEvents`：`id, provider, providerRef?, reservationCode?, rawBody, verdict("accepted"|"duplicate"|"bad_signature"|"amount_mismatch"|"unknown_reservation"), at`。這是金流回呼的完整紀錄，用來稽核和對帳。
  - 匯出型別 `PaymentEventVerdict = typeof paymentEvents.$inferSelect["verdict"]`、`NotificationKind = typeof notifications.$inferSelect["kind"]`（Task 3、5 使用）。
  - 新表 `notifications`：`id, reservationId, kind("booking_confirmed"|"booking_failed_refunded"|"cancelled"|"pre_arrival"|"staff_new_booking"|"staff_sync_failed"|"staff_payment_alert"), to, status("sent"|"failed"), providerId?, at`，加上 `(reservationId, kind, to)` 唯一索引，同一封信不會寄兩次。

- [ ] **Step 1:** 寫失敗的測試：
  - 插入兩筆 `idempotencyKey` 相同的 reservation，第二筆會丟出 UNIQUE 錯誤。
  - `reservations.status` 可以寫入 `expired`。
  - `notifications` 插入同一組 `(reservationId, kind, to)` 兩次，第二次會丟出錯誤。
  - `payments` 有兩筆 `providerRef` 為 null 是允許的。
- [ ] **Step 2:** 執行 `npx vitest run tests/db/schema-plan2.test.ts`，預期 FAIL。
- [ ] **Step 3:** 修改 schema，執行 `npm run db:generate`。
- [ ] **Step 4:** 執行 `npx vitest run`，預期全部 PASS；再執行 `npm run db:migrate:local`，確認成功套用。
- [ ] **Step 5:** Commit：`feat(db): reservation lifecycle fields, payment events, notifications`

---

### Task 3: PaymentGateway 介面、永豐模擬器、EmailSender

**Files:**
- Create: `lib/payments/types.ts`、`lib/payments/mock-sinopac.ts`、`lib/email/types.ts`、`lib/email/mock.ts`、`lib/email/resend.ts`、`lib/email/templates.ts`、`app/[locale]/dev/pay/[ref]/page.tsx`（模擬付款頁，只有 `env.PAYMENT_MODE === "mock"` 時才會顯示，其他情況回 404）
- Test: `tests/payments/mock-sinopac.test.ts`、`tests/email/templates.test.ts`

**Interfaces:**
- Produces:
  - `type ChargeRequest = { reservationCode: string; amount: number; locale: Locale; returnUrl: string; notifyUrl: string; description: string }`
  - `type ChargeStart = { kind: "redirect"; url: string } | { kind: "form_post"; action: string; fields: Record<string, string> }`
  - `type PaymentNotice = { reservationCode: string; providerRef: string; amount: number; status: "succeeded" | "failed"; authCode?: string; last4?: string }`
  - `interface PaymentGateway { readonly provider: "sinopac" | "mock"; readonly supportsPreauth: boolean; startCharge(r: ChargeRequest): Promise<ChargeStart>; verifyNotice(req: { headers: Record<string, string>; body: string }): Promise<{ ok: true; notice: PaymentNotice } | { ok: false; error: "BAD_SIGNATURE" | "MALFORMED" }>; refund(r: { providerRef: string; amount: number; reason: string }): Promise<{ ok: true; refundRef: string } | { ok: false; error: string }> }`
  - `class MockSinoPacGateway implements PaymentGateway`：建構子參數 `{ secret: string; baseUrl: string; failRefund?: boolean }`。用 HMAC-SHA256(secret, body) 簽章，簽章放在 `x-mock-signature` header。`startCharge` 回傳 redirect 到 `/{locale}/dev/pay/{ref}?code=&amount=`。另外提供 `signedNotice(notice): { headers; body }` 給測試和模擬付款頁使用。`supportsPreauth = false`。
  - `type Email = { to: string; subject: string; html: string; text: string; replyTo?: string }`
  - `interface EmailSender { send(e: Email): Promise<{ ok: true; id: string } | { ok: false; error: string }> }`
  - `class MockEmailSender implements EmailSender`，用 `sent: Email[]` 記錄寄出的信。
  - `class ResendEmailSender implements EmailSender`：建構子參數 `{ apiKey: string; from: string }`，用 `fetch("https://api.resend.com/emails")` 寄信。
  - `renderEmail(kind: NotificationKind, locale: Locale, data: EmailData): { subject: string; html: string; text: string }`。`EmailData` 包含：館名、訂單代碼、入住和退房日期、房型名稱、間數、晚數、quote 明細、已付金額、取消規則的文字、館方電話、Email、地址、管理訂單的網址、退款金額（選填）。

- [ ] **Step 1:** 寫失敗的測試：
  - `signedNotice` 產生的通知，可以通過 `verifyNotice`，回傳 `ok: true`。
  - 竄改 body 裡的 amount 後，回傳 `BAD_SIGNATURE`。
  - body 不是 JSON 時，回傳 `MALFORMED`。
  - `renderEmail("booking_confirmed", "ja", data)` 的 subject 包含訂單代碼，html 包含 `data.total` 的格式化金額（`NT$4,960`）。
  - 四種語言的 subject 都不是空字串，而且彼此都不相同。
- [ ] **Step 2:** 執行 `npx vitest run tests/payments tests/email`，預期 FAIL。
- [ ] **Step 3:** 實作上面的介面。HMAC 用 Web Crypto（`crypto.subtle`），Workers 和 Node 都能跑。信件模板用純函式加上 template string，內容用 inline style，並附上純文字版本。
- [ ] **Step 4:** 執行 `npx vitest run tests/payments tests/email`，預期 PASS。
- [ ] **Step 5:** Commit：`feat(payments,email): gateway contract, SinoPac mock, email sender and templates`

---

### Task 4: 建立訂單（重新報價、鎖庫存、idempotency、開始付款）

**Files:**
- Create: `lib/booking/state.ts`、`lib/booking/create.ts`、`lib/booking/code.ts`
- Test: `tests/booking/state.test.ts`、`tests/booking/create.test.ts`

**Interfaces:**
- Consumes: `searchAvailability`、`quote`、`holdInventory`（Plan 1）、`PaymentGateway`（Task 3）、Task 2 的欄位
- Produces:
  - `type ResStatus = typeof reservations.$inferSelect["status"]`
  - `canTransition(from: ResStatus, to: ResStatus): boolean`。允許的轉換：
    - `pending_payment` → `paid_pending_confirm`、`expired`
    - `expired` → `paid_pending_confirm`（逾時後才付款成功，而且重新鎖到庫存）、`confirm_failed_refunded`
    - `paid_pending_confirm` → `confirmed`、`confirm_failed_refunded`
    - `confirmed` → `cancelled`
  - `transition(db, reservationId: string, from: ResStatus, to: ResStatus, patch: Partial<Reservation>, now: Date): Promise<boolean>`：用條件式 UPDATE（`WHERE id=? AND status=from`）做樂觀鎖。如果影響 0 列（狀態已經被別人改了）就回傳 false。
  - `newReservationCode(): string`：格式 `NK-` 加 6 碼，字元集是 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`。
  - `type CreateInput = { propertySlug: string; checkIn: string; checkOut: string; adults: number; children: number; rooms: number; unitTypeSlug: string; ratePlanSlug: string; addons: { slug: string; qty: number }[]; promoCode?: string; guest: { firstName: string; lastName: string; email: string; phone: string; country: string }; locale: Locale; idempotencyKey: string; acceptTerms: true }`
  - `createReservation(deps: { db: Db; gateway: PaymentGateway; baseUrl: string }, input: CreateInput, now: Date): Promise<{ ok: true; code: string; start: ChargeStart } | { ok: false; error: "INVALID_INPUT" | "NOT_AVAILABLE" | "PRICE_CHANGED" | "PROMO_INVALID" | "SOLD_OUT"; detail?: string }>`
    - 處理順序：
      1. 用 zod 驗證輸入（rooms ≤ adults，children 是 0 到 6）。
      2. 用 idempotencyKey 查有沒有已存在的訂單。有的話，如果還是 `pending_payment`，就用同一筆訂單重新 `startCharge` 回傳。
      3. 呼叫 `searchAvailability` 找出指定的房型和方案，找不到就回傳 `NOT_AVAILABLE`。
      4. 驗證折扣碼：必須是 active、在有效期間內、未超過使用次數，否則回傳 `PROMO_INVALID`。
      5. 讀取加購項目的價格，呼叫 `quote()`。
      6. 呼叫 `holdInventory`，失敗就回傳 `SOLD_OUT`。
      7. 用 `runAtomic` 一次寫入 guest、reservation（`pending_payment`、`holdExpiresAt = now + 20 分鐘`、`syncState = "not_required"`）、reservation_rooms、payment（`kind="charge"`、`status="pending"`）。如果這一步失敗，就 `releaseInventory` 之後把錯誤丟出去。
      8. 呼叫 `gateway.startCharge`，`notifyUrl` 是 `${baseUrl}/api/payments/notify`，`returnUrl` 是 `${baseUrl}/${locale}/book/return/${code}`。
    - `PRICE_CHANGED` 留給 Plan 4（SiteMinder 報價和本地快取不一致時使用）。Plan 2 不會回傳這個錯誤。
- 同時修掉 Plan 1 延後處理的小問題：`holdInventory` 和 `releaseInventory` 遇到 `rooms` 不是正整數、或 nights 有重複時，要丟出 `Error("INVALID_HOLD")`。

- [ ] **Step 1:** 寫失敗的測試（state）：
  - `canTransition("confirmed", "pending_payment")` 是 false。
  - 兩個 transition 同時把 `pending_payment` 改成 `paid_pending_confirm`，只有一個回傳 true。
- [ ] **Step 2:** 寫失敗的測試（create，用 createTestDb + seedNk + fillAri + MockSinoPacGateway，`now` 固定為 `2026-11-24T02:00:00Z`）：
  - 正常建立：回傳 `ok`；code 符合 `/^NK-[2-9A-HJ-NP-Z]{6}$/`；reservation 狀態是 `pending_payment`；totalAmount 等於 `quote().total`；該房型的庫存少 1；`start.kind` 是 `"redirect"`。
  - 同一個 idempotencyKey 呼叫兩次：回傳同一個 code，庫存只少 1，reservations 只有 1 筆。
  - 折扣碼 `WELCOME10`（percent 10、active）的 totalAmount 等於房費 × 0.9；過期的折扣碼回傳 `PROMO_INVALID`，**而且庫存沒有變動**。
  - rooms=3、adults=1，回傳 `INVALID_INPUT`。
  - 庫存只剩 1 間時，兩筆不同 key 的訂單依序建立：第一筆 ok，第二筆回傳 `NOT_AVAILABLE` 或 `SOLD_OUT`。
  - 呼叫 `holdInventory` 時 `rooms=0`，會丟出 `INVALID_HOLD`。
- [ ] **Step 3:** 執行 `npx vitest run tests/booking`，預期 FAIL。
- [ ] **Step 4:** 實作上面的介面。
- [ ] **Step 5:** 執行 `npx vitest run`，預期全部 PASS。
- [ ] **Step 6:** Commit：`feat(booking): reservation state machine and idempotent creation with inventory hold`

---

### Task 5: 付款通知處理、回推 SiteMinder、失敗自動退款、排程任務

**Files:**
- Create: `lib/booking/payment-notice.ts`、`lib/booking/confirm.ts`、`lib/booking/notify.ts`、`lib/jobs/sync-retry.ts`、`lib/jobs/expire-holds.ts`、`lib/booking/to-channel.ts`
- Test: `tests/booking/payment-notice.test.ts`、`tests/jobs/sync-retry.test.ts`、`tests/jobs/expire-holds.test.ts`

**Interfaces:**
- Consumes: Task 2、3、4；`ChannelManager`、`MockChannelManager`（Plan 1）
- Produces:
  - `type Deps = { db: Db; gateway: PaymentGateway; channel: ChannelManager; email: EmailSender; staffEmails: string[]; baseUrl: string }`
  - `handlePaymentNotice(deps: Deps, req: { headers: Record<string, string>; body: string }, now: Date): Promise<{ status: 200 | 400; verdict: PaymentEventVerdict }>`
    - 處理順序：
      1. 呼叫 `verifyNotice`，簽章錯誤就記 `bad_signature`，回傳 400。
      2. 找訂單，找不到就記 `unknown_reservation`，回傳 200（避免金流方一直重送）。
      3. 用 providerRef 查是否已經處理過，處理過就記 `duplicate`，回傳 200。
      4. 如果付款失敗：把 payment 標成 failed，保持 `pending_payment`，讓旅客可以重付。
      5. 如果金額不等於 payNow：記 `amount_mismatch`，全額退款，狀態改成 `confirm_failed_refunded`，寄 `staff_payment_alert`。
      6. 如果訂單已經是 `expired`：重新 `holdInventory`，失敗就自動退款。
      7. 把狀態轉成 `paid_pending_confirm`，記錄 payment 成功，然後呼叫 `confirmWithChannel`。
  - `confirmWithChannel(deps: Deps, reservationId: string, now: Date): Promise<void>`
    - `pushReservation` 成功：狀態轉 `confirmed`，`syncState="synced"`，記下 smConfirmation，寄 `booking_confirmed` 給旅客、`staff_new_booking` 給館方。
    - 可重試的失敗：`syncState="pending"`，`syncAttempts+1`，`nextSyncAt = now + 5 分鐘`，記下 lastSyncError。
    - 不可重試的失敗，或 syncAttempts 已達 6 次：全額退款，`releaseInventory`，狀態轉 `confirm_failed_refunded`，`syncState="failed"`，寄 `booking_failed_refunded` 給旅客、`staff_sync_failed` 給館方。
  - `sendOnce(deps: Deps, reservationId: string, kind: NotificationKind, to: string, email: Email, now: Date): Promise<void>`：先寫入 `notifications` 表（唯一索引擋掉重複），寫入成功才真的寄。
  - `toChannelReservation(db, reservationId): Promise<ChannelReservation>`：quote 的明細要轉成 `addons` 和 `promoCode`，`paidAmount` 等於成功收款的總和（spec 5.8：加購和預付金額要讓靈知看得到）。
  - `runSyncRetry(deps: Deps, now: Date): Promise<{ attempted: number }>`：找出 `syncState="pending"` 且 `nextSyncAt <= now` 的訂單，每次最多處理 20 筆，逐筆呼叫 `confirmWithChannel`。
  - `runExpireHolds(deps: Pick<Deps, "db">, now: Date): Promise<{ expired: number }>`：找出 `pending_payment` 且 `holdExpiresAt < now` 的訂單，轉成 `expired` 並 `releaseInventory`。

- [ ] **Step 1:** 寫失敗的測試（每一項都用 Task 4 建好的訂單，加上 `MockSinoPacGateway.signedNotice`）：
  - 付款成功：狀態依序轉成 `paid_pending_confirm`，再到 `confirmed`；`channel.pushed` 有 1 筆，而且 `paidAmount` 等於 payNow；`email.sent` 有 2 封（旅客和館方）。
  - 同一個通知送兩次：第二次 verdict 是 `duplicate`，`channel.pushed` 還是 1 筆，`email.sent` 還是 2 封。
  - 竄改簽章：status 400，verdict 是 `bad_signature`，訂單仍是 `pending_payment`。
  - 金額比 payNow 少 1 元：verdict 是 `amount_mismatch`；狀態是 `confirm_failed_refunded`；gateway 收到全額退款；館方收到警示信。
  - `MockChannelManager({ failNext: 1, retryable: true })`：付款後 `syncState` 是 `pending`；`now + 5 分鐘`執行 `runSyncRetry` 後變成 `confirmed`。
  - `MockChannelManager({ failNext: 1, retryable: false })`：直接變成 `confirm_failed_refunded`；退款金額等於 payNow；庫存恢復；旅客收到道歉信。
  - 可重試的失敗連續 7 次（`failNext: 7`）：第 6 次重試之後變成 `confirm_failed_refunded`。
  - 建單後 21 分鐘執行 `runExpireHolds`：狀態是 `expired`，庫存恢復。這時才收到付款成功通知：如果庫存還在，就變成 `confirmed`；如果庫存在這之前被別人訂走（另一筆訂單把庫存訂到 0），就自動退款並變成 `confirm_failed_refunded`。
- [ ] **Step 2:** 執行 `npx vitest run tests/booking/payment-notice.test.ts tests/jobs`，預期 FAIL。
- [ ] **Step 3:** 實作上面的介面。每一次狀態轉換都要用 `transition()`，轉換失敗（回傳 false）就停止，不再做後面的副作用。
- [ ] **Step 4:** 執行 `npx vitest run`，預期全部 PASS。
- [ ] **Step 5:** Commit：`feat(booking): payment notice handling, SiteMinder confirm with retry, auto-refund, hold expiry`

---

### Task 6: 旅客自助查詢和取消訂單

**Files:**
- Create: `lib/booking/manage.ts`
- Test: `tests/booking/manage.test.ts`

**Interfaces:**
- Consumes: `refundAmount`（Plan 1）、`transition`、`sendOnce`、`Deps`（Task 5）
- Produces:
  - `findReservation(db, code: string, email: string): Promise<ReservationView | null>`：code 不分大小寫，email 用 `guestEmailLower` 比對；兩者都要符合才回傳。`ReservationView` 包含：code、status、入住和退房日期、房型名稱（四語）、方案名稱、quote、已付金額、已退金額、`refundIfCancelledNow`（整數）、`canCancel`（boolean）。
  - `cancelReservation(deps: Deps, code: string, email: string, now: Date): Promise<{ ok: true; refunded: number; alreadyCancelled: boolean } | { ok: false; error: "NOT_FOUND" | "NOT_CANCELLABLE" | "REFUND_FAILED" }>`
    - 只有 `confirmed` 狀態的訂單可以取消；已經是 `cancelled` 的，回傳 `{ ok: true, alreadyCancelled: true, refunded: <原本退的金額> }`。
    - 處理順序：
      1. 用 `refundAmount(policy, paid, checkIn, now)` 算出退款金額。
      2. 如果退款金額大於 0，呼叫 `gateway.refund`。失敗就回傳 `REFUND_FAILED`，訂單保持 `confirmed`，並寄 `staff_payment_alert`。
      3. 狀態轉 `cancelled`，記錄 refundedAmount 和 cancelledAt，新增一筆 payment（`kind="refund"`）。
      4. 呼叫 `channel.cancelReservation`。可重試的失敗就設 `syncState="pending"`，交給 `runSyncRetry`（Task 5）處理 cancel 的重試：`runSyncRetry` 遇到 `status="cancelled"` 的訂單，要呼叫 `cancelReservation`，不是 `pushReservation`。
      5. `releaseInventory`。
      6. 寄 `cancelled` 通知給旅客和館方。

- [ ] **Step 1:** 寫失敗的測試（入住日 2026-12-10，已付 4960，使用種子的取消規則）：
  - 在 `2026-12-06T16:00:00Z` 取消：退 4960，狀態是 `cancelled`，channel 沒有這筆訂單，庫存恢復，旅客收到取消信。
  - 在 `2026-12-09T16:00:00Z` 取消：退 0，訂單仍然取消，並回推 SiteMinder。
  - 同一筆訂單取消兩次：第二次回傳 `alreadyCancelled: true`，gateway 只收到 1 次退款。
  - 用錯的 Email 查詢和取消：都回傳 null 或 `NOT_FOUND`。
  - 用 `MockSinoPacGateway({ failRefund: true })` 取消：回傳 `REFUND_FAILED`，狀態仍是 `confirmed`，館方收到警示。
  - channel cancel 可重試失敗：`syncState` 是 `pending`；執行 `runSyncRetry` 之後變成 `synced`。
- [ ] **Step 2:** 執行 `npx vitest run tests/booking/manage.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作，並修改 `runSyncRetry` 讓它能處理 cancel 的重試。
- [ ] **Step 4:** 執行 `npx vitest run`，預期全部 PASS。
- [ ] **Step 5:** Commit：`feat(booking): guest self-service lookup and cancellation with automatic refund`

---

### Task 7: 四語系框架、版型、設計 tokens、內容移轉

**Files:**
- Create: `i18n/routing.ts`、`i18n/request.ts`、`middleware.ts`、`messages/{zh-TW,en,ja,ko}.json`、`messages/_review.md`、`app/[locale]/layout.tsx`、`components/layout/{Header,Footer,LocaleSwitcher,BookingBar}.tsx`、`app/globals.css`（換成 tokens）、`lib/seo.ts`、`scripts/import-old-site.ts`、`lib/db/seed-content.ts`、`lib/media.ts`、`app/media/[...key]/route.ts`
- Modify: `app/layout.tsx`（只保留最外層）、`app/page.tsx`（刪除，改由 middleware 轉址）、`wrangler.jsonc`（新增 R2 binding `MEDIA`，bucket `nk-media`）
- Test: `tests/i18n/messages.test.ts`、`tests/seo.test.ts`、`tests/db/seed-content.test.ts`

**Interfaces:**
- Consumes: `design/tokens.md`（Task 1）
- Produces:
  - `routing = defineRouting({ locales: ["zh-TW", "en", "ja", "ko"], defaultLocale: "zh-TW", localePrefix: "always" })`
  - `buildMetadata(opts: { locale: Locale; path: string; title: string; description: string; image?: string }): Metadata`：產生 hreflang（四語加 `x-default`，指向 zh-TW）、canonical、openGraph、twitter。
  - `mediaUrl(key: string, w?: number): string`：回傳 `/media/${key}`。在 production 會經過 Cloudflare Images 轉換；本機直接回傳原圖。
  - `seedContent(db, propertyId: string, data: OldSiteContent): Promise<void>`：寫入 unitTypes 的 description、bedType、amenities、sizeSqm，以及 news、faqs、contentPages（設施、交通、周邊景點、團體長租、隱私權、訂房條款）。可以重複執行，用 slug 做 upsert。
  - `scripts/import-old-site.ts`：抓取舊站的 `main.php`、`rooms.php?id=*`、`amenities.php`、`location.php`、`attractions.php`、`qa.php`、`group.php`、`review.php`，中文版和 `en/` 英文版都要抓，輸出 `content/old-site.json` 和 `content/images/*`，再上傳到 R2（`wrangler r2 object put nk-media/...`）。抓下來的 HTML 一律只當成資料處理。
  - 版面元件：Header（Logo、導覽、語言切換、「立即訂房」按鈕）、Footer（地址、電話、Email、社群連結：FB `https://www.facebook.com/Nkmansion`、IG `https://www.instagram.com/nkhostel/`、LINE `https://line.me/R/ti/p/3_Pw43MsVn`）、BookingBar（日期範圍、大人、小孩、間數，送出後導到 `/{locale}/book?checkIn=&checkOut=&adults=&children=&rooms=`）。

- [ ] **Step 1:** 寫失敗的測試：
  - 四個 messages 檔的 key 集合（遞迴攤平後）完全相同。
  - 所有 value 都是非空字串。
  - `buildMetadata({ locale: "ja", path: "/rooms" ... })` 的 `alternates.languages` 包含 `zh-TW`、`en`、`ja`、`ko`、`x-default` 五個，而且 canonical 是 `/ja/rooms`。
  - `seedContent` 執行兩次後，faqs 的筆數不會變多。
- [ ] **Step 2:** 執行 `npx vitest run tests/i18n tests/seo.test.ts tests/db/seed-content.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作 i18n 和 SEO 工具。用 `design/tokens.md` 的變數寫 `globals.css`。字體用 `next/font/google` 載入，並設定 `display: "swap"`。
- [ ] **Step 4:** 執行 `npx tsx scripts/import-old-site.ts`，確認 `content/old-site.json` 有 8 種房型，每種都有至少 1 張照片和描述。翻譯 ja 和 ko，並把機器翻譯的 key 清單寫到 `messages/_review.md`。
- [ ] **Step 5:** 執行 `npx vitest run`，預期全部 PASS。執行 `npm run preview`，打開 `/` 會轉址到 `/zh-TW`（或依瀏覽器語言轉到其他語言），四種語言的 Header 和 Footer 都正確顯示。
- [ ] **Step 6:** Commit：`feat(site): i18n routing, layout, design tokens, SEO helpers, old-site content import`

---

### Task 8: 品牌官網內容頁

**Files:**
- Create: `app/[locale]/page.tsx`（首頁）、`app/[locale]/rooms/page.tsx`、`app/[locale]/rooms/[slug]/page.tsx`、`app/[locale]/facilities/page.tsx`、`app/[locale]/location/page.tsx`、`app/[locale]/attractions/page.tsx`、`app/[locale]/news/page.tsx`、`app/[locale]/news/[slug]/page.tsx`、`app/[locale]/faq/page.tsx`、`app/[locale]/reviews/page.tsx`、`app/[locale]/groups/page.tsx`（洽詢表單）、`app/[locale]/privacy/page.tsx`、`app/[locale]/terms/page.tsx`、`app/sitemap.ts`、`app/robots.ts`、`lib/content-repo.ts`、`app/api/inquiry/route.ts`、`lib/inquiry.ts`、`lib/jsonld.ts`
- Test: `tests/content-repo.test.ts`、`tests/inquiry.test.ts`、`tests/jsonld.test.ts`

**Interfaces:**
- Consumes: `seedContent` 寫入的資料、`buildMetadata`、`mediaUrl`、`handleAvailability`（Plan 1）
- Produces:
  - `getRoomTypes(db, propertySlug, locale): Promise<RoomCard[]>`，`getRoomType(db, propertySlug, slug, locale): Promise<RoomDetail | null>`，`getPage(db, propertySlug, slug, locale)`，`listNews(...)`，`getNews(...)`，`listFaqs(...)`。找不到時用 `notFound()`。
  - `hotelJsonLd(property, locale): object`：schema.org 的 `Hotel`，包含名稱、地址（PostalAddress）、電話、geo（25.051499, 121.569652）、url、image、checkinTime、checkoutTime、amenityFeature。`roomJsonLd(room, locale): object`：`HotelRoom` 加上 `Offer`（價格來自未來 7 天的最低價，沒有資料就不輸出 offers）。
  - `submitInquiry(deps: { db; email: EmailSender; staffEmails: string[] }, input: { name; email; phone; groupSize: number; checkIn; checkOut; message; locale; honeypot: string }, now: Date)`：honeypot 有值就靜默丟棄並回傳 ok；否則寄信給館方，回覆地址設成旅客的 Email。用 zod 驗證，`groupSize` 是 1 到 200。
  - sitemap：每種語言 × 每個公開頁面 × 每個房型和消息，都要有 `alternates.languages`。
  - 頁面規格：
    - 首頁：首屏大圖、品牌故事、房型精選、設施、評價摘要、位置、訂房列。
    - 房型頁：相簿（lightbox）、可住人數、床型、坪數、設施清單，以及「查看日期和價格」按鈕，帶入房型參數導到訂房頁。
    - 所有頁面：BookingBar 固定在畫面上（手機版在底部）。

- [ ] **Step 1:** 寫失敗的測試：
  - `getRoomType(db, "nk-hostel", "deluxe-room", "en")` 回傳英文名稱 `DELUXE ROOM`；找不到的 slug 回傳 null。
  - `hotelJsonLd` 包含 `@type: "Hotel"`，而且 `address.streetAddress` 不是空字串。
  - `roomJsonLd` 在沒有 ARI 資料時，沒有 `offers` 欄位。
  - `submitInquiry` 在 honeypot 有值時，回傳 ok 但不寄信；正常送出時寄 1 封給館方，而且 `replyTo` 是旅客的 Email；groupSize 為 0 時回傳驗證錯誤。
- [ ] **Step 2:** 執行 `npx vitest run tests/content-repo.test.ts tests/inquiry.test.ts tests/jsonld.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作 repo、JSON-LD 和 inquiry，再依照 `design/tokens.md` 和 `frontend-design` skill 實作頁面。
- [ ] **Step 4:** 執行 `npx vitest run`，預期全部 PASS。
- [ ] **Step 5:** 執行 `npm run preview`，用瀏覽器窗格檢查 `/zh-TW`、`/en/rooms`、`/ja/rooms/deluxe-room`、`/ko/faq`，桌機和手機（375px）各截一張圖，確認版面、圖片和文字都正確，沒有出現原始的 key 名稱。
- [ ] **Step 6:** 對 `/zh-TW` 和 `/en/rooms/classic-room` 跑 Lighthouse（手機），預期效能 ≥ 90、無障礙 ≥ 95、SEO = 100。沒有達標就修到達標。
- [ ] **Step 7:** Commit：`feat(site): brand pages, room pages, inquiry form, JSON-LD, sitemap`

---

### Task 9: 訂房流程畫面和 API 串接

**Files:**
- Create: `app/[locale]/book/page.tsx`（搜尋結果）、`app/[locale]/book/details/page.tsx`（加購、旅客資料、條款、報價摘要）、`app/[locale]/book/return/[code]/page.tsx`（付款回來後輪詢狀態）、`app/[locale]/manage/page.tsx`（用代碼加 Email 查詢）、`app/[locale]/manage/[code]/page.tsx`（訂單詳情和取消）、`app/api/bookings/route.ts`（POST → createReservation）、`app/api/bookings/[code]/status/route.ts`（GET，需要帶 `?email=`）、`app/api/bookings/[code]/cancel/route.ts`（POST）、`app/api/payments/notify/route.ts`（POST → handlePaymentNotice）、`app/api/quote/route.ts`（POST，給 details 頁即時試算）、`lib/runtime/deps.ts`（從 `env` 組出 Deps）、`lib/api/rate-limit.ts`、`components/booking/*`
- Test: `tests/api/bookings.test.ts`、`tests/api/rate-limit.test.ts`

**Interfaces:**
- Consumes: Task 4、5、6 的 service；`quote`（Plan 1）
- Produces:
  - `getDeps(): Promise<Deps>`：依 `env.PAYMENT_MODE`（`"mock"` 或 `"sinopac"`）選擇 gateway；Plan 2 只實作 mock，選 `sinopac` 時丟出 `Error("SINOPAC_NOT_CONFIGURED")`。依 `env.CHANNEL_MODE`（`"mock"` 或 `"siteminder"`）選擇 channel；Plan 4 才實作 siteminder。EmailSender 在有 `env.RESEND_API_KEY` 時用 Resend，否則用 mock，並把信件內容印到 log。`staffEmails` 從 `env.STAFF_EMAILS` 讀取（逗號分隔）。
  - API handler 一律寫成可以測試的形式，例如 `handleCreateBooking(deps, request, now): Promise<Response>`；`route.ts` 只負責轉接。
  - `checkRate(db, key: string, limit: number, windowSec: number, now: Date): Promise<boolean>`（`lib/api/rate-limit.ts`）：用 D1 表 `rate_limits(key, windowStart, count)` 實作。限制條件：查詢和取消每個 IP 每分鐘 10 次；建立訂單每個 IP 每分鐘 5 次。這張表要在本任務新增，並產生 migration。
  - 畫面流程：
    1. 搜尋結果：依房型分組，每組顯示照片、名稱、可住人數，以及每個方案的價格（每晚均價和總價）。剩 1 到 2 間時，顯示「僅剩 N 間」。
    2. 填資料：加購、折扣碼即時試算、旅客資料（國碼加電話、國家下拉選單）、同意條款（必勾）、取消規則摘要。
    3. 送出後由 server 依 `ChargeStart` 轉址到金流頁。
    4. 回到返回頁，每 2 秒查一次狀態，最多 60 秒；`confirmed` 就顯示確認畫面；`paid_pending_confirm` 就顯示「付款成功，正在確認房間，確認信將寄到 xxx」；失敗或退款就顯示對應的說明。
  - `idempotencyKey` 在 details 頁載入時用 `crypto.randomUUID()` 產生，存在表單的 hidden 欄位。

- [ ] **Step 1:** 寫失敗的測試：
  - `handleCreateBooking`：資料缺欄位回傳 400；正常送出回傳 200，內容是 `{ code, start }`；同一個 IP 第 6 次回傳 429。
  - `handleBookingStatus`：Email 錯誤回傳 404；正確回傳 status。
  - `handleNotify`：用 mock 簽好的通知回傳 200；竄改過的回傳 400。
  - `checkRate`：視窗內第 11 次回傳 false；換到下一個視窗後回傳 true。
- [ ] **Step 2:** 執行 `npx vitest run tests/api`，預期 FAIL。
- [ ] **Step 3:** 實作 API、deps 和畫面。
- [ ] **Step 4:** 執行 `npx vitest run`，預期全部 PASS。
- [ ] **Step 5:** 端對端手動驗證：依序執行 `npm run db:migrate:local`、`npx tsx scripts/seed-local.ts`、`npm run preview`。在瀏覽器窗格跑一次完整流程：搜尋 → 選 Deluxe → 加早餐 → 填資料 → 模擬付款頁按「付款成功」→ 返回頁顯示已確認。用 `wrangler d1 execute` 查詢，確認 reservations 的 status 是 `confirmed`。log 中可以看到 mock 寄出的旅客確認信和館方通知。再從 `/en/manage` 取消，確認退款金額正確，status 變成 `cancelled`。
- [ ] **Step 6:** Commit：`feat(booking-ui): search, details, payment redirect, return polling, manage booking`

---

### Task 10: 排程 Worker（cron）和部署設定

**Files:**
- Create: `worker.ts`（自訂 worker 進入點：`fetch` 交給 OpenNext，`scheduled` 呼叫 `runExpireHolds` 和 `runSyncRetry`）、`docs/DEPLOY.md`
- Modify: `wrangler.jsonc`：
  - `main` 改成 `worker.ts`。
  - 加上 `triggers.crons = ["*/5 * * * *"]`。
  - `vars` 加上 `PAYMENT_MODE="mock"`、`CHANNEL_MODE="mock"`。
  - secrets 的說明放在 `.dev.vars.example`：`RESEND_API_KEY`、`MOCK_PAYMENT_SECRET`、`STAFF_EMAILS`、`BASE_URL`。
- Create: `lib/jobs/pre-arrival.ts`
- Test: `tests/jobs/scheduled.test.ts`

**Interfaces:**
- Consumes: `runExpireHolds`、`runSyncRetry`（Task 5）、`getDeps`（Task 9）
- Produces:
  - `runPreArrival(deps: Deps, now: Date): Promise<{ sent: number }>`（`lib/jobs/pre-arrival.ts`）：找出 `confirmed` 而且 `checkIn` 等於台北時間今天加 3 天的訂單，用 `sendOnce` 寄出 `pre_arrival` 信（用旅客的語言，內容包含交通方式、入住時間、館方聯絡方式）。這是 spec 5.7 規定的。
  - `runScheduled(deps: Deps, now: Date): Promise<{ expired: number; attempted: number; preArrival: number }>`：依序執行 expire、retry、preArrival。任一個失敗都不能影響其他兩個執行，錯誤要記到 log。

- [ ] **Step 1:** 寫失敗的測試：
  - 準備一筆逾時的待付款訂單、一筆待回推的訂單、一筆三天後入住的已確認訂單：`runScheduled` 回傳 `{ expired: 1, attempted: 1, preArrival: 1 }`。
  - 同一天再執行一次，preArrival 是 0（不會重寄）。
  - 把 `runExpireHolds` 改成會丟出錯誤之後，`attempted` 和 `preArrival` 仍然各是 1。
- [ ] **Step 2:** 執行 `npx vitest run tests/jobs/scheduled.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作。`worker.ts` 依 OpenNext 官方的「Custom Worker」寫法，匯入 `.open-next/worker.js` 的 default handler。
- [ ] **Step 4:** 執行 `npx vitest run`，預期全部 PASS。執行 `npx opennextjs-cloudflare build`，預期成功。執行 `npx wrangler dev --test-scheduled`，再用 `curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`，log 要顯示 `expired=… attempted=…`。
- [ ] **Step 5:** 寫 `docs/DEPLOY.md`：
  - 建立 D1、R2（`nk-media`）、設定 secrets。
  - `wrangler d1 migrations apply nk-booking --remote`。
  - 匯入內容。
  - 綁定網域。
  - 上線前檢查清單：把 PAYMENT_MODE 和 CHANNEL_MODE 切成正式值（Plan 4）、Resend 網域驗證、Cloudflare Access（Plan 3）。
- [ ] **Step 6:** Commit：`feat(ops): scheduled worker for hold expiry, SiteMinder retry, pre-arrival email; deploy guide`
