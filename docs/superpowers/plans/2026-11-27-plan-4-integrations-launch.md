# Plan 4 — 正式串接（SiteMinder、永豐）與上線 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Plan 1–3 用的模擬器換成真正的 SiteMinder（SiteConnect）和永豐網路收單。接著在 staging 環境完成雙方的認證測試，處理上線前剩下的問題，最後照 runbook 切換正式網站，把舊官網的「立即訂房」改到新的直訂流程。

**Architecture:**

- **一致性測試（conformance suite）**
  - 先為 `ChannelManager` 和 `PaymentGateway` 各寫一套一致性測試，用來確認「正式 adapter 和 mock 行為一樣」。
  - 規則包括：用訂單代碼做 idempotent、可不可以重試的分類、逾時上限、退款用 idempotency key、每次付款嘗試都有不同的 ref。
  - mock 和正式 adapter 都要通過同一套測試。正式 adapter 跑的是從廠商文件和 sandbox 錄下來的 fixtures。
- **SiteMinder adapter**（`lib/channel/siteminder/*`）
  - 負責組出和解析 SiteConnect 的 OTA XML。
  - 兩個方向都要處理：推送訂單出去，以及接收 SiteMinder 推送進來的 ARI。
- **永豐 adapter**（`lib/payments/sinopac/*`）
  - 負責加解密、簽章、交易查詢和退款。
- **營運**：用 staging 環境（Cloudflare `env.staging`）跑完整的端對端測試和廠商認證。上線時照 runbook 一步步執行，每一步都有確認點和回滾方式。

**Tech Stack:** 沿用前三份計畫。XML 用 `fast-xml-parser`，在 Workers 上可以執行，必須鎖定版本。加解密只用 Web Crypto（AES-CBC 或 GCM、SHA-256、HMAC）。

**Spec:** `docs/superpowers/specs/2026-11-24-nk-hostel-direct-booking-design.md`，主要依據第 5.3、5.4、7、8、9 節。

**承接：**

- `docs/superpowers/plans/2026-11-25-plan-2-rulings.md` 和 `docs/superpowers/plans/2026-11-26-plan-3-rulings.md` 裡標記「上線前要修」的延後項目，本計畫 Task 8 會處理。
- `docs/DEPLOY.md` 已經有環境說明、Access、第一位 owner 和上線檢查清單。

**★ 業主前置條件**（沒有這些，對應的任務就不能開始；執行時遇到要停下來等）：

1. **SiteMinder**
   - SiteConnect 的開發者或通路資格。
   - 技術文件：訊息規格、endpoint、驗證方式、認證測試案例。
   - sandbox 帳號，以及 property code、room type code、rate plan code。
   - 文件存放在 `docs/vendor/siteminder/`。這個資料夾要加進 `.gitignore`；如果合約不允許，文件放在 repo 外面，只記路徑。
2. **永豐銀行**
   - 網路收單特約與技術文件（API 規格、加密與簽章方式、測試卡號、退款與查詢 API）。
   - 測試環境的商店代號和金鑰。
   - 文件存放在 `docs/vendor/sinopac/`，處理方式同上。
3. **Cloudflare**
   - staging 和 production 用的帳號權限，由業主授權。
   - 網域 DNS 的管理權限。
4. **業主資料確認**
   - 取消規則、可住人數、加購和折扣、入住和退房時間、法務文件、翻譯校稿、照片。

## Global Constraints

- **卡號不進我們的伺服器。** 永豐的頁面跳轉或 token 化流程中，卡號、CVV、有效期限都不可以經過我們的 Worker。如果永豐只提供「商店端收卡號」的 API，就**停下來**，不可以實作，回報業主改用永豐的託管頁。
- **金鑰都放在 Cloudflare secrets**，不能出現在 repo、log 或錯誤訊息裡。所有 log 都要經過 `redact()`，把卡號、金鑰和 token 的樣式遮掉。
- **所有對外呼叫都要設逾時。**
  - SiteMinder 推送設 **60 秒**，遠低於 `SYNC_LEASE_MS` 的 2 分鐘。這是 Plan 3 延後項目 M-3 的要求。
  - 永豐每次呼叫設 **30 秒**。
  - 逾時一律當成「可以重試」，並且必須能用 idempotency 收斂，不可以因為重試而產生兩筆。
- **推送訂單要 idempotent。** 同一個訂單代碼重送，SiteMinder 只能有一筆訂單。修改和取消必須帶上原本的 SiteMinder 確認號。
- **每次付款嘗試的 providerRef 都不一樣。** 這是 Plan 2 延後的要求。如果永豐要求商店訂單編號唯一，就用 `<code>-<attemptNo>` 這種格式，並把 attemptNo 存起來。
- **接收 SiteMinder 推送的 endpoint 一定要驗證**（帳密或簽章，依文件規定）。如果文件有提供 IP 範圍，再加上 IP 白名單。要有速率限制，request body 上限 1 MB。
- **環境要分開。**
  - staging 只能連 SiteMinder sandbox 和永豐測試環境。
  - production 只能連正式環境。
  - `ENVIRONMENT` 和各自的 secrets 都要分開。在 production 讀到 sandbox 的 URL 時，必須 fail closed（直接拒絕啟動）。
- **對外部系統的不可逆動作一定要先問使用者或業主**，包括：用 `--remote` 跑 migration、部署 production、改 DNS、在正式環境刷真卡和退款。這些步驟在計畫裡都標成 ★，執行時要停下來取得同意。

## Review Focus

1. **SiteMinder 推送逾時，但其實對方已經收到**，接著重試 → 只能有一筆。之後的修改和取消要指向同一筆。測試寫在 Task 1、3。
2. **ARI 推送裡有未知的代碼、壞掉的 XML、重複或亂序的訊息、超大的 body** → 未知代碼只記錄不套用，壞掉的 XML 回錯誤且一筆都不套用，亂序的以 timestamp 較新的為準，超過大小一律拒收。測試寫在 Task 4。
3. **永豐的付款通知簽章錯誤、金額不符、重送，或同一張訂單第二次付款嘗試** → 沿用 Plan 2 的規則，加上每次嘗試的 ref 都不同。測試寫在 Task 2、5。
4. **退款逾時**（不知道永豐到底有沒有退）→ 不可以直接再退一次。要先用交易查詢 API 確認狀態，查得到結果就照實記錄，查不到才把 intent 留在 pending，交給人工對帳。測試寫在 Task 5、6。
5. **在 production 誤用 sandbox 設定或 mock** → 啟動時就拒絕。測試寫在 Task 7。

---

### Task 1: ChannelManager 一致性測試，以及 mock 補強

**Files:**
- Create: `tests/conformance/channel.ts`（共用的測試工廠）、`tests/channel/mock-conformance.test.ts`
- Modify: `lib/channel/types.ts`、`lib/channel/mock.ts`

**Interfaces:**
- Produces:
  - `ChannelManager` 新增兩個方法：
    - `lookupReservation(code): Promise<{ found: true; smConfirmation: string; state: "active" | "cancelled" } | { found: false } | { error: string; retryable: boolean }>`。用途：推送逾時後，查查看對方到底有沒有收到。
    - `readonly timeoutMs: number`
  - `channelConformance(make: () => ChannelManager, opts: { fixtures?: ... })`：一組 describe 區塊，涵蓋以下規則：
    1. 同一個 code 推送兩次 → 兩次拿到同一個 `smConfirmation`。
    2. 修改或取消必須帶已知的 `smConfirmation`；不認識的 code 回傳 `retryable: false`。
    3. 逾時回傳 `retryable: true`。
    4. `timeoutMs` 要小於等於 60000。
    5. `lookupReservation` 在推送成功後回傳 `found`。
  - `confirmWithChannel` 和 `runSyncRetry` 的修改：推送「可以重試」的失敗之後，下一次重試先呼叫 `lookupReservation`。如果結果是 found，就直接把那筆 `smConfirmation` 當作成功，不再推送。這也解決了 Plan 2 的延後項目「推送逾時但其實成功」。
  - 取消：如果推送一直沒有成功，但訂單已經在本地被取消或退款，排程要對 channel 發一次 cancel（如果 lookup 顯示對方有這筆）。這是 Plan 2 的延後項目「本地已取消，但 SiteMinder 還有這筆」。
- [ ] **Step 1:** 寫失敗的測試。用 `MockChannelManager` 執行 `channelConformance`。另外加兩個情境：
  - 第一次推送時，mock 模擬「對方收到了，但我們這邊逾時」，接著執行 `runSyncRetry` → mock 裡只有 1 筆訂單，訂單狀態變成 confirmed。
  - 本地取消時推送一直失敗，之後 lookup 顯示對方有這筆 → 對方收到 cancel。
- [ ] **Step 2:** 執行 `npx vitest run tests/channel`，預期 FAIL。
- [ ] **Step 3:** 實作，並更新 mock，讓它支援「收到了但回應逾時」的模擬模式。
- [ ] **Step 4:** 執行 `npx vitest run`，預期全部 PASS。
- [ ] **Step 5:** Commit：`feat(channel): conformance suite, lookup-before-retry, cancel reconciliation`

---

### Task 2: PaymentGateway 一致性測試，以及 mock 補強

**Files:**
- Create: `tests/conformance/payment.ts`、`tests/payments/mock-conformance.test.ts`
- Modify: `lib/payments/types.ts`、`lib/payments/mock-sinopac.ts`、`lib/booking/create.ts`（付款嘗試編號）、`lib/db/schema.ts`（`reservations.chargeAttempt` integer default 0，並產生 migration）

**Interfaces:**
- Produces:
  - `PaymentGateway` 新增：
    - `queryTransaction(ref: { providerRef?: string; merchantOrderNo?: string }): Promise<{ status: "succeeded" | "failed" | "pending" | "not_found"; amount?: number; providerRef?: string } | { error: string }>`
    - `queryRefund(idempotencyKey: string): Promise<{ status: "succeeded" | "failed" | "pending" | "not_found"; refundRef?: string } | { error: string }>`
    - `readonly timeoutMs: number`
  - `ChargeRequest` 新增 `merchantOrderNo: string`，由 `createReservation` 產生，格式是 `<code>-<chargeAttempt>`。每次 startCharge 前，`chargeAttempt` 先加 1，而且在同一個條件式更新裡完成。
  - `paymentConformance(make, opts)` 涵蓋以下規則：
    1. 用正確的通知（notice）驗證 → ok。竄改內容 → `BAD_SIGNATURE`。格式錯誤 → `MALFORMED`。
    2. 同一個 `idempotencyKey` 退款兩次 → 只退一次，而且兩次回傳同一個 refundRef。
    3. 第二次付款嘗試的 `merchantOrderNo` 和第一次不同。
    4. `queryRefund` 在退款成功後回傳 succeeded。
    5. `timeoutMs` 要小於等於 30000。
  - `refundOnce` 的修改：呼叫 gateway 時如果遇到逾時或網路錯誤，不要直接把結果標成 failed 或繼續卡著。先呼叫 `queryRefund(key)`：
    - 回傳 succeeded → 記為成功。
    - 回傳 failed 或 not_found → 標成 failed，可以重試。
    - 回傳 pending，或查詢本身也失敗 → 維持 pending，交給 Plan 3 的人工對帳流程。
- [ ] **Step 1:** 寫失敗的測試。用 mock 執行 `paymentConformance`。另外加兩個情境：
  - 退款「已經成功，但回應逾時」→ `refundOnce` 經過 query 之後記成 succeeded，gateway 只退一次。
  - 重新付款 → 兩次的 `merchantOrderNo` 依序是 `NK-XXXXXX-1`、`NK-XXXXXX-2`。
- [ ] **Step 2:** 執行 `npx vitest run tests/payments`，預期 FAIL。
- [ ] **Step 3:** 實作，並執行 `npm run db:generate`、`npm run db:migrate:local`。
- [ ] **Step 4:** 執行 `npx vitest run`，預期全部 PASS。
- [ ] **Step 5:** Commit：`feat(payments): conformance suite, per-attempt order numbers, query-before-assume on refund timeouts`

---

### Task 3: SiteMinder SiteConnect adapter（往外推送訂單）★ 需要前置條件 1

**Files:**
- Create: `docs/integrations/siteminder.md`（欄位對照表）、`lib/channel/siteminder/{client,xml,map,errors}.ts`、`tests/channel/siteminder/*.test.ts`、`tests/fixtures/siteminder/*.xml`
- Modify: `lib/runtime/deps.ts`（`CHANNEL_MODE=siteminder`）、`package.json`（`fast-xml-parser`，鎖定版本）

**Interfaces:**
- Consumes: Task 1 的 `ChannelManager` 和 `channelConformance`，以及 `toChannelReservation`（Plan 2）。
- Produces: `class SiteMinderChannelManager implements ChannelManager`，建構子參數是 `{ endpoint: string; username: string; password: string; hotelCode: string; fetch?: typeof fetch; timeoutMs?: number }`。
- [ ] **Step 1: 先把文件讀清楚，寫成對照表。**
  - 讀 `docs/vendor/siteminder/`，在 `docs/integrations/siteminder.md` 寫下：
    - 使用的訊息種類：訂單新增、修改、取消，通常是 `OTA_HotelResNotifRQ`，對應的 ResStatus 依文件為準。
    - 查詢訂單的方式。
    - 驗證方式。
    - 錯誤碼，以及每個錯誤碼要分到哪一類：可以重試，或不可以重試。
    - 我們的 `ChannelReservation` 每個欄位對應到 XML 的哪個路徑。包括加購項目、預付金額、折扣碼要放在哪裡，才能讓靈知看到（spec 5.8）。
  - 文件裡沒寫清楚的部分，列成問題清單交給業主，向 SiteMinder 詢問。**這些部分不可以自己猜。**
- [ ] **Step 2: 從文件的範例訊息建 fixtures。** 放在 `tests/fixtures/siteminder/`，內容包括請求範例、成功回應、各種錯誤回應。範例裡的帳號和金鑰一律換成假值。
- [ ] **Step 3: 寫失敗的測試。**
  - `toOtaResNotif(res)` 產生的 XML 中，對照表上的每個欄位值都要正確（用 XPath 斷言）。
  - 每一個錯誤回應 fixture → 依對照表分到正確的類別（可重試或不可重試）。
  - `channelConformance(() => new SiteMinderChannelManager({ fetch: fixtureFetch, ... }))` 全部通過。`fixtureFetch` 依照請求內容回傳對應的 fixture。
  - 超過 timeoutMs 時，用 AbortController 中斷請求，回傳 `retryable: true`。
- [ ] **Step 4:** 執行 `npx vitest run tests/channel/siteminder`，預期 FAIL。
- [ ] **Step 5:** 實作，log 一律經過 `redact()`。
- [ ] **Step 6:** 執行 `npx vitest run`，預期全部 PASS。
- [ ] **Step 7:** Commit：`feat(channel): SiteMinder SiteConnect adapter`

---

### Task 4: 接收 SiteMinder 推送的 ARI ★ 需要前置條件 1

**Files:**
- Create: `app/api/channel/siteminder/ari/route.ts`、`lib/channel/siteminder/ari-inbound.ts`、`tests/channel/siteminder/ari-inbound.test.ts`、`tests/fixtures/siteminder/ari-*.xml`
- Modify: `lib/db/ari-sync.ts`（支援 timestamp：只套用比現有資料更新的訊息）、`lib/db/schema.ts`（`ariDaily.sourceTs`、`inventoryDaily.sourceTs`，並產生 migration）

**Interfaces:**
- Consumes: `applyAriUpdates`（Plan 1，已經處理過驗證和分批寫入）、`checkRate`（Plan 2）。
- Produces:
  - `handleSiteMinderAri(deps: { db; env }, req: Request, now): Promise<Response>`，處理順序如下：
    1. 驗證，方式依文件規定。失敗回 401。
    2. 檢查 body 大小，上限 1 MB，超過回 413。
    3. 解析 XML，失敗回文件規定的錯誤回應，一筆都不套用。
    4. 轉成 `AriUpdate[]`，每筆帶上 `sourceTs`。
    5. 呼叫 `applyAriUpdates`。條件式寫入只會在 `sourceTs >= 現有值` 時才覆寫，所以亂序到達的舊訊息會被忽略。
    6. 未知的代碼記錄下來，並回報到後台的系統狀態頁。
    7. 回傳文件規定的成功回應。
  - 推送下來的量很大時（例如一次推 365 天），沿用 `applyAriUpdates` 的分批寫入，每批 100 筆。如果 Worker 會超過 D1 每次呼叫的查詢上限，就改成丟進 Cloudflare Queue 背景處理：新增一個 queue binding 和 consumer。改用 queue 時要說明原因並寫測試。
- [ ] **Step 1: 寫失敗的測試。**
  - 正確的推送 → 套用成功，回傳成功回應。
  - 驗證錯誤 → 401，資料不變。
  - 2 MB 的 body → 413。
  - 壞掉的 XML → 錯誤回應，資料不變。
  - 先送 `sourceTs=t2`、再送 `sourceTs=t1`（較舊）→ 保留 t2 的值。
  - 未知的房型代碼 → 其他資料照常套用，系統狀態頁出現警示。
  - 一次推送 365 天 × 8 房型 → 全部套用完成。用 better-sqlite3 驗證筆數，並另外測試分批或 queue 的流程。
- [ ] **Step 2:** 執行 `npx vitest run tests/channel/siteminder/ari-inbound.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作，並執行 `npm run db:generate`、`npm run db:migrate:local`。
- [ ] **Step 4:** 執行 `npx vitest run`，預期 PASS。
- [ ] **Step 5:** Commit：`feat(channel): authenticated SiteMinder ARI inbound with ordering and size limits`

---

### Task 5: 永豐網路收單 adapter ★ 需要前置條件 2

**Files:**
- Create: `docs/integrations/sinopac.md`、`lib/payments/sinopac/{client,crypto,map,errors}.ts`、`tests/payments/sinopac/*.test.ts`、`tests/fixtures/sinopac/*`
- Modify: `lib/runtime/deps.ts`（`PAYMENT_MODE=sinopac`）

**Interfaces:**
- Consumes: Task 2 的 `PaymentGateway` 和 `paymentConformance`。
- Produces: `class SinoPacGateway implements PaymentGateway`，建構子參數是 `{ merchantId; terminalId?; keys: {...依文件}; endpoints: {...}; fetch?; timeoutMs? }`。
- [ ] **Step 1: 先把文件讀清楚，寫成對照表。**
  - 讀 `docs/vendor/sinopac/`，在 `docs/integrations/sinopac.md` 寫下：
    - 付款流程，必須是**託管頁或跳轉**的方式。
    - 通知的驗證方式（加密演算法、簽章欄位）。
    - 金額單位（元或分）。
    - 退款 API 和部分退款的規則。
    - 交易查詢和退款查詢 API。
    - 是否支援 idempotency key。如果不支援，要寫下用什麼方式達到同樣效果，例如用商店退款編號 = 我們的 idempotencyKey 的雜湊值。
    - 是否支援 3D 驗證、Apple Pay、預授權。
    - 錯誤碼要分到哪一類：可以重試，或不可以重試。
  - 如果流程需要商店端收卡號，**停下來，回報業主**（見 Global Constraints）。
- [ ] **Step 2: 建 fixtures。** 從文件的範例和測試環境的實際回應錄製，金鑰一律換成假值。
- [ ] **Step 3: 寫失敗的測試。**
  - 加密和簽章：要和文件附的範例向量完全一致。
  - 通知解析：金額換成以元為單位的整數；竄改內容 → `BAD_SIGNATURE`。
  - `paymentConformance(() => new SinoPacGateway({ fetch: fixtureFetch, ... }))` 全部通過。
  - 退款逾時之後，`queryRefund` 查到 succeeded → 只算退了一次。
- [ ] **Step 4:** 執行 `npx vitest run tests/payments/sinopac`，預期 FAIL。
- [ ] **Step 5:** 實作。加解密只用 Web Crypto；log 一律經過 `redact()`，信用卡相關欄位也要遮掉。
- [ ] **Step 6:** 執行 `npx vitest run`，預期 PASS。
- [ ] **Step 7:** Commit：`feat(payments): SinoPac acquiring adapter`

---

### Task 6: 自動對帳排程

**Files:**
- Create: `lib/jobs/reconcile-gateway.ts`、`lib/jobs/reconcile-channel.ts`、`tests/jobs/reconcile-*.test.ts`
- Modify: `lib/jobs/cron.ts`、`lib/admin/dashboard.ts`（新增警示種類）

**Interfaces:**
- Produces:
  - `runGatewayReconcile(deps, now)`：每 15 分鐘執行一次。
    - 對 pending 超過 10 分鐘的付款（charge）和退款（refund）呼叫 query API，把結果套用上去（同樣經過 `refundOnce` 和 `settle` 的守門邏輯）。
    - 查不到結果的維持 pending，留給人工處理。
  - `runChannelReconcile(deps, now)`：每天台北時間 04:00 執行一次。
    - 對未來 60 天內所有 direct 訂單呼叫 `lookupReservation`。
    - 本地是 confirmed、對方找不到 → 重新推送。
    - 本地是 cancelled、對方是 active → 推送 cancel。
    - 兩邊確認號不一致 → 出現警示 `channel_mismatch`。
  - 每次執行都寫一筆 `job_runs`。
- [ ] **Step 1: 寫失敗的測試。** 用 mock 模擬以下情況：
  - pending 的退款，query 結果是 succeeded → 訂單完成取消流程。
  - 本地已取消，但對方還是 active → 對方收到 cancel。
  - 確認號不一致 → 出現警示。
- [ ] **Step 2:** 執行 `npx vitest run tests/jobs/reconcile-gateway.test.ts tests/jobs/reconcile-channel.test.ts`，預期 FAIL。
- [ ] **Step 3:** 實作，並在 `wrangler.jsonc` 加上兩個 cron。staging 和 production 都要加。
- [ ] **Step 4:** 執行 `npx vitest run`，預期 PASS。
- [ ] **Step 5:** Commit：`feat(ops): automatic gateway and channel reconciliation`

---

### Task 7: staging 環境、設定防呆、redact、監控 ★ 需要前置條件 3

**Files:**
- Modify: `wrangler.jsonc`（新增 `env.staging`，有自己的 D1、R2、cron、`ENVIRONMENT="staging"`）、`lib/runtime/deps.ts`、`lib/runtime/env.ts`、`docs/DEPLOY.md`、`package.json`（`deploy:staging`）
- Create: `lib/runtime/redact.ts`、`lib/runtime/config-guard.ts`、`lib/ops/alerts.ts`、`tests/runtime/*.test.ts`

**Interfaces:**
- Produces:
  - `assertConfig(env): void`：在每個 request 和 scheduled 的入口呼叫。以下情況直接丟出錯誤，請求回 503，排程跳過並記錄：
    - `ENVIRONMENT=production`，但 SiteMinder 或永豐的 endpoint 指向 sandbox 或測試網域（網域清單寫在對照表裡）。
    - `ENVIRONMENT=staging`，但 endpoint 指向正式網域。
    - production 使用任何 mock 模式。
  - `redact(s: string): string`：遮掉以下內容：
    - 13 到 19 位數字（允許中間有空白或連字號）
    - `Authorization` 和 `Cookie` 的值
    - 已知的金鑰欄位名稱：`password`、`secret`、`key`、`token`、`hashKey`、`hashIV`
  - `notifyOps(env, alert: { kind; detail })`：寄信給 `OPS_EMAILS`，每種警示每小時最多寄一封（沿用 notifications 表去重）。觸發時機：
    - cron 連續失敗 3 次
    - 對帳出現不一致
    - ARI 推送裡有未知代碼
- [ ] **Step 1: 寫失敗的測試。**
  - production 設了 sandbox 的 URL → `assertConfig` 丟出錯誤。
  - `redact("card 4111 1111 1111 1111 key=abc")` 不會留下卡號，也不會留下 `abc`。
  - 一小時內發生兩次相同警示 → 只寄一封。
- [ ] **Step 2:** 執行 `npx vitest run tests/runtime`，預期 FAIL。
- [ ] **Step 3:** 實作，並把 `redact` 套用到所有 adapter 和 job 的 log。
- [ ] **Step 4:** 執行 `npx vitest run`，預期 PASS。
- [ ] **Step 5: ★ 停下來取得同意**，然後才在業主的 Cloudflare 帳號建立 staging 資源（D1、R2、Images、Access application）並設定 secrets。只用 SiteMinder sandbox 和永豐測試環境的值。
- [ ] **Step 6: ★ 停下來取得同意**，然後依序執行：
  1. 對 staging 跑 `wrangler d1 migrations apply --env staging --remote`。
  2. 在 staging 故意製造大小寫碰撞的資料，確認 0015 和 0017 的回滾行為符合預期（Plan 3 的待驗證項目）。
  3. 執行 `npm run deploy:staging`、`media:variants -- --remote --env staging`，以及第一位 owner 的 SQL。
- [ ] **Step 7:** Commit：`feat(ops): staging environment, config guard, log redaction, ops alerts`

---

### Task 8: 上線前的延後項目

**Files:** 依項目而定。每一項都要先寫失敗的測試，再修。

逐項修正，每項一個 commit。來源是 Plan 2 和 Plan 3 rulings 文件裡，標記「開放訂房前要修」的項目：

1. **員工取消時選擇「不通知旅客」，在對帳完成時會被忽略**（Plan 3）。要把 `notifyGuest` 存在取消 intent 上，對帳完成時照這個設定決定要不要寄信。
2. **報表裡的退款要以「成功的日期」入帳，不是建立的日期**（Plan 3 M-6）。在 payments 加 `settledAt` 欄位，所有讓退款變成 succeeded 的路徑都要寫入它，報表改用 `settledAt`。
3. **停滯的取消請求在最後轉換狀態時，會寫入過時的櫃檯應退金額**（Plan 3 M-1 殘留）。transition 要改用資料庫裡的 `cancelDeskDue`。
4. **settle_offline 套用在 pending 的退款列時**（Plan 3）：
   - 對話框要提醒「金流可能仍會完成退款」。
   - 執行前先呼叫 Task 2 的 `queryRefund`；如果查到 succeeded，就照查詢結果入帳，不採用人工填的資料。
5. **對帳 API 在只做 settle_offline 時，不需要線上金流設定。** 這時 `getDeps` 只要建立 db 和 email 就好。
6. **一筆匯款要能對應多筆退款列。** 把 `offline:` 的 providerRef 改成 `offline:<ref>:<rowId>`，原本的 ref 另外存在 note。
7. **正式環境的內容匯入腳本**：`scripts/import-content-remote.ts`。規則如下：
   - 只新增，不覆蓋。
   - 先 dry-run，列出會寫入的資料。
   - 預設寫到 staging；要寫到 production 必須加 `--env production --yes`。
   - 只從 `content/old-site.json` 和 R2 匯入。
- [ ] **Step 1:** 每一項都先寫一個會失敗的測試，執行後確認它確實 FAIL，再寫修正，最後確認 PASS。
- [ ] **Step 2:** 執行 `npx vitest run`，預期全部 PASS；再執行 `npx tsc --noEmit`，預期沒有錯誤。
- [ ] **Step 3:** 每一項各自 commit：`fix: pre-launch — <項目>`

---

### Task 9: staging 認證測試與上線 runbook ★ 需要前置條件 1–4

**Files:**
- Create: `docs/LAUNCH.md`（runbook）、`docs/integrations/certification-log.md`（認證紀錄）

**Interfaces:**
- Produces:
  - **SiteMinder 認證**：照 SiteMinder 提供的認證測試案例，在 staging 逐一執行。每個案例都記錄在 `certification-log.md`，包括請求和回應的摘要（經過 redact）、結果、日期。
  - **永豐測試**：用測試卡號跑完以下情境，全部記錄下來：
    - 付款成功、付款失敗
    - 3D 驗證
    - 重新付款
    - 全額退款、部分退款
    - 退款逾時後經過查詢入帳
    - 通知重送
  - **`docs/LAUNCH.md` 的內容**：
    1. **前一週**：凍結新功能；業主完成所有資料確認；production 的 D1、R2、Images、Access、secrets 都準備好（★）。
    2. **前一天**：把 production 的 migration 套用到空的資料庫（★）；匯入內容（★）；在 production 用一張真卡刷 NT$1 或最低金額，再全額退款（★，由業主本人刷卡）；在 SiteMinder 正式環境推送一筆測試訂單，然後取消（★，要先跟 SiteMinder 和業主確認做法）。
    3. **切換當天**：
       - 綁定網域，DNS 切到 Workers（★）。
       - 把舊官網的「立即訂房」連結改到新網站（★，由業主或舊站的維護者執行）。
       - 觀察 2 小時：看 job_runs、警示、第一筆真實訂單。
    4. **回滾**：DNS 切回舊站；舊官網的「立即訂房」改回 SiteMinder 原本的訂房引擎。已經成立的直訂訂單繼續由後台處理，SiteMinder 裡也有這些訂單，不會遺失。
    5. **上線後一週**：每天檢查對帳結果和警示；收集員工回饋。
- [ ] **Step 1:** 寫 `docs/LAUNCH.md`，把每一個需要停下來取得同意的步驟（★）標清楚。
- [ ] **Step 2: ★ 停下來取得同意**，然後在 staging 執行 SiteMinder 認證和永豐測試，結果寫進 `certification-log.md`。
- [ ] **Step 3: ★ 停下來取得同意**，然後照 runbook 逐步執行上線。每完成一步回報一次，任何一步失敗就照回滾方式處理。
- [ ] **Step 4:** Commit：`docs: launch runbook and certification log`
