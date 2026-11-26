# SiteMinder SiteConnect 串接對照（Plan 4 Task 3、4）

> 依據：SiteMinder 公開的 SiteConnect 文件（2026-11-26 讀取）。內文標了來源標籤（如 [RES]）的句子出自文件，標籤連到第 1 節的網址。標 **inferred** 的是我們自己的推論，沒有寫在文件裡。文件沒寫清楚的部分列在第 7 節，要寄給 SiteMinder 確認，**不可以自己猜**。
> 只參考 SiteConnect。pmsXchange、SMX、Channels Plus 的方向和規則都不同，不適用。

## 1. 來源清單（全部在 2026-11-26 讀取）

| 標籤 | URL | 內容 |
|---|---|---|
| [OV] | https://developer.siteminder.com/siteconnect-api/siteconnect-api.md | SiteConnect 總覽（OTA 標準，ARI 由 SiteMinder 推送，訂單由通路推送） |
| [API] | https://developer.siteminder.com/siteconnect-api/guides/api-overview.md | 四種操作：Rooms and Rates、Availability and Restrictions、Rates、Reservations，全部是 SOAP/XML |
| [QS] | https://developer.siteminder.com/siteconnect-api/guides/quick-start.md | 雙方要交換的項目、WSSE header、sandbox 訂單 endpoint、WSDL、第一支呼叫（Rooms and Rates） |
| [REQ] | https://developer.siteminder.com/siteconnect-api/guides/integration-requirements.md | SOAP 1.1、TLS、密碼政策、IP、WAF 與 User-Agent、EchoToken、TimeStamp、minify、HotelCode、UniqueID、回應時間、重試、時區 |
| [ERR-G] | https://developer.siteminder.com/siteconnect-api/guides/error-handling.md | 我們回給 SiteMinder 的必要錯誤、auto-disable 機制、SiteMinder 回給我們的錯誤、逾時 60–120 秒、4xx/5xx 處理 |
| [RR] | https://developer.siteminder.com/siteconnect-api/reference/rooms-and-rates.md | `OTA_HotelAvailRQ/RS`：SiteMinder 向我們拉房型和價格方案清單 |
| [AR] | https://developer.siteminder.com/siteconnect-api/reference/availability-and-restrictions.md | `OTA_HotelAvailNotifRQ/RS`：可售數量、Stop Sell、CTA、CTD、Min/Max LOS |
| [RATES] | https://developer.siteminder.com/siteconnect-api/reference/rates.md | `OTA_HotelRateAmountNotifRQ/RS`：PDP 和 OBP 兩種計價 |
| [RES] | https://developer.siteminder.com/siteconnect-api/reference/reservations.md | `OTA_HotelResNotifRQ/RS`：Commit、Modify、Cancel，完整欄位表，常見問題 |
| [FAQ] | https://developer.siteminder.com/siteconnect-api/additional-resources/faq.md | 時程、必要功能、ARI 批次和重試、驗證方式、原子性 |
| [EC] | https://developer.siteminder.com/siteconnect-api/additional-resources/reference-tables/error-codes.md | 錯誤碼（ERR） |
| [EWT] | https://developer.siteminder.com/siteconnect-api/additional-resources/reference-tables/error-warning-types.md | 錯誤類型（EWT） |
| [HTTP] | https://developer.siteminder.com/siteconnect-api/additional-resources/reference-tables/http-error-handling.md | HTTP 4xx/5xx 的處理建議 |
| [TC] | https://developer.siteminder.com/siteconnect-api/guides/testing-and-certification.md | 認證測試情境 1–6 |
| [DC] | https://developer.siteminder.com/siteconnect-api/guides/testing-and-certification/development-checklist.md | 開發檢查清單 |
| [CL] | https://developer.siteminder.com/siteconnect-api/additional-resources/changelog.md | 變更紀錄（2022 年 OBP、2023 年 Stay Through、2024 年 includesCommission） |
| [BC] | https://developer.siteminder.com/get-started/integration-types/booking-channel.md | 訂房通路類型：核心和額外功能，需要先接一間 pilot 飯店 |
| [IP] | https://developer.siteminder.com/get-started/partner-lifecycle/integration-process.md | 合作流程：申請 → 啟動 → 開發 → 認證 → 正式環境（pilot）→ 上線 |
| [IDX] | https://developer.siteminder.com/llms.txt | 文件索引，用來找到上面各頁 |

讀不到或沒有用的頁面：
- https://developer.siteminder.com/siteminder-apis/channels/siteconnect/api-reference/reservations（任務給的網址）會轉到 developer-guide 首頁，裡面沒有規格內容。真正的頁面是 [RES]。
- https://siteminder.atlassian.net/wiki/spaces/SITECONNECT/pages/2178223415 需要 Atlassian 登入，讀不到。

## 2. 訊息流程

| # | 訊息 | 方向 | 誰提供 endpoint | 說明 |
|---|---|---|---|---|
| A | `OTA_HotelAvailRQ` → `OTA_HotelAvailRS` | SiteMinder → 我們（pull） | **我們** | 飯店在 SiteMinder 開啟對應畫面時，SiteMinder 來拉我們的房型和價格方案清單。**這是必要功能，計畫裡還沒有** [RR][FAQ] |
| B | `OTA_HotelAvailNotifRQ` → `OTA_HotelAvailNotifRS` | SiteMinder → 我們（push） | **我們** | 可售數量和限制 [AR] |
| C | `OTA_HotelRateAmountNotifRQ` → `OTA_HotelRateAmountNotifRS` | SiteMinder → 我們（push） | **我們** | 價格 [RATES] |
| D | `OTA_HotelResNotifRQ` → `OTA_HotelResNotifRS` | 我們 → SiteMinder（push） | SiteMinder | 新訂單、修改、取消 [RES] |

- **協定**：只支援 SOAP 1.1，不支援 SOAP 1.2 或 REST。OTA 2010A。Content-Type 只能是 `text/xml; charset=utf-8`，編碼 UTF-8。OTA 訊息放在 `SOAP-ENV:Body` 裡，回應用空的 `<SOAP-ENV:Header/>` [REQ]。
- **XML 規則**：namespace 是 `http://www.opentravel.org/OTA/2003/05`，root 要有 `Version="1.0"` [REQ]。正式環境送出的 XML 必須 minify 成單行 [REQ]。
- **傳輸**：HTTPS，port 443，TLS 1.2 以上 [REQ]（[FAQ] 寫 1.1 以上，兩頁不一致，以較嚴的 1.2 為準，**inferred**）。不接受自簽憑證。我們的 endpoint 必須用註冊網域，不能用 IP [REQ]。
- **驗證**：用 WS-Security `wsse:UsernameToken`，密碼以 PasswordText 明文放在 HTTPS 裡 [QS][REQ]。帳密是通路層級的，一組涵蓋所有飯店 [REQ][FAQ]。**兩個方向各有一組帳密**：
  - 我們呼叫 SiteMinder 時，用 SiteMinder 發給我們的帳密 [QS]。
  - SiteMinder 呼叫我們時，用我們提供的帳密 [QS]。
  - 我們每次收到請求都要驗證 [REQ]。
  - 密碼長度 12–50 字元，要有大小寫字母、數字和特殊字元，但不能用 `< > & " '` [REQ]。
- **EchoToken**：每個請求都不一樣，請求和回應帶同一個值。格式是 UUID 8-4-4-4-12 [REQ]（[RES] 的表格寫成 8-4-4-4-8，應該是筆誤，**inferred**）。我們回應 SiteMinder 時，要原樣帶回對方的 EchoToken（各頁範例都是這樣）。
- **TimeStamp**：ISO 8601 格式，建議用 UTC 加 `Z` [REQ]。
- **RequestorID**：放在 `POS/Source/RequestorID Type="22" ID="<channel code>"`，代碼由 SiteMinder 提供，大小寫有別 [REQ][RES]。
- **Endpoint 主機**（只列文件上公開的）：
  - 訂單 sandbox endpoint：[RES] 寫 `https://tpi-cm-siteconn.preprod.siteminderlabs.com/reservation-gateway/services`，[QS] 寫 `https://tpi-cm-apac.preprod.siteminderlabs.com/siteconnect/services`。**兩頁不一致**，見 Q3。
  - WSDL 放在 `tpi-cm-siteconn.preprod.siteminderlabs.com/reservation-gateway/services/siteconnect_v1.1.0.wsdl`（另有 `_inlined` 版）[QS]。
  - 正式環境只寫「單一全球 endpoint」，**沒有公開主機名稱** [REQ][RES]。`SITEMINDER_HOSTS.production` 要等 SiteMinder 提供才能填。
- **SiteMinder 來源 IP**：pre-production 是 `52.13.134.140`、`34.213.128.113`、`35.164.250.223`。正式環境的 IP 上線時才提供 [REQ][AR]。
- **WAF**：SiteMinder 送來的請求 User-Agent 固定是 `Jakarta Commons-HttpClient/3.1`。文件特別寫到 **Cloudflare 預設會用 403 / error 1010 擋掉這個 User-Agent**，所以要對 SiteMinder 的 IP 加上這個 UA 的放行規則 [REQ]。
- **我們 endpoint 的回應時間**：理想是 1 秒內，可接受的平均是 1–2 秒。SiteMinder 在 20 秒逾時。文件要求立刻回 `<Success/>` 或 `<Errors>`，耗時的工作改成非同步處理 [REQ][FAQ]。[FAQ] 另外寫 ARI 的「initial timeout 15 秒」，和 20 秒不一致，見 Q11。
- **SiteMinder 對 ARI 的重試**：失敗時每 2 分鐘重試一次，新的更新會排隊等前一筆成功。長時間失敗可能會停用連線 [FAQ]。
- **我們推訂單的逾時和重試**：逾時設 **60 到 120 秒**。同一間飯店，**要等前一筆訂單的回應回來，才能送下一筆** [ERR-G]。重試的細節見第 5 節。

## 3. 推送訂單（OTA_HotelResNotifRQ）

### 3.1 訊息與狀態
- 訊息是 `OTA_HotelResNotifRQ`，用 `@ResStatus` 區分：新訂單 `Commit`、修改 `Modify`、取消 `Cancel` [RES]。
- 每則訊息只能放一筆訂單。多房訂單是同一則訊息裡放多個 `RoomStay` [RES]。
- 處理是原子性的：整筆成功或整筆失敗 [RES][FAQ]。
- 生命週期只能往前：Commit → Modify → Cancel。已取消的訂單不能再送任何訊息 [RES]。
- Modify 和 Cancel 都要帶**完整的訂單資料**，因為 SiteMinder 會整筆覆寫。`CreateDateTime` 放原始下訂時間，`LastModifyDateTime` 放這次修改或取消的時間 [RES]。
- 取消規則由飯店和通路自己處理，不經過 SiteMinder 的 API [RES]。

### 3.2 `UniqueID` 和確認號
- `HotelReservation/UniqueID Type="14" ID=...` 是我們的訂單編號，規則如下 [REQ][RES]：
  - 在所有飯店之間都必須唯一，永遠不能重用。
  - **已經用過的 ID 再送一次，SiteMinder 會忽略該訊息**。
  - 修改和取消都用同一個 ID。
  - **只能有英數字**，不能有特殊字元。建議至少 7 碼。
- **我們現在的代碼格式 `NK-XXXXXX` 有連字號，不符合規定**，見第 8 節。
- 成功回應裡，`ResGlobalInfo/HotelReservationIDs/HotelReservationID ResID_Type="14" @ResID_Value` 是「SiteMinder 建立的訂單識別碼」[RES]。這個值對應我們的 `smConfirmation`（**inferred**）。
- 修改和取消是用 UniqueID 指定訂單，文件沒有說要帶 SiteMinder 的確認號 [RES]。我們 interface 上「帶 smConfirmation」這條規則只能在本地檢查（**inferred**）。

### 3.3 欄位對照：`ChannelReservation`（lib/channel/types.ts）→ XML

XML 路徑都從 `OTA_HotelResNotifRQ/HotelReservations/HotelReservation` 開始，簡寫為 `HR`。

| 我們的欄位 | XML 路徑 | 依據與備註 |
|---|---|---|
| （新訂單／修改／取消） | `OTA_HotelResNotifRQ/@ResStatus` = Commit / Modify / Cancel | [RES] |
| （每次請求新產生） | `@EchoToken`（UUID）、`@TimeStamp`、`@Version="1.0"` | [RES][REQ] |
| （設定值） | `POS/Source/RequestorID @Type="22" @ID`；`POS/Source/BookingChannel @Primary="true"/CompanyName @Code`（同 ID）加名稱文字 | [RES] |
| `code` | `HR/UniqueID @Type="14" @ID`。必須只有英數字，所以 `NK-` 格式要轉換，見第 8 節 | [RES][REQ] |
| （訂單建立時間） | `HR/@CreateDateTime`：三種狀態都必填 | [RES] |
| （最後修改時間） | `HR/@LastModifyDateTime`：Modify 和 Cancel 必填 | [RES] |
| `smPropertyCode` | 每個 RoomStay 的 `RoomStay/BasicPropertyInfo @HotelCode`。`@HotelName` 可選。**HotelCode 是我們定的**，見第 8 節 | [RES][REQ] |
| `checkIn` / `checkOut` | `RoomStay/TimeSpan @Start` / `@End`（YYYY-MM-DD）。至少 1 晚，最多 749 天 | [RES] |
| `rooms[i]` | 每間房一個 `RoomStays/RoomStay`。`RoomRate @NumberOfUnits` 必須是 1 | [RES] |
| `rooms[i].smRoomCode` | `RoomStay/RoomTypes/RoomType @RoomTypeCode`，以及 `RoomRates/RoomRate @RoomTypeCode`。`RoomDescription @Name`：開了 SiteMinder 通知信才需要 | [RES] |
| `rooms[i].smRatePlanCode` | `RoomStay/RatePlans/RatePlan @RatePlanCode`，以及 `RoomRate @RatePlanCode`。`RatePlanDescription`：開了通知信才需要 | [RES] |
| `rooms[i].nightlyPrices[n]` | 每晚一個 `RoomRate/Rates/Rate @UnitMultiplier="1" @RateTimeUnit="Day" @EffectiveDate=第 n 晚 @ExpireDate=隔天`，價格放 `Base @AmountAfterTax @CurrencyCode`。連續同價的晚數可以合併成一個 Rate，`Base` 填那段期間的總額 | [RES]（範例和 [TC]「Daily Rates」）。含稅或未稅、要送 AfterTax 還是 BeforeTax 見 Q8 |
| （每間房的小計） | `RoomStay/Total @AmountAfterTax @CurrencyCode`：必填 | [RES] |
| （人數）**`ChannelReservation` 目前沒有這個欄位** | `RoomStay/GuestCounts/GuestCount @AgeQualifyingCode="10" @Count`：成人數**必填**。兒童用 `8` 加 `@Age`，嬰兒用 `7` | [RES]。資料表有 `reservations.adults/children`，但多房時怎麼分配到各房，文件沒有規定（Q9） |
| （幣別）**型別裡沒有** | 每個金額元素的 `@CurrencyCode`（ISO 4217），值取 `properties.currency`。金額是 decimal，我們存的是整數 | [RES] |
| `guest.firstName/lastName` | `HR/ResGuests/ResGuest/Profiles/ProfileInfo/Profile @ProfileType="1"/Customer/PersonName/GivenName`、`Surname`。另外在 `HR/ResGlobalInfo/Profiles/ProfileInfo/Profile @ProfileType="1"/Customer/PersonName` 放一份訂房人（Customer）。Customer 必填，ResGuest 至少一筆 | [RES] |
| `guest.email` | 上面兩處的 `Customer/Email` | [RES] |
| `guest.phone` | `Customer/Telephone @PhoneNumber`，最多 32 字元 | [RES] |
| （主要住客） | `ResGuest @PrimaryIndicator="1"`，可選加 `@ResGuestRPH`，再從 `RoomStay/ResGuestRPHs/ResGuestRPH @RPH` 連過去 | [RES] |
| `addons[]` | 整筆訂單層級：`HR/Services/Service @ServiceInventoryCode @Inclusive="true" @Quantity @ID`，金額放 `Price/Total @AmountAfterTax`，說明放 `Price/RateDescription/Text`（用 PMS 語言的名稱）。**不加 ServiceRPH**，所以只算進 `ResGlobalInfo/Total`，不算進 RoomStay 小計 | [RES]。Inclusive 必須是 true。代碼可以自訂（例如 `PARKING`），也可以參考 SiteMinder 的 Service and Extra Charge 表（我們沒有讀那張表） |
| `promoCode` | `RoomStay @PromotionCode`（行銷活動代碼，不是價格方案代碼） | [RES] |
| （折扣金額） | **沒有專門的折扣欄位**。折扣直接反映在每晚價格、RoomStay 小計和 `ResGlobalInfo/Total` 裡，再用 comment 說明（例如「早鳥 85 折」） | [RES] |
| `total` | `HR/ResGlobalInfo/Total @AmountAfterTax @CurrencyCode`：必填，包含所有房間和額外費用 | [RES] |
| `paidAmount` | `HR/ResGlobalInfo/DepositPayments/GuaranteePayment/AmountPercent @Amount @CurrencyCode`（只填金額，不填卡號，即「Deposit Only」範例） | [RES]。放在 ResGlobalInfo 底下是照 OTA 的結構推的，**inferred**。付款資料可以整段省略 [RES] |
| （特殊需求）**型別裡沒有** | `RoomStay/SpecialRequests/SpecialRequest @Name` / `Text`，或者 `RoomStay/Comments/Comment/Text`，或者整筆層級的 `ResGlobalInfo/Comments/Comment/Text`。comment 裡不可以放 PCI 資料 | [RES]。目前 `ChannelReservation` 沒有這個欄位 |
| （通路訂單參考號，選填） | `ResGlobalInfo/HotelReservationIDs/HotelReservationID @ResID_Type="14" @ResID_Value`，最多 64 字元 | [RES] |
| （信用卡） | **不送**。`Guarantee/PaymentCard` 是選填的 [RES]，而且依專案規則，卡號不進我們的系統 | |

元素順序參考 [RES] 的「Maximum Content XML」範例：
- `POS`
- `HotelReservations/HotelReservation`
  - `UniqueID`
  - `RoomStays`（每個 RoomStay 內依序是 RoomTypes、RatePlans、RoomRates、GuestCounts、TimeSpan、Total、BasicPropertyInfo、ServiceRPHs、ResGuestRPHs、Comments、SpecialRequests）
  - `Services`
  - `ResGuests`
  - `ResGlobalInfo`（HotelReservationIDs、Comments、Total、Guarantee/DepositPayments、Profiles）

另外，[RES] 的 Security header 範例把 namespace 寫成小寫的 `.../ota/2003/05`。我們一律用 `.../OTA/2003/05`（**inferred**：[REQ] 規定的是這個）。

### 3.4 回應的意義，以及和我們流程的衝突
- [RES] 原文要點：SiteMinder 沒有權力接受或拒絕訂單；RS 只確認訊息有沒有收到；而且（短引）SiteMinder "does not influence the booking process on your end"。
- [RES] FAQ 補充：`Success` 表示已接收並接受。之後沒有 pending 狀態，也**沒有任何查詢 endpoint 可以查訂單狀態**。SiteConnect 不會因為沒房、沒對應房價、價格方案不符而拒單。它只檢查 XML 格式、帳密和 HotelCode [RES][FAQ]。
- **和我們流程的衝突**（`lib/booking/confirm.ts`）：
  - 目前的做法：顧客付款後先等推送成功，才把訂單改成 `confirmed`。推送遇到不可重試的錯誤，或重試超過 `MAX_SYNC_ATTEMPTS` 次，就**退款並取消顧客的訂單**。
  - 文件的意思是：通道的回應不應該決定前台的訂房結果。這裡的錯誤只代表我們的訊息內容有問題，或 HotelCode、帳密有問題，和「有沒有房」無關。
  - 因為不合法的 XML 而把已付款的顧客退款，業主可能不想要。建議改為：本地確認訂單（庫存在我們這裡已經扣了）、通知顧客，推送放進持久化的佇列去重試，失敗時通知員工人工處理（**inferred**，要業主決定）。
- **`lookupReservation` 在 SiteMinder 上沒有對應的操作** [RES]。現在的設計（逾時後先查再推，conformance 規則「lookup 找得到 push 留下的資料」）沒辦法對真的 SiteMinder 實作：
  - adapter 只能固定回 `{ error, retryable }` 或 `{ found: false }`（**inferred**）。
  - 收斂只能靠「同一個 UniqueID 重送 Commit」。但重送時 SiteMinder 是回 Success、回 Error，還是只是靜默忽略，文件沒有寫（Q1）。
- **SiteMinder 不會因為取消而自動釋出房量**：除非飯店開了 Auto-Replenishment。房量以 SiteMinder 之後推回來的 `OTA_HotelAvailNotifRQ` 為準 [RES]。
- **超賣時 SiteMinder 照樣收單**，由飯店和通路自己處理 [RES]。

## 4. 接收 ARI

### 4.1 `OTA_HotelAvailNotifRQ`（可售數量和限制）[AR]
- **結構**：每則訊息是 `AvailStatusMessages @HotelCode` 加上多個 `AvailStatusMessage`。一則訊息只有**一間飯店、一個房型**，但可以有多個價格方案、多個日期區間 [AR][FAQ]。
- **日期**：`StatusApplicationControl @Start @End` 頭尾都包含（inclusive），另外帶 `@InvTypeCode` 和 `@RatePlanCode`。
- **可售數量**：`AvailStatusMessage @BookingLimit`，任何正整數都要接受，不可以自己設上限 [AR]。
  - 預設是房型層級，所有價格方案共用。這時候以 `InvTypeCode` 為準，忽略 `RatePlanCode` [AR]。
  - 如果飯店設成價格方案層級，就要用兩個代碼一起計算 [AR]。
- **Stop Sell**：`RestrictionStatus @Status="Close"|"Open"`，沒有 `@Restriction` 屬性時，就是整個房間關閉或開放。
  - 「Close 視為 0 房」只有在每個房型只有一個價格方案時才允許 [AR]。
- **CTA / CTD**：`RestrictionStatus @Restriction="Arrival"` 或 `"Departure"`，配上 `@Status` [AR]。
- **最短／最長住宿**：`LengthsOfStay/LengthOfStay @MinMaxMessageType`，值有四種：
  - 以入住日計算：`SetMinLOS`、`SetMaxLOS`。
  - 以整段住宿計算（Stay Through）：`SetForwardMinStay`、`SetForwardMaxStay`。支援 Through 的前提是也支援 on-arrival。
  - `@Time` 範圍是 1–9999。Min 一定會帶值，最小是 1，1 等於沒有限制。Max 沒帶 `Time` 代表**清除最長住宿限制** [AR]。
- **更新頻率**：每 2 分鐘一輪，只送有變動的組合，但會把那個組合的所有值一起送 [FAQ][AR]。
- **批次大小**：一則訊息最多 210 天（30 個日期元素 × 每段最長 7 天）。上限可以調高 [AR][FAQ]。
- **更新期間**：最遠 750 天，通常設定在 365–750 天。每天早上往後滾一天 [AR][FAQ]。
- **第一次連線**：SiteMinder 會連續推送全部的 ARI [FAQ]。
- **時區**：日期是飯店在 SiteMinder 設定的當地日期 [AR][REQ]。
- **不支援的限制類型**：仍然回 Success，只是忽略那幾個元素，不可以讓整則訊息失敗 [AR]。

### 4.2 `OTA_HotelRateAmountNotifRQ`（價格）[RATES]
- **結構**：`RateAmountMessages @HotelCode` 底下有多個 `RateAmountMessage`，同樣一則訊息只有一間飯店、一個房型。
- **日期與代碼**：`StatusApplicationControl @Start @End`（inclusive），帶 `@InvTypeCode` 和 `@RatePlanCode`。
- **價格**：放在 `Rates/Rate/BaseByGuestAmts/BaseByGuestAmt @AmountAfterTax @CurrencyCode [@NumberOfGuests] [@AgeQualifyingCode="10"]`。
  - SiteMinder **一律只送 `AmountAfterTax`**，但到底含不含稅由飯店決定，訊息裡沒有標記 [RATES]。
- **PDP**（每日價）：通常只有一個 BaseByGuestAmt。`NumberOfGuests="1"` 表示單人折扣，`≥2` 表示 Included Occupancy。加人費用放在 `AdditionalGuestAmounts/AdditionalGuestAmount @AgeQualifyingCode(10|8) @Amount`。
- **OBP**（依人數計價）：人數從 1 到 MaxOccupancy 各有一筆，每筆都必須帶 `NumberOfGuests`，最多 50 筆。
- **計價模式只能選一種**，而且套用到所有飯店 [QS][DC]。
- **方案說明**：`RateDescription/Text` 最多 255 字。
- **順序**：價格一定在可售數量和限制成功之後才送。可售數量失敗的話，價格更新會排隊 [RATES]。
- **幣別**：預設帶 `CurrencyCode`。只用單一幣別的通路可以申請關掉 [RATES]。
- **單人折扣造成負價時**：SiteMinder 會停止送那個組合的價格 [RATES]。

### 4.3 回應與錯誤格式
- **成功**：回對應的 RS（`OTA_HotelAvailNotifRS` / `OTA_HotelRateAmountNotifRS`），帶原本的 `EchoToken`、`TimeStamp`、`Version="1.0"`，內容是 `<Success/>`。SOAP Header 留空 [AR][RATES]。
- **錯誤**：放在同一個 RS 裡，格式是 `<Errors><Error Type=".." Code="..">描述</Error></Errors>`。
  - 應用層錯誤**不可以**改回 HTTP 錯誤碼。只有伺服器層級的問題才可以用 HTTP 5xx [ERR-G][FAQ]。
- **必要的錯誤**：描述文字必須**一字不差、大小寫一致**，因為 auto-disable 機制靠比對文字 [ERR-G]：

| 情況 | Type | Code | 描述（一字不差） | 用在哪些 RS |
|---|---|---|---|---|
| 帳密錯誤 | 4 | 448 | `Invalid Username and/or Password` | AvailRS、AvailNotifRS、RateAmountNotifRS |
| 飯店代碼錯誤 | 6 | 392 | `Hotel not found for HotelCode=XXXXXX` | 同上三種 |
| 房型代碼錯誤 | 12 | 402 | `Room type code not found for this hotel` | AvailNotifRS、RateAmountNotifRS |
| 價格方案代碼錯誤 | 12 | 249 | `Rate code not found for this hotel` | AvailNotifRS、RateAmountNotifRS |
| 包含人數不符（PDP 必做） | 12 | 137 | `Invalid included occupancy`（可加上 `: expecting N`） | RateAmountNotifRS |
| 成人數不符（OBP 必做） | 12 | 397 | `Invalid number of adults`（可加上 `: expecting N`） | RateAmountNotifRS |

- **Auto-disable**：
  - 回 392 → SiteMinder 會停用**整間飯店**的連線。
  - 回 402、249、137、397 → 只停用相關的房型或價格方案。
  - 停用後 SiteMinder 不再重試，並寄 email 通知飯店 [ERR-G]。

### 4.4 對照到我們的資料
- 訊息裡的 `HotelCode` 對到 `properties.smPropertyCode`，找不到就回 392。
- `InvTypeCode` 對到 `unit_types.smRoomCode`，找不到就回 402。
- `RatePlanCode` 對到 `rate_plans.smRatePlanCode`，找不到就回 249。

| SiteConnect | `AriUpdate`（lib/channel/types.ts） | 資料表欄位 | 備註 |
|---|---|---|---|
| `@Start..@End`（inclusive） | 展開成每天一筆 `date` | `*.date` | **inferred**：我們按日存，所以要展開區間 |
| `BookingLimit` | `available` | `inventory_daily.available`（以房型為單位） | 房型層級時忽略 RatePlanCode [AR]。現在的 `applyAriUpdates` 兩個代碼都要認得才會套用，**要修改**，見第 8 節 |
| `RestrictionStatus Status`（沒有 Restriction） | `stopSell` | `ari_daily.stop_sell` | Close 對應 true，Open 對應 false |
| `Restriction="Arrival"` | `closedToArrival` | `ari_daily.closed_to_arrival` | |
| `Restriction="Departure"` | `closedToDeparture` | `ari_daily.closed_to_departure` | |
| `SetMinLOS @Time` | `minStay` | `ari_daily.min_stay` | Time=1 等於沒有限制 |
| `SetMaxLOS @Time` / 沒帶 Time | **沒有欄位** | **沒有欄位** | 認證情境 [TC] 有測最長住宿。要新增欄位，或在認證時申請把它移除 [AR] |
| `SetForwardMinStay` / `SetForwardMaxStay` | **沒有欄位** | **沒有欄位** | 選用功能。不支援就回 Success 並忽略 [AR] |
| `BaseByGuestAmt @AmountAfterTax`（PDP，沒有 NumberOfGuests 的那一筆） | `price` | `ari_daily.price`（整數） | 收到 decimal 要換成整數，換算方式見 Q8。單人折扣和加人費用目前沒有欄位（**inferred**：選 PDP，不開這兩個功能） |
| `RateDescription/Text` | — | — | 選用 |
| 請求的 `@TimeStamp` | `sourceTs`（Task 4 計畫新增） | `*.source_ts`（計畫新增） | **inferred**：文件沒有序號機制。[FAQ] 只寫每間飯店的更新是單執行緒、只送最新版本。能不能拿 TimeStamp 判斷先後，見 Q5 |

- **未知代碼**：
  - 計畫原本寫「記錄下來、不套用、其他照常套用、回成功」，**和文件衝突**。文件**規定**要回 402 或 249 錯誤，SiteMinder 才會停用並通知飯店 [ERR-G]。
  - 一則訊息只有一個房型，所以房型代碼錯就整則回 402。
  - 同一則訊息裡有的價格方案代碼認得、有的不認得時，要不要先套用認得的部分再回 249？文件說訊息是原子性的 [AR]，但沒講這種情況（Q6）。在得到答案前，建議整則不套用、回 249（**inferred**）。
- **壞掉的 XML**：計畫要求回錯誤、一筆都不套用。文件沒有規定「XML 無法解析」時要回什麼碼（Q7）。
- **大小限制**：計畫設 1 MB 上限。一則最多 210 天、一個房型，PDP 格式不會超過 1 MB（**inferred**）。但 OBP 每筆可以到 50 個 BaseByGuestAmt，而且 SiteMinder 可以把批次調大，所以上限要保守（**inferred**）。
- **401 / 413**：計畫寫帳密錯回 HTTP 401。文件要求的是 SOAP 錯誤 Type 4 / Code 448（應用層錯誤）。HTTP 狀態碼文件沒寫，推測是 200（**inferred**，Q7）。超過大小上限屬於伺服器層級，可以回 HTTP 413（**inferred**）。
- **速度**：要在 1–2 秒內回應，20 秒是硬上限 [REQ]。一則 210 天、數個價格方案，大約幾百筆寫入，D1 分批寫入應該做得到（**inferred**）。如果做不到，就先存進 Cloudflare Queue 再回 Success。

### 4.5 Rooms and Rates（`OTA_HotelAvailRQ` → `OTA_HotelAvailRS`）[RR][QS]
- **請求**：`AvailRequestSegments/AvailRequestSegment AvailReqType="Room"/HotelSearchCriteria/Criterion/HotelRef @HotelCode`，root 帶 `AvailRatesOnly="true"`。
- **回應**：`<Success/>` 加上 `RoomStays/RoomStay`，**每個「房型＋價格方案」組合各一個 RoomStay**。每個 RoomStay 裡放：
  - `RoomTypes/RoomType @RoomTypeCode`，加上 `RoomDescription @Name` 和 `Text`。
  - `RatePlans/RatePlan @RatePlanCode`，加上 `RatePlanDescription @Name`。
  - 選 OBP 時，還要放 `Occupancy @AgeQualifyingCode="10" @MaxOccupancy`。
- **規則**：
  - 代碼和名稱都要唯一，「房型名稱＋方案名稱」的組合也要唯一。
  - 只列目前上架中的房型和方案。
  - 測試時要求至少 2 個房型，每個房型至少 2 個方案 [QS]。
- **可選旗標**：`NO_UPDATES`、`NO_AVAILABILITY`、`NO_RATES` [RR]。
- **代碼不能隨便改**：改了 RoomTypeCode 或 RatePlanCode，飯店的對應就會斷掉，要重新設定 [RR]。

## 5. 錯誤碼與我們的分類

### 5.1 我們推訂單時，SiteMinder 的回應

| 回應 | 文件怎麼說 | 我們的分類 |
|---|---|---|
| `<Success/>`，並帶 `HotelReservationID @ResID_Value` | 已接收並接受 [RES] | ok。`smConfirmation` 取 ResID_Value |
| RS 裡有 `<Errors>`，例如 Type 4「Invalid Username and/or Password for ABC」、Type 6「Hotel not found for HotelCode=…」、Type 6「No HotelCodes were found…」、Type 10「Node X must exist」 | 資料有問題，修好之前不可以重試，要從佇列移除 [ERR-G] | **不可重試** |
| HTTP 4xx（400、401、403、404、405、406、409、415） | 重送還是會失敗，修正後才能再送 [ERR-G][HTTP] | **不可重試**。409 代表重複訂單，處理方式見 Q1 |
| HTTP 500、502、503、504 | 通常可以恢復。退避間隔 5 → 10 → 20 → 40 秒，之後每分鐘一次，至少持續 30 分鐘，之後聯絡 SiteMinder 的 Application Operations [ERR-G][HTTP] | **可重試** |
| HTTP 501、505 | 不要重試 [HTTP] | **不可重試** |
| 逾時（我們這邊 60–120 秒）或網路錯誤 | 文件只說要設 60–120 秒的逾時，並要求排隊重試 [ERR-G] | **可重試**（**inferred**）。結果不明，只能靠重送同一個 UniqueID 收斂（Q1） |

- **SOAP Fault**：[RES] 說帳密錯會回「SOAP fault with appropriate error code」，但 [ERR-G] 的範例是 `OTA_HotelResNotifRS/Errors`。兩種都要能解析，都歸為不可重試（**inferred**，Q2）。
- **重試間隔不一致**：[REQ] 建議 0、5、15、30、60 秒，共 5 次後告警。[ERR-G] 對 5xx 建議至少持續 30 分鐘。
- **我們現在的設定**：每 5 分鐘一次，共 6 次，大約 30 分鐘。總長度大致符合，但第一次重試太慢（**inferred**）。

### 5.2 錯誤類型和錯誤碼參考
- EWT 類型 [EWT]：1 Unknown、2 No implementation、3 Biz rule、4 Authentication、5 Authentication timeout、6 Authorization、7 Protocol violation、8 Transaction model、9 Authentical model、10 Required field missing、11 Advisory、12 Processing exception、13 Application error。
- ERR 錯誤碼 [EC]：187 System currently unavailable、448、450 Unable to process、137、249、321 Required field missing、375 Hotel not active、392、397、402、436 Rate does not exist、783 `Combination of room code and rate code not found for this hotel`、842 Rate not loaded。
- 用 Type 或 Code 判斷能不能重試：文件只說 RS 裡有 Error 就不要重試 [ERR-G]。187「System currently unavailable」看起來像暫時性錯誤，但文件沒有說它可以重試（Q2）。

### 5.3 我們回給 SiteMinder 的錯誤
見 4.3 的表格。另外，伺服器層級的問題（例如 D1 掛掉）可以回 HTTP 5xx，SiteMinder 會每 2 分鐘重試一次 [ERR-G][FAQ]。

## 6. 上線與認證步驟

**整體流程** [IP][QS][BC]：
1. 先簽合作協議，從 https://www.siteminder.com/integrations/apply-now/ 申請。簽約後 Partner Integrations 團隊會主動聯絡。
2. 啟動，約 1–3 天。
3. 開發，約 4–6 週。
4. 認證，約 1 週。
5. 正式環境，約 1 週。SiteConnect **一定要先接一間 pilot 飯店**。
6. 上線。全程大約 60 天 [FAQ]。

**我們（通路）要交給 SiteMinder 的** [QS][FAQ]：
- 我們的 Inventory SOAP endpoint（HTTPS）。可以只給一個 URI，也可以分成兩個：Rooms and Rates 一個、ARI 一個 [REQ]。
- 讓 SiteMinder 呼叫我們用的帳號和密碼。
- 測試飯店的 `HotelCode`（**由我們定**）。
- 計價模式：PDP 或 OBP，只能選一個。
- 如果我們沒辦法自己寄訂單通知信給飯店，要另外申請 SiteMinder 代寄 [API][RES]。

**SiteMinder 會給我們的** [QS][FAQ]：
- 訂單 SOAP endpoint，以及我們呼叫它用的帳號和密碼。
- `RequestorID`（channel code）。
- 一個測試平台帳號：裡面有預先建好的房型和方案，有可以推送 ARI 的模擬器，也能查看我們推過去的訂單。
- WSDL 檔，以及 Postman workspace（https://www.postman.com/siteminder-apis/siteconnect/overview）。

**認證情境** [TC]：
1. Rooms and Rates：取回房型和方案清單，並完成對應設定。
2. Bulk Data Update：推送整個更新期間（例如 750 天）的可售數量、價格、Stop Sell、CTA、CTD、最短住宿、最長住宿。
3. 頁面上沒有這一個（原文直接從 2 跳到 4）。
4. Targeted Data Update：小範圍的單點更新。
5. 訂單相關：
   - 違反可售數量或限制時要擋單（6 種情況）。
   - 每日價格的三種寫法。
   - 多房訂單。
   - 修改和取消。
6. Error Handling：在 Postman collection 裡跑「SiteConnect - Error Handling」。

**必要和建議功能** [FAQ][BC]：
- 必要：Rooms and Rates、可售數量、Stop Sell、價格、新訂單。
- 強烈建議：最短和最長住宿、CTA、CTD、訂單修改和取消。

**上線前檢查** [REQ][DC]：
- 密碼符合政策。
- EchoToken 用 UUID。
- 送出的 XML 有 minify。
- 回應時間在 2 秒以內。
- 有失敗佇列和重試機制。
- 用 750 天的資料量做過負載測試。
- 時區處理正確。

**業主（飯店）要做的**：
- 在 SiteMinder 平台把我們的通路加入連線、完成房型和方案對應，並在 Channel Settings 啟用通路 [DC]。
- 確認飯店時區的設定 [REQ]。
- 決定要不要開 Auto-Replenishment [RES]。
- 確認價格含不含稅 [RATES]。
- 擔任 pilot 飯店 [IP]。

**文件沒寫，但我們推測要準備的**（**inferred**）：
- 業主或我們要先成為 SiteMinder 的合作夥伴才能開始，因為 SiteConnect 是給「通路」用的。
- 決定由誰當簽約的通路方，見 Q12。

## 7. 待確認問題（可以直接寄給 SiteMinder）

1. **Q1（重送 Commit）** If we resend `OTA_HotelResNotifRQ ResStatus="Commit"` with a `UniqueID` that SiteMinder already accepted (e.g. after our side timed out), what exactly does the RS contain: `Success` with the original `HotelReservationID ResID_Value`, an `Error` (which Type/Code/text), or HTTP 409? Is the original reservation left unchanged?
   - 中文：逾時後重送同一個 UniqueID，SiteMinder 會怎麼回？這決定了我們的 idempotency 和 lookup 要怎麼設計。
2. **Q2（錯誤分類）** Is any `OTA_HotelResNotifRS` error ever retryable (for example Code 187 "System currently unavailable" or 450)? When credentials are wrong, do you return a SOAP Fault or `OTA_HotelResNotifRS/Errors`, and with which HTTP status?
   - 中文：有沒有可以重試的業務錯誤碼？帳密錯誤時回什麼格式？
3. **Q3（Endpoint）** Which is the correct pre-production reservation endpoint: `https://tpi-cm-siteconn.preprod.siteminderlabs.com/reservation-gateway/services` (Reservations page) or `https://tpi-cm-apac.preprod.siteminderlabs.com/siteconnect/services` (Quick Start)? What is the production global endpoint hostname?
   - 中文：兩頁的 sandbox 主機不一樣，正式主機也沒有公開。這些要填進 `SITEMINDER_HOSTS`。
4. **Q4（UniqueID 格式）** Our booking reference is `NK-` followed by 6 characters. Since `UniqueID ID` must be alphanumeric only, may we send it without the hyphen (8 characters, e.g. `NKAB12CD`)? Is there a maximum length? Will the hotel/PMS see this ID or the `HotelReservationID`?
   - 中文：代碼格式要不要改？最長可以幾碼？飯店端看到的是哪個號碼？
5. **Q5（ARI 順序）** Can the `TimeStamp` of `OTA_HotelAvailNotifRQ` / `OTA_HotelRateAmountNotifRQ` be relied on to order messages for the same hotel/room/rate/date? Can two messages for the same hotel ever be in flight concurrently or arrive out of order, including during your 2-minute retries?
   - 中文：可不可以用 TimeStamp 判斷新舊？會不會亂序？
6. **Q6（未知代碼與部分套用）** When one `OTA_HotelAvailNotifRQ` contains several rate plans and only one `RatePlanCode` is unknown to us, should we reject the whole message with Code 249, or apply the known rate plans and still return 249? Will 249 disable only that rate plan?
   - 中文：同一則訊息裡只有一個方案代碼不認得時，要整則拒收還是部分套用？
7. **Q7（無法解析的請求）** What error should we return for XML we cannot parse or that fails OTA schema validation (Type 10 / Code 321?), and what HTTP status should accompany SOAP error responses (200?)? Will such an error trigger auto-disable?
   - 中文：XML 壞掉時回什麼錯誤？SOAP 錯誤回應要配哪個 HTTP 狀態碼？會不會觸發 auto-disable？
8. **Q8（幣別、稅、小數）** For a TWD property with tax-inclusive integer prices: should reservations carry `AmountAfterTax` only, with no `Taxes` element? Will rate pushes for TWD always be whole numbers, and may we ask for `CurrencyCode` to be disabled?
   - 中文：台幣、含稅、整數價格要怎麼送、怎麼收？
9. **Q9（多房人數）** For multi-room bookings, `GuestCounts` is per `RoomStay`. If our booking stores only a total of adults and children, how should we split them across rooms? Is the same `ResGuest` acceptable for every room?
   - 中文：多房訂單只知道總人數時，人數要怎麼分配到各房？
10. **Q10（取消與修改的限制）** May a `Modify` change the room type or rate plan, add or remove a room, or change dates (as in certification "Booking 05")? Is a `Cancel` for a reservation whose Commit you never received rejected or ignored?
    - 中文：修改可以改到什麼程度？SiteMinder 沒收到 Commit 就直接送 Cancel 會怎樣？
11. **Q11（ARI 逾時）** Is your timeout for our ARI endpoint 15 seconds (FAQ) or 20 seconds (Integration Requirements)? What is the default update period configured for a new channel (365 or 750 days)?
    - 中文：逾時到底是 15 秒還是 20 秒？預設更新期間是多少？
12. **Q12（合作身份）** Our website is the direct booking engine of a single hostel. Is SiteConnect (and a channel partnership agreement) the right product for a single-property direct booking engine, or do you require another arrangement? Who signs: the hotel or the developer?
    - 中文：單一館的官網直訂適不適合走 SiteConnect？合約由業主簽還是開發方簽？
13. **Q13（最長住宿和 Stay Through）** Can Max LOS and Stay Through be excluded from our certification scope if not implemented at launch?
    - 中文：最長住宿和 Stay Through 能不能先不做？
14. **Q14（正式環境 IP）** Please provide the production source IPs for ARI pushes, and confirm the User-Agent stays `Jakarta Commons-HttpClient/3.1`.
    - 中文：請提供正式環境的來源 IP，並確認 User-Agent 不會變。
15. **Q15（訂單通知信）** If we enable SiteMinder's reservation notification email, which fields are required (room and rate names, HotelName)? Is it needed when the hotel uses SiteMinder's PMS connection?
    - 中文：開 SiteMinder 代寄通知信時，要多送哪些欄位？有接 PMS 的話還需要嗎？

## 8. 影響設計的發現（給 Task 3、4 實作者）

1. **房型、方案、飯店代碼由我們定，不是 SiteMinder 發給我們。**
   - 計畫的前置條件寫「SiteMinder 給 property code、room type code、rate plan code」，這和文件相反。SiteConnect 是 SiteMinder 來拉我們的清單（`OTA_HotelAvailRQ`），再由飯店在 SiteMinder 上對應 [RR][REQ]。
   - `smPropertyCode`、`smRoomCode`、`smRatePlanCode` 要由我們產生，一旦用了就不能改。
2. **缺少一支必要的 endpoint**：Rooms and Rates（`OTA_HotelAvailRQ`）。它可以和 ARI 共用同一個 URI，用 root 元素分辨訊息種類 [REQ]。
3. **沒有查詢訂單的 API**，所以 `lookupReservation` 和「逾時後先查再推」的做法在 SiteMinder 上不成立 [RES]。收斂只能靠重送同一個 UniqueID，而重送時的回應要等 Q1 確認。
4. **推送回應不應該決定顧客的訂房結果** [RES]。現在推送失敗就退款的流程，建議改成本地確認加持久化推送佇列，要業主決定。
5. **UniqueID 只能有英數字**：`NK-XXXXXX` 不符合，要定一個轉換規則（Q4），並同步調整 conformance 和 mock。
6. **取消後不能再送任何訊息，已用過的 ID 再送會被忽略。** mock 現在「同一個 code 重新 push 會恢復成 active」的行為和 SiteMinder 不一致。
7. **同一間飯店一次只能有一筆訂單訊息在處理中** [ERR-G]。我們的 lease 是以訂單為單位，要改成以飯店為單位排隊。
8. **`ChannelReservation` 少了必要欄位**：
   - 人數（GuestCounts，必填）
   - 幣別
   - CreateDateTime 和 LastModifyDateTime
   - 房型和方案名稱（開通知信時需要）
   - 特殊需求和備註
   - 訂房人（Customer）
9. **未知代碼要回錯誤**（402 / 249），不能吞掉後回 Success，因為 SiteMinder 的 auto-disable 機制靠這些錯誤運作 [ERR-G]。錯誤描述要一字不差。
10. **ARI 是日期區間**（inclusive），要展開成每天一筆。可售數量是房型層級，不需要價格方案代碼，`applyAriUpdates` 現在要求兩個代碼都要認得，要修改。另外有最長住宿和 Stay Through 兩種限制，我們沒有對應欄位。
11. **Cloudflare 預設會擋 SiteMinder 的 User-Agent**（403 / 1010）。上線前要設定 WAF 放行規則 [REQ]，這是 DEPLOY 檢查清單上要加的一步。
12. **逾時設定**：我們推訂單的逾時要在 60–120 秒之間 [ERR-G]，現在的 `CHANNEL_MAX_TIMEOUT_MS` = 60 秒，剛好在下限。SiteMinder 呼叫我們時，我們要在 20 秒內回應，目標是 1–2 秒 [REQ]。
13. **計價模式只能選一種**：`ari_daily.price` 是單一價格，選 PDP 最自然（**inferred**）。
