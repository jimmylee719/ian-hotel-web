import Link from "next/link";
import { notFound } from "next/navigation";
import { ContentItemForm } from "@/components/admin/ContentForms";
import { getItemForAdmin } from "@/lib/admin/content";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "編輯消息" };

/** One news item; `/admin/content/news/new` creates one. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("content.edit");
  const { id } = await params;
  const item = id === "new" ? null : await getItemForAdmin(await getDb(), "news", await currentProperty(ctx), id);
  if (id !== "new" && !item) notFound();
  return (
    <>
      <p><Link href="/admin/content/news">← 消息</Link></p>
      <h1 className="adm-h1">{item ? item.title["zh-TW"] : "新增消息"}</h1>
      {item?.publishedAt != null ? (
        <p className="adm-muted">公開頁面：<a href={`/zh-TW/news/${item.slug}`} target="_blank" rel="noreferrer">/news/{item.slug}</a></p>
      ) : null}
      <ContentItemForm kind="news" item={item ?? undefined} afterCreate="edit" />
    </>
  );
}
