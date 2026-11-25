"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { I18n } from "@/lib/db/schema";
import { validateCancelPolicy } from "@/lib/domain/cancellation";
import { send, useToast } from "./ContentForms";
import { I18nField, i18nComplete } from "./I18nField";

const empty = (): I18n => ({ "zh-TW": "", en: "", ja: "", ko: "" });

/** Run `fn` with a busy flag, toast the outcome and refresh the server data. */
function useSave() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast.ok(done);
      router.refresh();
      return true;
    } catch (e) {
      toast.fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, run, toast: toast.view };
}

/* --------------------------------------------------------------------------------------------- add-ons */

export type AddonValue = { id: string; slug: string; name: I18n; price: number; unit: "per_stay" | "per_night" | "per_person_night"; active: boolean };
const UNIT_LABELS: Record<AddonValue["unit"], string> = { per_stay: "每筆訂單", per_night: "每晚", per_person_night: "每人每晚" };
export const unitLabel = (u: AddonValue["unit"]) => UNIT_LABELS[u];

/** An add-on: slug, four-language name, price (TWD) and unit. Without `addon` it creates one. 下架 = unchecking 上架. */
export function AddonForm({ addon }: { addon?: AddonValue }) {
  const { busy, run, toast } = useSave();
  const [v, setV] = useState<Omit<AddonValue, "id">>(addon ?? { slug: "", name: empty(), price: 0, unit: "per_stay", active: true });
  const complete = i18nComplete(v.name) && v.slug.trim() !== "" && Number.isInteger(v.price) && v.price > 0;

  async function save() {
    const body = { ...v, slug: v.slug.trim() };
    const ok = await run(
      () => (addon ? send("PATCH", `/api/admin/commerce/addons/${encodeURIComponent(addon.id)}`, body) : send("POST", "/api/admin/commerce/addons", body)),
      addon ? "已儲存，新訂單會用新價格" : "已新增加購項目",
    );
    if (ok && !addon) setV({ slug: "", name: empty(), price: 0, unit: "per_stay", active: true });
  }

  return (
    <form className="adm-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <I18nField label="名稱" value={v.name} onChange={(name) => setV((s) => ({ ...s, name }))} />
      <div className="adm-form-row">
        <label>網址代稱（小寫英數與 -）
          <input value={v.slug} required pattern="[a-z0-9][a-z0-9\-]{0,63}" onChange={(e) => setV((s) => ({ ...s, slug: e.target.value }))} />
        </label>
        <label>價格（NT$，正整數）
          <input type="number" inputMode="numeric" min={1} step={1} value={v.price || ""} required onChange={(e) => setV((s) => ({ ...s, price: Number(e.target.value) }))} />
        </label>
        <label>計價單位
          <select value={v.unit} onChange={(e) => setV((s) => ({ ...s, unit: e.target.value as AddonValue["unit"] }))}>
            {Object.entries(UNIT_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
      </div>
      <label className="adm-check">
        <input type="checkbox" checked={v.active} onChange={(e) => setV((s) => ({ ...s, active: e.target.checked }))} /> 上架（取消勾選後訂房頁不再提供）
      </label>
      <div className="adm-actions">
        <button type="submit" className="adm-btn adm-btn-primary" disabled={busy || !complete}>{busy ? "儲存中…" : addon ? "儲存" : "新增加購"}</button>
        {!complete ? <span className="adm-form-error">四種語言的名稱、網址代稱和價格都填好才能存檔。</span> : null}
      </div>
      {toast}
    </form>
  );
}

/* ---------------------------------------------------------------------------------------- promo codes */

export type PromoValue = {
  id: string; code: string; kind: "percent" | "fixed"; value: number; validFrom: string | null; validTo: string | null;
  maxUses: number | null; usedCount: number; active: boolean;
};

/** A promo code. The code is saved in UPPERCASE; the used count is shown, never edited. Without `promo` it creates one. */
export function PromoForm({ promo }: { promo?: PromoValue }) {
  const { busy, run, toast } = useSave();
  const blank = { code: "", kind: "percent" as const, value: 10, validFrom: null, validTo: null, maxUses: null, active: true };
  const [v, setV] = useState(promo ? { code: promo.code, kind: promo.kind, value: promo.value, validFrom: promo.validFrom, validTo: promo.validTo, maxUses: promo.maxUses, active: promo.active } : blank);
  const rangeBad = !!v.validFrom && !!v.validTo && v.validFrom > v.validTo;
  const valueOk = Number.isInteger(v.value) && (v.kind === "percent" ? v.value >= 1 && v.value <= 100 : v.value >= 1);
  const complete = v.code.trim() !== "" && valueOk && !rangeBad;

  async function save() {
    const body = { ...v, code: v.code.trim().toUpperCase() };
    const ok = await run(
      () => (promo ? send("PATCH", `/api/admin/commerce/promos/${encodeURIComponent(promo.id)}`, body) : send("POST", "/api/admin/commerce/promos", body)),
      promo ? "已儲存" : "已新增折扣碼",
    );
    if (ok && !promo) setV(blank);
  }

  return (
    <form className="adm-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="adm-form-row">
        <label>折扣碼（自動轉大寫，同館別不可重複）
          <input value={v.code} required maxLength={32} onChange={(e) => setV((s) => ({ ...s, code: e.target.value }))} />
        </label>
        <label>類型
          <select value={v.kind} onChange={(e) => setV((s) => ({ ...s, kind: e.target.value as PromoValue["kind"] }))}>
            <option value="percent">百分比折扣</option>
            <option value="fixed">固定金額折抵</option>
          </select>
        </label>
        <label>{v.kind === "percent" ? "折扣 %（1–100）" : "折抵金額（NT$）"}
          <input type="number" inputMode="numeric" min={1} max={v.kind === "percent" ? 100 : undefined} step={1} value={v.value || ""} required
            onChange={(e) => setV((s) => ({ ...s, value: Number(e.target.value) }))} />
        </label>
      </div>
      <div className="adm-form-row">
        <label>開始日（可留空）
          <input type="date" value={v.validFrom ?? ""} onChange={(e) => setV((s) => ({ ...s, validFrom: e.target.value || null }))} />
        </label>
        <label>結束日（可留空）
          <input type="date" value={v.validTo ?? ""} onChange={(e) => setV((s) => ({ ...s, validTo: e.target.value || null }))} />
        </label>
        <label>使用上限（留空 = 不限）
          <input type="number" inputMode="numeric" min={1} step={1} value={v.maxUses ?? ""}
            onChange={(e) => setV((s) => ({ ...s, maxUses: e.target.value === "" ? null : Number(e.target.value) }))} />
        </label>
        {promo ? <p className="adm-muted">已使用 <span className="adm-num">{promo.usedCount}</span> 次</p> : null}
      </div>
      <label className="adm-check">
        <input type="checkbox" checked={v.active} onChange={(e) => setV((s) => ({ ...s, active: e.target.checked }))} /> 啟用
      </label>
      <div className="adm-actions">
        <button type="submit" className="adm-btn adm-btn-primary" disabled={busy || !complete}>{busy ? "儲存中…" : promo ? "儲存" : "新增折扣碼"}</button>
        {rangeBad ? <span className="adm-form-error">開始日不能晚於結束日。</span> : null}
      </div>
      {toast}
    </form>
  );
}

/* ---------------------------------------------------------------------------------------- rate plans */

export type RatePlanValue = {
  id: string; slug: string; name: I18n; smRatePlanCode: string | null; cancelPolicy: { rules: { daysBefore: number; refundPct: number }[] };
  paymentMode: "full" | "deposit"; depositPct: number; includesBreakfast: boolean; directOnly: boolean; active: boolean;
};

/** A rate plan's terms. The SiteMinder code is shown read-only; rates and stock are changed in SiteMinder. */
export function RatePlanForm({ plan }: { plan: RatePlanValue }) {
  const { busy, run, toast } = useSave();
  const [v, setV] = useState({
    name: plan.name, paymentMode: plan.paymentMode, depositPct: plan.depositPct, includesBreakfast: plan.includesBreakfast,
    directOnly: plan.directOnly, active: plan.active,
  });
  const [rules, setRules] = useState(plan.cancelPolicy.rules);
  const policyError = validateCancelPolicy({ rules });
  const depositBad = v.paymentMode === "deposit" && !(Number.isInteger(v.depositPct) && v.depositPct >= 1 && v.depositPct <= 99);
  const complete = i18nComplete(v.name) && !policyError && !depositBad;
  const setRule = (i: number, k: "daysBefore" | "refundPct", n: number) => setRules((r) => r.map((x, j) => (j === i ? { ...x, [k]: n } : x)));

  return (
    <form className="adm-form" onSubmit={(e) => { e.preventDefault(); void run(() => send("PATCH", `/api/admin/commerce/rate-plans/${encodeURIComponent(plan.id)}`, { ...v, cancelPolicy: { rules } }), "已儲存"); }}>
      <p className="adm-muted">SiteMinder 代碼：<code>{plan.smRatePlanCode ?? "—"}</code>（由 SiteMinder 決定，這裡不能修改）。房價與庫存請在 SiteMinder 調整。</p>
      <I18nField label="名稱" value={v.name} onChange={(name) => setV((s) => ({ ...s, name }))} />
      <div className="adm-form-row">
        <label>付款方式
          <select value={v.paymentMode} onChange={(e) => setV((s) => ({ ...s, paymentMode: e.target.value as "full" | "deposit" }))}>
            <option value="full">全額付款</option>
            <option value="deposit">先付訂金</option>
          </select>
        </label>
        {v.paymentMode === "deposit" ? (
          <label>訂金 %（1–99）
            <input type="number" inputMode="numeric" min={1} max={99} step={1} value={v.depositPct || ""} onChange={(e) => setV((s) => ({ ...s, depositPct: Number(e.target.value) }))} />
          </label>
        ) : null}
      </div>
      <fieldset className="adm-i18n">
        <legend>取消規則（入住前幾天以前取消，退款幾 %）</legend>
        {rules.length === 0 ? <p className="adm-muted">沒有規則 = 不可退款。</p> : null}
        {rules.map((r, i) => (
          <div className="adm-form-row" key={i}>
            <label>入住前（天）
              <input type="number" inputMode="numeric" min={0} step={1} value={r.daysBefore} onChange={(e) => setRule(i, "daysBefore", Number(e.target.value))} />
            </label>
            <label>退款 %
              <input type="number" inputMode="numeric" min={0} max={100} step={1} value={r.refundPct} onChange={(e) => setRule(i, "refundPct", Number(e.target.value))} />
            </label>
            <button type="button" className="adm-btn adm-btn-danger-ghost" onClick={() => setRules((x) => x.filter((_, j) => j !== i))}>刪除這條</button>
          </div>
        ))}
        <button type="button" className="adm-btn" onClick={() => setRules((x) => [...x, { daysBefore: 0, refundPct: 0 }])}>新增一條規則</button>
        {policyError ? <p className="adm-form-error">{policyError}</p> : null}
      </fieldset>
      <label className="adm-check"><input type="checkbox" checked={v.includesBreakfast} onChange={(e) => setV((s) => ({ ...s, includesBreakfast: e.target.checked }))} /> 含早餐</label>
      <label className="adm-check"><input type="checkbox" checked={v.directOnly} onChange={(e) => setV((s) => ({ ...s, directOnly: e.target.checked }))} /> 官網限定</label>
      <label className="adm-check"><input type="checkbox" checked={v.active} onChange={(e) => setV((s) => ({ ...s, active: e.target.checked }))} /> 啟用</label>
      <div className="adm-actions">
        <button type="submit" className="adm-btn adm-btn-primary" disabled={busy || !complete}>{busy ? "儲存中…" : "儲存"}</button>
        {depositBad ? <span className="adm-form-error">訂金模式的訂金比例要在 1 到 99 之間。</span> : null}
      </div>
      {toast}
    </form>
  );
}

/* --------------------------------------------------------------------------------------- property */

export type PropertyValue = {
  name: I18n; address: I18n; phone: string; email: string; checkInTime: string; checkOutTime: string; directions: I18n;
  sinopacMerchantId: string | null; smPropertyCode: string | null;
};

/** The property's public details, check-in/out times and directions. The payment and channel ids are display only. */
export function PropertyForm({ property }: { property: PropertyValue }) {
  const { busy, run, toast } = useSave();
  const [v, setV] = useState({
    name: property.name, address: property.address, phone: property.phone, email: property.email,
    checkInTime: property.checkInTime, checkOutTime: property.checkOutTime, directions: property.directions,
  });
  const complete = i18nComplete(v.name) && i18nComplete(v.address) && i18nComplete(v.directions) && v.phone.trim() !== "" && v.email.trim() !== "" && !!v.checkInTime && !!v.checkOutTime;

  return (
    <form className="adm-form" onSubmit={(e) => { e.preventDefault(); void run(() => send("PATCH", "/api/admin/commerce/property", v), "已儲存"); }}>
      <I18nField label="館名" value={v.name} onChange={(name) => setV((s) => ({ ...s, name }))} />
      <I18nField label="地址" value={v.address} onChange={(address) => setV((s) => ({ ...s, address }))} />
      <div className="adm-form-row">
        <label>電話
          <input value={v.phone} onChange={(e) => setV((s) => ({ ...s, phone: e.target.value }))} />
        </label>
        <label>Email
          <input type="email" value={v.email} onChange={(e) => setV((s) => ({ ...s, email: e.target.value }))} />
        </label>
        <label>入住時間
          <input type="time" value={v.checkInTime} onChange={(e) => setV((s) => ({ ...s, checkInTime: e.target.value }))} />
        </label>
        <label>退房時間
          <input type="time" value={v.checkOutTime} onChange={(e) => setV((s) => ({ ...s, checkOutTime: e.target.value }))} />
        </label>
      </div>
      <I18nField label="交通說明" value={v.directions} onChange={(directions) => setV((s) => ({ ...s, directions }))} multiline rows={5} />
      <dl className="adm-dl adm-dl-narrow">
        <dt>永豐商店代號</dt><dd><code>{property.sinopacMerchantId ?? "—"}</code></dd>
        <dt>SiteMinder 館別代碼</dt><dd><code>{property.smPropertyCode ?? "—"}</code></dd>
      </dl>
      <p className="adm-muted">這兩個代碼只顯示、不能在這裡修改；要變更請走部署設定。</p>
      <div className="adm-actions">
        <button type="submit" className="adm-btn adm-btn-primary" disabled={busy || !complete}>{busy ? "儲存中…" : "儲存"}</button>
        {!complete ? <span className="adm-form-error">各項都填好才能存檔（交通說明、館名、地址要四種語言）。</span> : null}
      </div>
      {toast}
    </form>
  );
}
