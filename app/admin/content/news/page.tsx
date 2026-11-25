import Link from "next/link";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { PublishBadge } from "@/components/admin/StatusBadge";
import { listItemsForAdmin, type ContentItemRow } from "@/lib/admin/content";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "消息" };

const date = (ms: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(ms);

const columns: Column<ContentItemRow>[] = [
  { key: "title", header: "標題", render: (n) => <Link href={`/admin/content/news/${n.id}`}>{n.title["zh-TW"]}</Link> },
  { key: "slug", header: "網址代稱", render: (n) => <code>{n.slug}</code> },
  { key: "date", header: "發布日期", render: (n) => <span className="adm-num">{n.publishedAt !== null ? date(n.publishedAt) : "—"}</span> },
  { key: "status", header: "狀態", render: (n) => <PublishBadge on={n.publishedAt !== null} /> },
];

export default async function Page() {
  const ctx = await requirePage("content.edit");
  const rows = await listItemsForAdmin(await getDb(), "news", await currentProperty(ctx));
  return (
    <>
      <p><Link href="/admin/content">← 內容</Link></p>
      <h1 className="adm-h1">消息</h1>
      <div className="adm-actions"><Link href="/admin/content/news/new" className="adm-btn adm-btn-primary">新增消息</Link></div>
      <DataTable columns={columns} rows={rows} rowKey={(n) => n.id} caption="消息" empty="還沒有消息" />
    </>
  );
}
