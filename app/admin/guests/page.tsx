import Link from "next/link";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { Money } from "@/components/admin/Money";
import { Pagination } from "@/components/admin/Pagination";
import { listGuests, type GuestListRow } from "@/lib/admin/guests";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "旅客" };

const PAGE_SIZE = 20;

const columns: Column<GuestListRow>[] = [
  { key: "name", header: "姓名", render: (g) => <Link href={`/admin/guests/${g.id}`}>{g.name}</Link> },
  { key: "email", header: "Email", render: (g) => g.email },
  { key: "phone", header: "電話", render: (g) => g.phone },
  { key: "country", header: "國家", render: (g) => g.country },
  { key: "count", header: "訂單數", align: "right", render: (g) => <span className="adm-num">{g.reservationCount}</span> },
  { key: "stays", header: "住宿次數", align: "right", render: (g) => <span className="adm-num">{g.stays}</span> },
  { key: "spent", header: "總消費", align: "right", render: (g) => <Money amount={g.totalSpent} /> },
];

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("reservations.view");
  const propertyId = await currentProperty(ctx);
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim().slice(0, 100) ?? "";
  const rawPage = Number(Array.isArray(sp.page) ? sp.page[0] : sp.page);
  const result = await listGuests(await getDb(), propertyId, { q, page: Math.max(1, Math.floor(rawPage) || 1), pageSize: PAGE_SIZE });
  const hrefFor = (page: number) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (page > 1) p.set("page", String(page));
    return `/admin/guests${p.size ? `?${p}` : ""}`;
  };

  return (
    <>
      <h1 className="adm-h1">旅客</h1>
      <form method="get" className="adm-filter" role="search" aria-label="搜尋旅客">
        <label>搜尋<input type="search" name="q" defaultValue={q} placeholder="姓名、Email、電話" /></label>
        <span className="adm-filter-actions">
          <button type="submit" className="adm-btn adm-btn-primary">搜尋</button>
          <Link href="/admin/guests" className="adm-btn">清除</Link>
        </span>
      </form>
      <DataTable columns={columns} rows={result.rows} rowKey={(g) => g.id} caption="旅客列表" />
      <Pagination page={result.page} pageCount={result.pageCount} total={result.total} hrefFor={hrefFor} />
    </>
  );
}
