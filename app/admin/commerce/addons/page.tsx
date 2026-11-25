import Link from "next/link";
import { AddonForm, unitLabel } from "@/components/admin/CommerceForms";
import { PublishBadge } from "@/components/admin/StatusBadge";
import { listAddonsForAdmin } from "@/lib/admin/commerce";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "加購項目" };

export default async function Page() {
  const ctx = await requirePage("commerce.edit");
  const rows = await listAddonsForAdmin(await getDb(), await currentProperty(ctx));
  return (
    <>
      <p><Link href="/admin/commerce">← 加購與折扣</Link></p>
      <h1 className="adm-h1">加購項目</h1>
      {rows.length === 0 ? <p className="adm-empty">還沒有加購項目</p> : null}
      {rows.map((a) => (
        <details key={a.id} className="adm-card">
          <summary>
            {a.name["zh-TW"]} <code>{a.slug}</code> · NT$<span className="adm-num">{a.price.toLocaleString("en-US")}</span> / {unitLabel(a.unit)}{" "}
            <PublishBadge on={a.active} labels={["上架", "下架"]} />
          </summary>
          <AddonForm addon={a} />
        </details>
      ))}
      <h2 className="adm-h2">新增加購項目</h2>
      <AddonForm />
    </>
  );
}
