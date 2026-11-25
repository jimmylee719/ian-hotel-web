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
};

/** The JSON error response for `code`, `{ error, message }`. */
export function actionError(code: string): Response {
  const [status, message] = MESSAGES[code] ?? [500, "操作失敗，請再試一次。"];
  return Response.json({ error: code, message }, { status, headers: { "Cache-Control": "no-store" } });
}
