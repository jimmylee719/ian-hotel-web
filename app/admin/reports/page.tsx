import Link from "next/link";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { Money } from "@/components/admin/Money";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import {
  bookingsReport, cancellationReport, occupancyReport, REPORT_KINDS, revenueReport, validateRange,
  type BookingReportRow, type OccupancyRow, type ReportKind, type RevenueRow,
} from "@/lib/admin/reports";
import { getDb } from "@/lib/db/client";
import { todayInTaipei } from "@/lib/domain/dates";

export const metadata = { title: "報表" };

const KIND_LABELS: Record<ReportKind, string> = { revenue: "營收", occupancy: "住房率", bookings: "訂單", cancellations: "取消" };
const RANGE_ERRORS = { INVALID_RANGE: "日期區間不正確（起日要在迄日之前，且都要是有效日期）。", RANGE_TOO_LONG: "日期區間最長 366 天。" };
/** The page shows this many booking rows; the CSV has them all. */
const BOOKING_ROWS_SHOWN = 200;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** A pure-CSS bar: `ratio` (0..1) of the track. */
function Bar({ ratio, label }: { ratio: number; label: string }) {
  return (
    <span className="adm-bar" role="img" aria-label={label}>
      <span style={{ width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%` }} />
    </span>
  );
}

const revenueColumns = (max: number): Column<RevenueRow>[] => [
  { key: "period", header: "期間", render: (r) => <span className="adm-num">{r.period}</span> },
  { key: "onlineCharges", header: "線上收款", align: "right", render: (r) => <Money amount={r.onlineCharges} /> },
  { key: "onlineRefunds", header: "線上退款", align: "right", render: (r) => <Money amount={r.onlineRefunds} /> },
  { key: "deskPayments", header: "櫃檯收款", align: "right", render: (r) => <Money amount={r.deskPayments} /> },
  { key: "deskRefunds", header: "櫃檯退款", align: "right", render: (r) => <Money amount={r.deskRefunds} /> },
  { key: "net", header: "淨額", align: "right", render: (r) => <Money amount={r.net} /> },
  { key: "bar", header: "", render: (r) => (r.period === "合計" ? null : <Bar ratio={max ? Math.max(0, r.net) / max : 0} label={`淨額 NT$${r.net}`} />) },
];

const occupancyColumns: Column<OccupancyRow>[] = [
  { key: "date", header: "日期", render: (r) => <span className="adm-num">{r.date}</span> },
  { key: "type", header: "房型", render: (r) => r.unitTypeName },
  { key: "sold", header: "已售間夜", align: "right", render: (r) => <span className="adm-num">{r.sold}</span> },
  { key: "available", header: "可售", align: "right", render: (r) => <span className="adm-num">{r.available ?? "—"}</span> },
  { key: "rate", header: "住房率", align: "right", render: (r) => <span className="adm-num">{r.rate === null ? "—" : `${Math.round(r.rate * 100)}%`}</span> },
  { key: "bar", header: "", render: (r) => (r.rate === null ? null : <Bar ratio={r.rate} label={`住房率 ${Math.round(r.rate * 100)}%`} />) },
];

const bookingColumns: Column<BookingReportRow>[] = [
  { key: "code", header: "訂單編號", render: (r) => <Link href={`/admin/reservations/${r.id}`}>{r.code}</Link> },
  { key: "guest", header: "旅客", render: (r) => r.guestName },
  { key: "room", header: "房型", render: (r) => r.roomName },
  { key: "stay", header: "入住 → 退房", render: (r) => <span className="adm-num">{r.checkIn} → {r.checkOut}</span> },
  { key: "status", header: "狀態", render: (r) => r.status },
  { key: "total", header: "總額", align: "right", render: (r) => <Money amount={r.total} /> },
  { key: "paid", header: "已收（淨額）", align: "right", render: (r) => <Money amount={r.paid} /> },
  { key: "promo", header: "折扣碼", render: (r) => (r.promoCode ? `${r.promoCode}（-NT$${r.discount}）` : "—") },
  { key: "addons", header: "加購", render: (r) => r.addons || "—" },
  { key: "plan", header: "方案", render: (r) => r.ratePlan },
];

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("reports.view");
  const propertyId = await currentProperty(ctx);
  const sp = await searchParams;

  const today = todayInTaipei();
  const kindParam = first(sp.kind);
  const kind: ReportKind = (REPORT_KINDS as readonly string[]).includes(kindParam ?? "") ? (kindParam as ReportKind) : "revenue";
  const from = first(sp.from) || `${today.slice(0, 8)}01`;
  const to = first(sp.to) || today;
  const groupBy = first(sp.groupBy) === "month" ? "month" : "day";
  const range = validateRange(from, to);

  const query = new URLSearchParams({ from, to, ...(kind === "revenue" ? { groupBy } : {}) });
  const csvHref = `/api/admin/reports/${kind}?${query}&format=csv`;
  const tabHref = (k: ReportKind) => `/admin/reports?${new URLSearchParams({ kind: k, from, to, groupBy })}`;

  return (
    <>
      <h1 className="adm-h1">報表</h1>
      <nav className="adm-tabs" aria-label="報表種類">
        {REPORT_KINDS.map((k) => (
          <Link key={k} href={tabHref(k)} aria-current={k === kind ? "page" : undefined}>{KIND_LABELS[k]}</Link>
        ))}
      </nav>
      <form method="get" className="adm-filter" aria-label="報表區間">
        <input type="hidden" name="kind" value={kind} />
        <label>起日<input type="date" name="from" defaultValue={from} required /></label>
        <label>迄日<input type="date" name="to" defaultValue={to} required /></label>
        {kind === "revenue" && (
          <label>
            分組
            <select name="groupBy" defaultValue={groupBy}>
              <option value="day">每日</option>
              <option value="month">每月</option>
            </select>
          </label>
        )}
        <span className="adm-filter-actions">
          <button type="submit" className="adm-btn adm-btn-primary">查詢</button>
          {range.ok && <a href={csvHref} className="adm-btn" download>匯出 CSV</a>}
        </span>
      </form>
      {!range.ok ? <p className="adm-form-error" role="alert">{RANGE_ERRORS[range.error]}</p> : await renderReport()}
    </>
  );

  async function renderReport() {
    const db = await getDb();
    const r = { from, to };
    if (kind === "revenue") {
      const rep = await revenueReport(db, propertyId, { ...r, groupBy });
      const max = Math.max(0, ...rep.rows.map((x) => x.net));
      return (
        <>
          <p className="adm-muted">依付款當天（台北時間）計算，淨額 = 收款 − 退款（線上與櫃檯）。只含官網訂單。</p>
          <DataTable columns={revenueColumns(max)} rows={[...rep.rows, { period: "合計", ...rep.total }]} rowKey={(x) => x.period} caption="營收" empty="這段期間沒有收款紀錄" />
        </>
      );
    }
    if (kind === "occupancy") {
      const rep = await occupancyReport(db, propertyId, r);
      return (
        <>
          <p className="adm-muted">住房率 = 已售間夜 ÷（已售 + 可售）；沒有庫存資料的日子顯示「—」。已售含已確認的訂單，以及已取消訂單中已經住過的夜晚。</p>
          <DataTable columns={occupancyColumns} rows={rep.rows} rowKey={(x) => `${x.date}|${x.unitTypeId}`} caption="住房率" />
        </>
      );
    }
    if (kind === "bookings") {
      const rep = await bookingsReport(db, propertyId, r);
      return (
        <>
          <p className="adm-muted">依入住日篩選，共 {rep.rows.length} 筆。{rep.rows.length > BOOKING_ROWS_SHOWN && `畫面只顯示前 ${BOOKING_ROWS_SHOWN} 筆，完整資料請匯出 CSV。`}</p>
          <DataTable columns={bookingColumns} rows={rep.rows.slice(0, BOOKING_ROWS_SHOWN)} rowKey={(x) => x.id} caption="訂單" />
        </>
      );
    }
    const rep = await cancellationReport(db, propertyId, r);
    const maxCount = Math.max(0, ...rep.buckets.map((b) => b.count));
    return (
      <>
        <dl className="adm-kpi">
          <div><dt>取消數</dt><dd>{rep.cancellations}</dd></div>
          <div><dt>取消率</dt><dd>{rep.rate === null ? "—" : `${Math.round(rep.rate * 1000) / 10}%`}</dd></div>
          <div><dt>退款總額</dt><dd><Money amount={rep.refundTotal} /></dd></div>
        </dl>
        <p className="adm-muted">取消數依取消當天計算。取消率 = 這段期間成立的訂單（{rep.rateBase} 筆，已確認或已取消）中後來取消的比例。</p>
        <DataTable
          columns={[
            { key: "label", header: "取消時距入住", render: (b) => b.label },
            { key: "count", header: "取消數", align: "right", render: (b) => <span className="adm-num">{b.count}</span> },
            { key: "bar", header: "", render: (b) => <Bar ratio={maxCount ? b.count / maxCount : 0} label={`${b.label}：${b.count}`} /> },
          ]}
          rows={rep.buckets} rowKey={(b) => b.label} caption="取消時距分布"
        />
      </>
    );
  }
}
