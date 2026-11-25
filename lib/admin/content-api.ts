import { actionError } from "./action-messages";
import type { ContentError, ContentItemPatch, UnitTypePatch } from "./content";

/** Shared by the /api/admin/content/* routes: request bodies in, content errors out. */

export const FIELD_LABELS: Record<string, string> = {
  name: "名稱", description: "介紹", bedType: "床型", amenities: "設備", sizeSqm: "坪數（平方公尺）",
  maxAdults: "成人上限", maxOccupancy: "入住上限", sortOrder: "排序", active: "上架", images: "照片",
  slug: "網址代稱", title: "標題", body: "內文", publishedAt: "發布時間",
};

const UNIT_TYPE_KEYS = ["name", "description", "bedType", "amenities", "sizeSqm", "maxAdults", "maxOccupancy", "sortOrder", "active", "images"] as const;
const ITEM_KEYS = ["slug", "title", "body", "publishedAt", "sortOrder"] as const;

const only = (b: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => k in b).map((k) => [k, b[k]]));

/** The JSON object body, or null. Values are type-checked by lib/admin/content. */
export async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
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
