import Link from "next/link";
import { notFound } from "next/navigation";
import { ContentItemForm } from "@/components/admin/ContentForms";
import { getItemForAdmin } from "@/lib/admin/content";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "編輯頁面" };

/** A content page (facilities, access, privacy…). Its slug is fixed: the public route is built on it. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("content.edit");
  const item = await getItemForAdmin(await getDb(), "page", await currentProperty(ctx), (await params).id);
  if (!item) notFound();
  return (
    <>
      <p><Link href="/admin/content">← 內容</Link></p>
      <h1 className="adm-h1">{item.title["zh-TW"]}</h1>
      <ContentItemForm kind="pages" slugEditable={false}
        item={{ id: item.id, slug: item.slug, title: item.title, body: item.body, publishedAt: item.publishedAt, sortOrder: item.sortOrder }} />
    </>
  );
}
