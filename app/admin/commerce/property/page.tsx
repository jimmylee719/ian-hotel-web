import Link from "next/link";
import { notFound } from "next/navigation";
import { PropertyForm } from "@/components/admin/CommerceForms";
import { getPropertyForAdmin } from "@/lib/admin/commerce";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "館別設定" };

export default async function Page() {
  const ctx = await requirePage("commerce.edit");
  const p = await getPropertyForAdmin(await getDb(), await currentProperty(ctx));
  if (!p) notFound();
  return (
    <>
      <p><Link href="/admin/commerce">← 加購與折扣</Link></p>
      <h1 className="adm-h1">館別設定</h1>
      <PropertyForm property={p} />
    </>
  );
}
