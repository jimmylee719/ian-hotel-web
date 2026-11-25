import Link from "next/link";
import { ContentItemForm } from "@/components/admin/ContentForms";
import { PublishBadge } from "@/components/admin/StatusBadge";
import { listItemsForAdmin } from "@/lib/admin/content";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "FAQ" };

/** Every FAQ, each editable in place, plus a form for a new one. */
export default async function Page() {
  const ctx = await requirePage("content.edit");
  const rows = await listItemsForAdmin(await getDb(), "faq", await currentProperty(ctx));
  return (
    <>
      <p><Link href="/admin/content">← 內容</Link></p>
      <h1 className="adm-h1">FAQ</h1>
      <p className="adm-muted">公開頁面依「排序」由小到大顯示：<a href="/zh-TW/faq" target="_blank" rel="noreferrer">/faq</a></p>
      <details className="adm-card adm-faq">
        <summary>新增 FAQ</summary>
        <ContentItemForm kind="faqs" afterCreate="list" />
      </details>
      <ul className="adm-plain adm-faq-list">
        {rows.map((f) => (
          <li key={f.id}>
            <details className="adm-card adm-faq">
              <summary><span className="adm-num">{f.sortOrder}</span> {f.title["zh-TW"]} <PublishBadge on={f.publishedAt !== null} /></summary>
              <ContentItemForm kind="faqs" item={{ id: f.id, slug: f.slug, title: f.title, body: f.body, publishedAt: f.publishedAt, sortOrder: f.sortOrder }} />
            </details>
          </li>
        ))}
      </ul>
    </>
  );
}
