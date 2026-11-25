/** What the admin API answers for each action error: an HTTP status and a message staff can act on. */
export const PAYMENTS_OFF_MESSAGE = "線上金流未設定，無法執行退款";

const MESSAGES: Record<string, [status: number, message: string]> = {
  NOT_FOUND: [404, "找不到這筆資料。"],
  FORBIDDEN: [403, "你沒有權限執行這個操作。"],
  REASON_REQUIRED: [400, "請填寫原因。"],
  INVALID_OVERRIDE: [400, "退款金額必須是 0 以上的整數。"],
  OVERRIDE_EXCEEDS_PAID: [400, "退款金額不能超過已收（淨額）。"],
  NOT_CANCELLABLE: [409, "這筆訂單目前不能取消（可能尚未付款、已在處理中，或已取消）。"],
  REFUND_FAILED: [502, "退款沒有完成，已通知管理者，請到退款對帳頁確認。"],
  PAYMENTS_UNAVAILABLE: [503, PAYMENTS_OFF_MESSAGE],
  ALREADY_RESOLVED: [409, "這筆退款已經處理過了。"],
  NOT_FAILED: [409, "只有失敗的退款可以重試。"],
  PROVIDER_REF_REQUIRED: [400, "請填寫銀行或金流的退款交易編號。"],
  DUPLICATE_PROVIDER_REF: [409, "這個交易編號已經用在另一筆紀錄上。"],
  ALREADY_SENT: [409, "這封信已經寄出，不需要重寄。"],
  BAD_REQUEST: [400, "請求格式不正確。"],
  INVALID_AMOUNT: [400, "收款金額必須是大於 0 的整數。"],
  INVALID_LAST4: [400, "卡號末四碼必須是 4 位數字（刷卡機收款必填）。"],
  AUTH_CODE_REQUIRED: [400, "刷卡機收款請填寫授權碼。"],
  OVERPAY: [409, "收款金額不能超過待收金額。"],
  NOT_PAYABLE: [409, "只有已確認的訂單可以登錄櫃檯收款。"],
  NOT_SAME_DAY: [409, "只能作廢今天登錄的櫃檯收款。"],
  CANCEL_IN_PROGRESS: [409, "這筆訂單正在取消（或有退款待確認），暫時不能登錄或作廢櫃檯收款。"],
  NOT_VOIDABLE: [409, "這筆訂單已經結案（例如已取消），不能作廢收款。"],
  INVALID_AUTH_CODE: [400, "授權碼只能是 1 到 12 個英文字母或數字。"],
  LOOKS_LIKE_CARD_NUMBER: [400, "授權碼或備註看起來像完整卡號，請不要輸入卡號。"],
  ALREADY_VOIDED: [409, "這筆收款已經作廢了。"],
  INVALID_INPUT: [400, "日期或人數不正確（退房日要晚於入住日，入住日不能是過去，成人至少 1 位且不少於間數）。"],
  NOT_MODIFIABLE: [409, "這筆訂單目前不能修改（只有入住日以前、已確認、沒有在取消，也沒有其他修改在處理中的訂單可以修改）。"],
  NOT_AVAILABLE: [409, "新的日期或房型沒有空房。"],
  PRICE_CHANGED: [409, "價格在試算後變動了，請重新試算再確認。"],
  CONFLICT: [409, "這筆訂單剛被其他人修改過（或剛登錄了櫃檯收款），請重新試算後再試。"],
  EXCEEDS_DESK_DUE: [409, "退款金額不能超過櫃檯待退款金額。"],
  EXCEEDS_RECEIVED: [409, "退款金額超過這筆訂單目前的已收（淨額），請先確認收款紀錄。"],
  DESK_DUE_OUTSTANDING: [409, "櫃檯還有應退給旅客的款項，請先登錄櫃檯退款（或重新修改／取消訂單）後再作廢收款。"],
  MODIFICATION_REFUND_PENDING: [409, "這筆訂單有修改產生的退款尚未完成，請先到退款對帳頁（/admin/refunds）處理後再取消。"],
};

/** Messages for an error's `detail`, when it says more than the code. */
const DETAIL_MESSAGES: Record<string, string> = {
  OTA_BOOKING: "這是 OTA 通路的訂單，請到 OTA 或 SiteMinder 修改。",
};

/** The JSON error response for `code`, `{ error, message }` (plus `detail` when given). */
export function actionError(code: string, detail?: string): Response {
  const [status, fallback] = MESSAGES[code] ?? [500, "操作失敗，請再試一次。"];
  const message = (detail && DETAIL_MESSAGES[detail]) || fallback;
  return Response.json({ error: code, message, ...(detail ? { detail } : {}) }, { status, headers: { "Cache-Control": "no-store" } });
}
