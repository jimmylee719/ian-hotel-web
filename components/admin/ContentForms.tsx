"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import type { I18n } from "@/lib/db/schema";
import { ConfirmDialog } from "./ConfirmDialog";
import { I18nField, i18nComplete } from "./I18nField";
import { PhotoManager } from "./PhotoManager";
import { Toast } from "./Toast";

/** Send JSON to an admin content route; a failed answer throws its `message`. */
export async function send<T>(method: "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => null)) as ({ message?: string } & T) | null;
  if (!res.ok || !json) throw new Error(json?.message ?? "存檔失敗，請再試一次");
  return json;
}

export function useToast() {
  const [toast, setToast] = useState<{ text: string; kind: "success" | "error" } | null>(null);
  const close = useCallback(() => setToast(null), []);
  return {
    ok: (text: string) => setToast({ text, kind: "success" }),
    fail: (e: unknown) => setToast({ text: e instanceof Error ? e.message : "存檔失敗", kind: "error" }),
    view: <Toast message={toast?.text ?? null} kind={toast?.kind} onClose={close} />,
  };
}

export type RoomFormValue = {
  id: string; slug: string; name: I18n; description: I18n; bedType: I18n; amenities: string[]; sizeSqm: number | null;
  maxAdults: number; maxOccupancy: number; sortOrder: number; active: boolean; images: string[];
};

/** 房型: four-language text, numbers, amenities and photos; saves everything in one PATCH. */
export function RoomForm({ room }: { room: RoomFormValue }) {
  const router = useRouter();
  const toast = useToast();
  const [v, setV] = useState(room);
  const [amenities, setAmenities] = useState(room.amenities.join("\n"));
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof RoomFormValue>(k: K) => (x: RoomFormValue[K]) => setV((s) => ({ ...s, [k]: x }));
  const num = (k: "maxAdults" | "maxOccupancy" | "sortOrder") => (e: { target: { value: string } }) => set(k)(Number(e.target.value));
  const complete = i18nComplete(v.name) && i18nComplete(v.description) && i18nComplete(v.bedType);

  async function save() {
    setBusy(true);
    try {
      await send("PATCH", `/api/admin/content/rooms/${encodeURIComponent(v.id)}`, {
        name: v.name, description: v.description, bedType: v.bedType, sizeSqm: v.sizeSqm, maxAdults: v.maxAdults,
        maxOccupancy: v.maxOccupancy, sortOrder: v.sortOrder, active: v.active, images: v.images,
        amenities: amenities.split("\n").map((a) => a.trim()).filter(Boolean),
      });
      toast.ok("已儲存，公開頁面已更新");
      router.refresh();
    } catch (e) {
      toast.fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="adm-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <I18nField label="名稱" value={v.name} onChange={set("name")} />
      <I18nField label="床型" value={v.bedType} onChange={set("bedType")} />
      <I18nField label="介紹" value={v.description} onChange={set("description")} multiline rows={10} />
      <div className="adm-form-row">
        <label>坪數（平方公尺，可留空）
          <input type="number" inputMode="numeric" min={1} step={1} value={v.sizeSqm ?? ""}
            onChange={(e) => set("sizeSqm")(e.target.value === "" ? null : Number(e.target.value))} />
        </label>
        <label>成人上限
          <input type="number" inputMode="numeric" min={1} step={1} value={v.maxAdults} onChange={num("maxAdults")} />
        </label>
        <label>入住上限
          <input type="number" inputMode="numeric" min={1} step={1} value={v.maxOccupancy} onChange={num("maxOccupancy")} />
        </label>
        <label>排序
          <input type="number" inputMode="numeric" step={1} value={v.sortOrder} onChange={num("sortOrder")} />
        </label>
      </div>
      <label>設備（一行一項，例如 wifi、bathtub）
        <textarea rows={5} value={amenities} onChange={(e) => setAmenities(e.target.value)} />
      </label>
      <label className="adm-check">
        <input type="checkbox" checked={v.active} onChange={(e) => set("active")(e.target.checked)} /> 上架（取消勾選後公開頁面不再顯示這個房型）
      </label>
      <fieldset className="adm-i18n">
        <legend>照片</legend>
        <PhotoManager images={v.images} onChange={set("images")} unitTypeId={v.id} />
      </fieldset>
      <div className="adm-actions">
        <button type="submit" className="adm-btn adm-btn-primary" disabled={busy || !complete}>{busy ? "儲存中…" : "儲存"}</button>
        {!complete ? <span className="adm-form-error">四種語言都填好才能存檔（有紅點的分頁還沒填）。</span> : null}
      </div>
      {toast.view}
    </form>
  );
}

export type ContentKind = "news" | "faqs" | "pages";
export type ContentItemValue = { id: string; slug: string; title: I18n; body: I18n; publishedAt: number | null; sortOrder: number };

const KIND_LABEL: Record<ContentKind, string> = { news: "消息", faqs: "FAQ", pages: "頁面" };
const TITLE_LABEL: Record<ContentKind, string> = { news: "標題", faqs: "問題", pages: "標題" };
const BODY_LABEL: Record<ContentKind, string> = { news: "內文", faqs: "回答", pages: "內文" };
const empty = (): I18n => ({ "zh-TW": "", en: "", ja: "", ko: "" });

const taipeiDate = (ms: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(ms);
const fromTaipeiDate = (d: string) => Date.parse(`${d}T00:00:00+08:00`);

/**
 * A news item, FAQ or content page: title and body in four languages, slug, order and whether it is public.
 * News also has a publish date. Without `item` it creates one. 下架 (the admin's delete) unpublishes it.
 */
export function ContentItemForm({
  kind, item, slugEditable = true, afterCreate,
}: { kind: ContentKind; item?: ContentItemValue; slugEditable?: boolean; afterCreate?: "list" | "edit" }) {
  const router = useRouter();
  const toast = useToast();
  const [v, setV] = useState<Omit<ContentItemValue, "id">>(
    item ?? { slug: "", title: empty(), body: empty(), publishedAt: null, sortOrder: 0 });
  const [published, setPublished] = useState(item ? item.publishedAt !== null : true);
  const [date, setDate] = useState(taipeiDate(item?.publishedAt ?? Date.now()));
  const [busy, setBusy] = useState(false);
  const complete = i18nComplete(v.title) && i18nComplete(v.body) && v.slug.trim() !== "";
  const base = `/api/admin/content/${kind}`;

  function publishedAt(): number | null {
    if (!published) return null;
    if (kind === "news") return Number.isNaN(fromTaipeiDate(date)) ? Date.now() : fromTaipeiDate(date);
    return item?.publishedAt ?? Date.now();
  }

  async function save() {
    setBusy(true);
    try {
      const body = { ...v, slug: v.slug.trim(), publishedAt: publishedAt() };
      if (item) {
        await send("PATCH", `${base}/${encodeURIComponent(item.id)}`, body);
        toast.ok(published ? "已儲存，公開頁面已更新" : "已儲存（未公開）");
        router.refresh();
      } else {
        const r = await send<{ id: string }>("POST", base, body);
        if (afterCreate === "edit") router.push(`/admin/content/${kind}/${encodeURIComponent(r.id)}`);
        else {
          setV({ slug: "", title: empty(), body: empty(), publishedAt: null, sortOrder: 0 });
          toast.ok(`已新增${KIND_LABEL[kind]}`);
          router.refresh();
        }
      }
    } catch (e) {
      toast.fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function unpublish() {
    if (!item) return;
    await send("DELETE", `${base}/${encodeURIComponent(item.id)}`);
    setPublished(false);
    toast.ok(`已下架，公開頁面不再顯示這則${KIND_LABEL[kind]}`);
    router.refresh();
  }

  return (
    <form className="adm-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <I18nField label={TITLE_LABEL[kind]} value={v.title} onChange={(title) => setV((s) => ({ ...s, title }))} multiline={kind === "faqs"} rows={2} />
      <I18nField label={BODY_LABEL[kind]} value={v.body} onChange={(body) => setV((s) => ({ ...s, body }))} multiline rows={kind === "faqs" ? 5 : 14} />
      <div className="adm-form-row">
        <label>網址代稱（小寫英數與 -）
          <input value={v.slug} required pattern="[a-z0-9][a-z0-9\-]{0,79}" disabled={!slugEditable}
            onChange={(e) => setV((s) => ({ ...s, slug: e.target.value }))} />
        </label>
        <label>排序
          <input type="number" inputMode="numeric" step={1} value={v.sortOrder} onChange={(e) => setV((s) => ({ ...s, sortOrder: Number(e.target.value) }))} />
        </label>
        {kind === "news" ? (
          <label>發布日期
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        ) : null}
      </div>
      <label className="adm-check">
        <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} /> 公開
      </label>
      <div className="adm-actions">
        <button type="submit" className="adm-btn adm-btn-primary" disabled={busy || !complete}>{busy ? "儲存中…" : item ? "儲存" : `新增${KIND_LABEL[kind]}`}</button>
        {item && item.publishedAt !== null ? (
          <ConfirmDialog triggerLabel="下架" title={`下架這則${KIND_LABEL[kind]}？`} confirmLabel="下架" danger onConfirm={unpublish}>
            <p>公開頁面會立刻不再顯示。內容會保留，之後勾選「公開」再存檔即可重新上架。</p>
          </ConfirmDialog>
        ) : null}
        {!complete ? <span className="adm-form-error">四種語言與網址代稱都填好才能存檔（有紅點的分頁還沒填）。</span> : null}
      </div>
      {toast.view}
    </form>
  );
}
