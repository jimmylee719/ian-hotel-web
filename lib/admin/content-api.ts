import { UnsupportedMediaTypeError } from "./auth";
import { actionError } from "./action-messages";
import type { ContentError, ContentItemPatch, UnitTypePatch } from "./content";

/** Shared by the /api/admin/content/* routes: request bodies in, content errors out. */

export const FIELD_LABELS: Record<string, string> = {
  name: "名稱", description: "介紹", bedType: "床型", amenities: "設備", sizeSqm: "坪數（平方公尺）",
  maxAdults: "成人上限", maxOccupancy: "入住上限", sortOrder: "排序", active: "上架", images: "照片",
  slug: "網址代稱", title: "標題", body: "內文", publishedAt: "發布時間",
  price: "價格", unit: "計價單位", code: "折扣碼", kind: "折扣類型", value: "折扣數值", validFrom: "開始日", validTo: "結束日",
  maxUses: "使用上限", cancelPolicy: "取消規則", paymentMode: "付款方式", depositPct: "訂金比例", includesBreakfast: "含早餐",
  directOnly: "官網限定", address: "地址", phone: "電話", email: "Email", checkInTime: "入住時間", checkOutTime: "退房時間",
  directions: "交通說明",
};

const UNIT_TYPE_KEYS = ["name", "description", "bedType", "amenities", "sizeSqm", "maxAdults", "maxOccupancy", "sortOrder", "active", "images"] as const;
const ITEM_KEYS = ["slug", "title", "body", "publishedAt", "sortOrder"] as const;

const only = (b: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => k in b).map((k) => [k, b[k]]));

/**
 * The JSON object body, or null. Values are type-checked by lib/admin/content. The body must be sent as
 * `application/json`: anything else (e.g. the `text/plain` a cross-site form can post without a preflight)
 * throws UnsupportedMediaTypeError, which withAdmin answers with 415. Every admin route that reads JSON uses this.
 */
export async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const type = (req.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new UnsupportedMediaTypeError();
  const b = await req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

export const unitTypePatchOf = (b: Record<string, unknown>) => only(b, UNIT_TYPE_KEYS) as UnitTypePatch;
export const itemPatchOf = (b: Record<string, unknown>) => only(b, ITEM_KEYS) as ContentItemPatch;

export function contentError(r: ContentError): Response {
  switch (r.error) {
    case "I18N_INCOMPLETE":
      return actionError("I18N_INCOMPLETE", undefined, { field: r.field, message: `「${FIELD_LABELS[r.field] ?? r.field}」四種語言都要填寫，不能留空。` });
    case "INVALID_INPUT":
      return actionError("INVALID_FIELD", undefined, { field: r.field, message: `「${FIELD_LABELS[r.field] ?? r.field}」的格式不正確。` });
    case "IMAGE_NOT_FOUND":
      return actionError("IMAGE_NOT_FOUND", undefined, { key: r.key });
    default:
      return actionError(r.error);
  }
}

export const ok = (body: unknown = { ok: true }) => Response.json(body, { headers: { "Cache-Control": "no-store" } });
