import Link from "next/link";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { PublishBadge } from "@/components/admin/StatusBadge";
import { listItemsForAdmin, listUnitTypesForAdmin, type ContentItemRow } from "@/lib/admin/content";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";
import { photosOf } from "@/lib/content-repo";

export const metadata = { title: "內容" };

type Room = Awaited<ReturnType<typeof listUnitTypesForAdmin>>[number];

const roomColumns: Column<Room>[] = [
  { key: "name", header: "房型", render: (u) => <Link href={`/admin/content/rooms/${u.id}`}>{u.name["zh-TW"]}</Link> },
  { key: "slug", header: "網址代稱", render: (u) => <code>{u.slug}</code> },
  { key: "photos", header: "照片", align: "right", render: (u) => <span className="adm-num">{u.images.length || `舊站 ${photosOf(u).length}`}</span> },
  { key: "active", header: "狀態", render: (u) => <PublishBadge on={u.active} labels={["上架", "下架"]} /> },
];

const pageColumns: Column<ContentItemRow>[] = [
  { key: "title", header: "頁面", render: (p) => <Link href={`/admin/content/pages/${p.id}`}>{p.title["zh-TW"]}</Link> },
  { key: "slug", header: "網址代稱", render: (p) => <code>{p.slug}</code> },
  { key: "status", header: "狀態", render: (p) => <PublishBadge on={p.publishedAt !== null} /> },
];

export default async function Page() {
  const ctx = await requirePage("content.edit");
  const propertyId = await currentProperty(ctx);
  const db = await getDb();
  const [rooms, pages, news, faqs] = await Promise.all([
    listUnitTypesForAdmin(db, propertyId),
    listItemsForAdmin(db, "page", propertyId),
    listItemsForAdmin(db, "news", propertyId),
    listItemsForAdmin(db, "faq", propertyId),
  ]);
  return (
    <>
      <h1 className="adm-h1">內容</h1>
      <p className="adm-muted">這裡的修改存檔後立即出現在四種語言的公開網站上。</p>
      <div className="adm-actions">
        <Link href="/admin/content/news" className="adm-btn">消息（{news.length}）</Link>
        <Link href="/admin/content/faqs" className="adm-btn">FAQ（{faqs.length}）</Link>
      </div>
      <h2 className="adm-h2">房型</h2>
      <DataTable columns={roomColumns} rows={rooms} rowKey={(u) => u.id} caption="房型" />
      <h2 className="adm-h2">頁面</h2>
      <DataTable columns={pageColumns} rows={pages} rowKey={(p) => p.id} caption="頁面" empty="還沒有頁面" />
    </>
  );
}
