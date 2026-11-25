import { inArray } from "drizzle-orm";
import { StaffForm } from "@/components/admin/StaffForms";
import { PublishBadge } from "@/components/admin/StatusBadge";
import { ROLE_LABELS } from "@/lib/admin/nav";
import { requirePage } from "@/lib/admin/page-guard";
import { listStaff } from "@/lib/admin/staff";
import { getDb } from "@/lib/db/client";
import { properties } from "@/lib/db/schema";

export const metadata = { title: "員工" };

export default async function Page() {
  const ctx = await requirePage("staff.manage");
  const db = await getDb();
  const rows = await listStaff(db, ctx);
  const props = await db.select({ id: properties.id, name: properties.name }).from(properties).where(inArray(properties.id, ctx.staff.propertyIds));
  const options = props.map((p) => ({ id: p.id, name: p.name["zh-TW"] }));
  const nameOf = (id: string) => options.find((o) => o.id === id)?.name ?? id;
  return (
    <>
      <h1 className="adm-h1">員工</h1>
      <p className="adm-muted">
        員工用這裡的 Email 透過 Cloudflare Access 登入。停用後就不能再進入後台；系統至少要保留一位啟用中的店主。
      </p>
      {rows.map((m) => (
        <details key={m.id} className="adm-card">
          <summary>
            {m.name} <code>{m.email}</code> · {ROLE_LABELS[m.role]} · {m.propertyIds.map(nameOf).join("、")}{" "}
            <PublishBadge on={m.active} labels={["啟用", "停用"]} />
            {m.id === ctx.staff.id ? <span className="adm-muted">（你）</span> : null}
          </summary>
          {m.manageable
            ? <StaffForm member={m} properties={options} self={m.id === ctx.staff.id} />
            : <p className="adm-muted">這位員工也在你沒有管理權的館別工作，請由該館店主修改。</p>}
        </details>
      ))}
      <h2 className="adm-h2">新增員工</h2>
      <StaffForm properties={options} />
    </>
  );
}
