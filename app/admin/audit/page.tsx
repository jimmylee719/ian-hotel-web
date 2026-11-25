import { inArray } from "drizzle-orm";
import Link from "next/link";
import { Pagination } from "@/components/admin/Pagination";
import { AUDIT_PROPERTY_ENTITIES, auditDiff, listAudit } from "@/lib/admin/audit-view";
import { requirePage } from "@/lib/admin/page-guard";
import { getDb } from "@/lib/db/client";
import { properties } from "@/lib/db/schema";

export const metadata = { title: "操作紀錄" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const time = (ms: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", dateStyle: "short", timeStyle: "medium" }).format(ms);

const ENTITY_LABELS: Record<string, string> = {
  reservation: "訂單", reservation_note: "訂單備註", payment: "付款", notification: "通知信", unit_type: "房型",
  news: "最新消息", faq: "常見問題", page: "頁面", addon: "加購", promo_code: "折扣碼", rate_plan: "房價方案",
  property: "館別設定", staff: "員工",
};

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("audit.view");
  const sp = await searchParams;
  const f = { q: first(sp.q), staffEmail: first(sp.staff), entity: first(sp.entity), from: first(sp.from), to: first(sp.to) };
  const isOwner = ctx.staff.role === "owner";
  const db = await getDb();
  const result = await listAudit(db, ctx.staff.propertyIds, { ...f, page: Number(first(sp.page)) || 1, includeUnscoped: isOwner });
  const props = await db.select({ id: properties.id, name: properties.name }).from(properties).where(inArray(properties.id, ctx.staff.propertyIds));
  const propName = (id: string | null) => (id ? props.find((p) => p.id === id)?.name["zh-TW"] ?? id : "（全系統）");
  const entities = isOwner ? [...AUDIT_PROPERTY_ENTITIES, "staff"] : AUDIT_PROPERTY_ENTITIES;
  const hrefFor = (page: number) => {
    const u = new URLSearchParams(Object.entries({ q: f.q, staff: f.staffEmail, entity: f.entity, from: f.from, to: f.to }).filter(([, v]) => v));
    u.set("page", String(page));
    return `/admin/audit?${u}`;
  };

  return (
    <>
      <h1 className="adm-h1">操作紀錄</h1>
      <p className="adm-muted">
        員工在後台的每個寫入動作都會留下紀錄，新的在前。{isOwner ? "店主也看得到員工帳號等不屬於單一館別的紀錄。" : "只顯示你負責館別的紀錄。"}
      </p>
      <form className="adm-filter" method="get">
        <label>關鍵字<input name="q" defaultValue={f.q} placeholder="動作、編號、內容" /></label>
        <label>員工 Email<input name="staff" type="email" defaultValue={f.staffEmail} /></label>
        <label>對象
          <select name="entity" defaultValue={f.entity}>
            <option value="">全部</option>
            {entities.map((e) => <option key={e} value={e}>{ENTITY_LABELS[e] ?? e}</option>)}
          </select>
        </label>
        <label>從<input name="from" type="date" defaultValue={f.from} /></label>
        <label>到<input name="to" type="date" defaultValue={f.to} /></label>
        <div className="adm-filter-actions">
          <button type="submit" className="adm-btn adm-btn-primary">篩選</button>
          <Link className="adm-btn" href="/admin/audit">清除</Link>
        </div>
      </form>
      {result.rows.length === 0 ? <p className="adm-empty">沒有符合條件的紀錄</p> : null}
      {result.rows.map((r) => (
        <details key={r.id} className="adm-card adm-audit">
          <summary>
            <span className="adm-num">{time(r.at)}</span> · {r.staffEmail} · <code>{r.action}</code> ·{" "}
            {ENTITY_LABELS[r.entity] ?? r.entity} <code>{r.entityId}</code> · {propName(r.propertyId)}
          </summary>
          <table className="adm-diff">
            <thead><tr><th scope="col">欄位</th><th scope="col">變更前</th><th scope="col">變更後</th></tr></thead>
            <tbody>
              {auditDiff(r.before, r.after).map((d) => (
                <tr key={d.key} className={d.changed ? "adm-diff-changed" : undefined}>
                  <td>{d.key || "—"}</td><td>{d.before || "—"}</td><td>{d.after || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
      <Pagination page={result.page} pageCount={result.pageCount} total={result.total} hrefFor={hrefFor} />
    </>
  );
}
