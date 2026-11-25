import Link from "next/link";
import { notFound } from "next/navigation";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { Money } from "@/components/admin/Money";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { getGuest, type GuestHistoryRow } from "@/lib/admin/guests";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "旅客資料" };

const columns: Column<GuestHistoryRow>[] = [
  { key: "code", header: "訂單編號", render: (r) => <Link href={`/admin/reservations/${r.id}`}>{r.code}</Link> },
  { key: "status", header: "狀態", render: (r) => <StatusBadge status={r.status} /> },
  { key: "stay", header: "住宿日期", render: (r) => <span className="adm-num">{r.checkIn} → {r.checkOut}（{r.nights} 晚）</span> },
  { key: "room", header: "房型", render: (r) => r.roomName },
  { key: "total", header: "總額", align: "right", render: (r) => <Money amount={r.total} /> },
  { key: "paid", header: "已收", align: "right", render: (r) => <Money amount={r.paid - r.refunded} /> },
];

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("reservations.view");
  const propertyId = await currentProperty(ctx);
  const { id } = await params;
  const g = await getGuest(await getDb(), propertyId, id);
  if (!g) notFound();

  return (
    <>
      <p className="adm-muted"><Link href="/admin/guests">← 旅客列表</Link></p>
      <h1 className="adm-h1">{g.name}</h1>
      <div className="adm-grid">
        <section className="adm-card" aria-label="聯絡資料">
          <h2 className="adm-h2">聯絡資料</h2>
          <dl className="adm-dl">
            <dt>Email</dt><dd>{g.email}</dd>
            <dt>電話</dt><dd>{g.phone}</dd>
            <dt>國家</dt><dd>{g.country}</dd>
            <dt>語言</dt><dd>{g.locale}</dd>
          </dl>
        </section>
        <section className="adm-card" aria-label="消費">
          <h2 className="adm-h2">消費</h2>
          <dl className="adm-kpi">
            <div><dt>住宿次數</dt><dd className="adm-num">{g.stays}</dd></div>
            <div><dt>總消費</dt><dd><Money amount={g.totalSpent} /></dd></div>
          </dl>
        </section>
      </div>
      <h2 className="adm-h2">歷史訂單</h2>
      <DataTable columns={columns} rows={g.reservations} rowKey={(r) => r.id} empty="沒有訂單" />
    </>
  );
}
