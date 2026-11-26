import Link from "next/link";
import { RatePlanForm } from "@/components/admin/CommerceForms";
import { SmCode } from "@/components/admin/SmCode";
import { PublishBadge } from "@/components/admin/StatusBadge";
import { listRatePlansForAdmin } from "@/lib/admin/commerce";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "房價方案" };

export default async function Page() {
  const ctx = await requirePage("commerce.edit");
  const rows = await listRatePlansForAdmin(await getDb(), await currentProperty(ctx));
  return (
    <>
      <p><Link href="/admin/commerce">← 加購與折扣</Link></p>
      <h1 className="adm-h1">房價方案</h1>
      <p className="adm-notice">房價與庫存請在 SiteMinder 調整；這裡只改方案的名稱、取消規則和付款方式。</p>
      {rows.map((p) => (
        <details key={p.id} className="adm-card">
          <summary>{p.name["zh-TW"]} <code>{p.slug}</code> <PublishBadge on={p.active} labels={["啟用", "停用"]} /></summary>
          <SmCode label="方案代碼（RatePlanCode）" code={p.smRatePlanCode} />
          <RatePlanForm plan={p} />
        </details>
      ))}
    </>
  );
}
