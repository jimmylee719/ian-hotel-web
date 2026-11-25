"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { send, useToast } from "./ContentForms";

type Role = "owner" | "manager" | "front_desk" | "marketing";
export type StaffValue = { id: string; email: string; name: string; role: Role; propertyIds: string[]; active: boolean };
export type PropertyOption = { id: string; name: string };

const ROLE_OPTIONS: [Role, string][] = [["owner", "店主"], ["manager", "經理"], ["front_desk", "櫃檯"], ["marketing", "行銷"]];

/**
 * A staff account: email (their Cloudflare Access login), name, role and properties. Without `member` it
 * creates one. `self` locks the role (nobody changes their own role, email or active flag).
 */
export function StaffForm({ member, properties, self = false }: { member?: StaffValue; properties: PropertyOption[]; self?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const blank = { email: "", name: "", role: "front_desk" as Role, propertyIds: properties.length === 1 ? [properties[0].id] : [] };
  const [v, setV] = useState(member ? { email: member.email, name: member.name, role: member.role, propertyIds: member.propertyIds } : blank);
  const complete = v.email.trim() !== "" && v.name.trim() !== "" && v.propertyIds.length > 0;

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

  async function save() {
    const body = self ? { name: v.name, propertyIds: v.propertyIds } : v;
    const ok = await run(
      () => (member ? send("PATCH", `/api/admin/staff/${encodeURIComponent(member.id)}`, body) : send("POST", "/api/admin/staff", body)),
      member ? "已儲存" : "已新增員工，對方用這個 Email 透過 Cloudflare Access 登入即可",
    );
    if (ok && !member) setV(blank);
  }

  const toggle = (id: string, on: boolean) =>
    setV((s) => ({ ...s, propertyIds: on ? [...new Set([...s.propertyIds, id])] : s.propertyIds.filter((p) => p !== id) }));

  return (
    <form className="adm-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="adm-form-row">
        <label>Email（Cloudflare Access 登入用，存成小寫）
          <input type="email" value={v.email} required disabled={self} onChange={(e) => setV((s) => ({ ...s, email: e.target.value }))} />
        </label>
        <label>姓名
          <input value={v.name} required maxLength={100} onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} />
        </label>
        <label>角色
          <select value={v.role} disabled={self} onChange={(e) => setV((s) => ({ ...s, role: e.target.value as Role }))}>
            {ROLE_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="adm-i18n">
        <legend>館別（至少一個）</legend>
        {properties.map((p) => (
          <label key={p.id} className="adm-check">
            <input type="checkbox" checked={v.propertyIds.includes(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} /> {p.name}
          </label>
        ))}
      </fieldset>
      <div className="adm-actions">
        <button type="submit" className="adm-btn adm-btn-primary" disabled={busy || !complete}>{busy ? "儲存中…" : member ? "儲存" : "新增員工"}</button>
        {!complete ? <span className="adm-form-error">Email、姓名和至少一個館別都要填。</span> : null}
        {member && !self ? <ActiveToggle member={member} onDone={() => router.refresh()} /> : null}
      </div>
      {self ? <p className="adm-muted">這是你自己的帳號：角色、Email 與停用請由另一位店主變更。</p> : null}
      {toast.view}
    </form>
  );
}

/** 停用 (with a confirmation) or 重新啟用. */
function ActiveToggle({ member, onDone }: { member: StaffValue; onDone: () => void }) {
  const toast = useToast();
  if (!member.active)
    return (
      <>
        <button type="button" className="adm-btn" onClick={async () => {
          try { await send("PATCH", `/api/admin/staff/${encodeURIComponent(member.id)}`, { active: true }); toast.ok("已重新啟用"); onDone(); } catch (e) { toast.fail(e); }
        }}>重新啟用</button>
        {toast.view}
      </>
    );
  return (
    <ConfirmDialog
      triggerLabel="停用"
      title={`停用 ${member.name}？`}
      confirmLabel="停用"
      danger
      onConfirm={async () => { await send("DELETE", `/api/admin/staff/${encodeURIComponent(member.id)}`); onDone(); }}
    >
      停用後對方就不能再進入後台（帳號資料與操作紀錄會保留，之後可以重新啟用）。
    </ConfirmDialog>
  );
}
