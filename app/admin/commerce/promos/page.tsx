import Link from "next/link";
import { PromoForm } from "@/components/admin/CommerceForms";
import { PublishBadge } from "@/components/admin/StatusBadge";
import { listPromosForAdmin } from "@/lib/admin/commerce";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "折扣碼" };

export default async function Page() {
  const ctx = await requirePage("commerce.edit");
  const rows = await listPromosForAdmin(await getDb(), await currentProperty(ctx));
  return (
    <>
      <p><Link href="/admin/commerce">← 加購與折扣</Link></p>
      <h1 className="adm-h1">折扣碼</h1>
      {rows.length === 0 ? <p className="adm-empty">還沒有折扣碼</p> : null}
      {rows.map((p) => (
        <details key={p.id} className="adm-card">
          <summary>
            <code>{p.code}</code> · {p.kind === "percent" ? `${p.value}%` : `NT$${p.value.toLocaleString("en-US")}`} · 已用 <span className="adm-num">{p.usedCount}</span>
            {p.maxUses !== null ? ` / ${p.maxUses}` : ""} <PublishBadge on={p.active} labels={["啟用", "停用"]} />
          </summary>
          <PromoForm promo={p} />
        </details>
      ))}
      <h2 className="adm-h2">新增折扣碼</h2>
      <PromoForm />
    </>
  );
}
