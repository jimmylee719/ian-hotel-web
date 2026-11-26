import Link from "next/link";
import { notFound } from "next/navigation";
import { SmCode } from "@/components/admin/SmCode";
import { RoomForm } from "@/components/admin/ContentForms";
import { getUnitTypeForAdmin } from "@/lib/admin/content";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "編輯房型" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("content.edit");
  const propertyId = await currentProperty(ctx);
  const u = await getUnitTypeForAdmin(await getDb(), propertyId, (await params).id);
  if (!u) notFound();
  return (
    <>
      <p><Link href="/admin/content">← 內容</Link></p>
      <h1 className="adm-h1">{u.name["zh-TW"]}</h1>
      <p className="adm-muted">公開頁面：<a href={`/zh-TW/rooms/${u.slug}`} target="_blank" rel="noreferrer">/rooms/{u.slug}</a></p>
      <SmCode label="房型代碼（RoomTypeCode）" code={u.smRoomCode} />
      <RoomForm room={{
        id: u.id, slug: u.slug, name: u.name, description: u.description, bedType: u.bedType, amenities: u.amenities,
        sizeSqm: u.sizeSqm, maxAdults: u.maxAdults, maxOccupancy: u.maxOccupancy, sortOrder: u.sortOrder, active: u.active, images: u.images,
      }} />
    </>
  );
}
