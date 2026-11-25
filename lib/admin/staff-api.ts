import { actionError } from "./action-messages";
import type { StaffError } from "./staff";

const FIELD_LABELS: Record<string, string> = { email: "Email", name: "姓名", role: "角色", propertyIds: "館別", active: "啟用" };

/** The admin API's answer to a failed staff write. */
export function staffError(r: StaffError): Response {
  if (r.error === "INVALID_INPUT")
    return actionError("INVALID_FIELD", undefined, { field: r.field, message: `「${FIELD_LABELS[r.field] ?? r.field}」的格式不正確。` });
  return actionError(r.error);
}
