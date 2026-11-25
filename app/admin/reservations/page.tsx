import Link from "next/link";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { Money } from "@/components/admin/Money";
import { Pagination } from "@/components/admin/Pagination";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { parseReservationQuery, reservationQueryString, RES_STATUSES, SYNC_STATES } from "@/lib/admin/reservation-query";
import { listReservations, type ReservationListRow } from "@/lib/admin/reservations";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "訂單" };

const PAGE_SIZE = 20;
const STATUS_LABEL: Record<string, string> = {
  pending_payment: "待付款", paid_pending_confirm: "已付款，待確認", confirmed: "已確認",
  confirm_failed_refunded: "確認失敗，已退款", cancelled: "已取消", expired: "已逾時",
};
const SYNC_LABEL: Record<string, string> = { not_required: "無需同步", pending: "同步中", synced: "已同步", failed: "同步失敗" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("reservations.view");
  const propertyId = await currentProperty(ctx);
  const filter = parseReservationQuery(await searchParams);
  const result = await listReservations(await getDb(), propertyId, { ...filter, pageSize: PAGE_SIZE });
  const href = (page: number) => `/admin/reservations${reservationQueryString(filter, page)}`;
  const sortHref = (key: string) => `/admin/reservations${reservationQueryString({ ...filter, sort: key === "checkIn" ? "checkIn" : "-createdAt" }, 1)}`;

  const columns: Column<ReservationListRow>[] = [
    { key: "code", header: "訂單編號", render: (r) => <Link href={`/admin/reservations/${r.id}`}>{r.code}</Link> },
    { key: "status", header: "狀態", render: (r) => <StatusBadge status={r.status} /> },
    { key: "sync", header: "同步", render: (r) => <StatusBadge status={r.syncState} kind="sync" /> },
    { key: "checkIn", header: "住宿日期", sortable: true, render: (r) => <span className="adm-num">{r.checkIn} → {r.checkOut}（{r.nights} 晚）</span> },
    { key: "room", header: "房型", render: (r) => r.roomName },
    { key: "guest", header: "旅客", render: (r) => r.guestName },
    { key: "total", header: "總額", align: "right", render: (r) => <Money amount={r.total} /> },
    { key: "paid", header: "已收（淨額）", align: "right", render: (r) => <Money amount={r.paid} /> },
    { key: "refunded", header: "已退", align: "right", render: (r) => <Money amount={r.refunded} /> },
    { key: "due", header: "待收", align: "right", render: (r) => (r.balanceDue !== null ? <Money amount={r.balanceDue} /> : <span className="adm-muted">—</span>) },
    { key: "createdAt", header: "建立時間", sortable: true, render: (r) => <span className="adm-num">{new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", dateStyle: "short", timeStyle: "short" }).format(r.createdAt)}</span> },
  ];

  return (
    <>
      <h1 className="adm-h1">訂單</h1>
      <form method="get" className="adm-filter" role="search" aria-label="篩選訂單">
        <label>搜尋<input type="search" name="q" defaultValue={filter.q ?? ""} placeholder="編號、姓名、Email、電話" /></label>
        <label>日期欄位
          <select name="field" defaultValue={filter.dateField}>
            <option value="checkIn">入住日</option>
            <option value="createdAt">建立日</option>
          </select>
        </label>
        <label>從<input type="date" name="from" defaultValue={filter.from ?? ""} /></label>
        <label>到<input type="date" name="to" defaultValue={filter.to ?? ""} /></label>
        <label>排序
          <select name="sort" defaultValue={filter.sort}>
            <option value="-createdAt">最新建立</option>
            <option value="checkIn">入住日</option>
          </select>
        </label>
        <fieldset>
          <legend>狀態</legend>
          {RES_STATUSES.map((s) => (
            <label key={s} className="adm-check"><input type="checkbox" name="status" value={s} defaultChecked={filter.status?.includes(s)} />{STATUS_LABEL[s]}</label>
          ))}
        </fieldset>
        <fieldset>
          <legend>同步</legend>
          {SYNC_STATES.map((s) => (
            <label key={s} className="adm-check"><input type="checkbox" name="sync" value={s} defaultChecked={filter.syncState?.includes(s)} />{SYNC_LABEL[s]}</label>
          ))}
        </fieldset>
        <span className="adm-filter-actions">
          <button type="submit" className="adm-btn adm-btn-primary">篩選</button>
          <Link href="/admin/reservations" className="adm-btn">清除</Link>
        </span>
      </form>

      <DataTable
        columns={columns} rows={result.rows} rowKey={(r) => r.id} caption="訂單列表"
        sort={{ key: filter.sort === "checkIn" ? "checkIn" : "createdAt", dir: filter.sort === "checkIn" ? "asc" : "desc" }}
        sortHref={sortHref}
      />
      <Pagination page={result.page} pageCount={result.pageCount} total={result.total} hrefFor={href} />
    </>
  );
}
