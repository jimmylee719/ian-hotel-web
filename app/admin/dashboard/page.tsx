import Link from "next/link";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { Money } from "@/components/admin/Money";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { currentProperty } from "@/lib/admin/property-scope";
import { requirePage } from "@/lib/admin/page-guard";
import { alertHref, getDashboard, type AlertKind, type Kpi, type ReservationRow } from "@/lib/admin/dashboard";
import { getDb } from "@/lib/db/client";
import { todayInTaipei } from "@/lib/domain/dates";

export const metadata = { title: "總覽" };

const ALERT_LABEL: Record<AlertKind, string> = {
  stray_refund_failed: "無主款項退款失敗",
  payment_alert: "收款異常",
  refund_pending: "退款未完成",
  desk_refund_due: "櫃檯待退款",
  sync_failed: "通路同步失敗",
  sync_pending_stale: "通路同步逾時",
  email_failed: "通知信寄送失敗",
};

const taipeiTime = (ms: number) =>
  new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);

const stayColumns: Column<ReservationRow>[] = [
  { key: "code", header: "訂單編號", render: (r) => <Link href={`/admin/reservations/${r.id}`}>{r.code}</Link> },
  { key: "guest", header: "旅客", render: (r) => r.guestName },
  { key: "stay", header: "住宿日期", render: (r) => `${r.checkIn} → ${r.checkOut}` },
  { key: "pax", header: "人數", render: (r) => r.adults + r.children, align: "right" },
  { key: "total", header: "金額", render: (r) => <Money amount={r.totalAmount} />, align: "right" },
];

function KpiCard({ label, kpi }: { label: string; kpi: Kpi }) {
  return (
    <section className="adm-card" aria-label={label}>
      <h2 className="adm-h2">{label}</h2>
      <dl className="adm-kpi">
        <div><dt>直訂營收</dt><dd><Money amount={kpi.revenue} /></dd></div>
        <div><dt>間夜數</dt><dd className="adm-num">{kpi.nights}</dd></div>
        <div><dt>取消數</dt><dd className="adm-num">{kpi.cancellations}</dd></div>
      </dl>
    </section>
  );
}

export default async function Page() {
  const ctx = await requirePage("dashboard.view");
  const propertyId = await currentProperty(ctx);
  const now = new Date();
  const d = await getDashboard(await getDb(), propertyId, now);

  return (
    <>
      <h1 className="adm-h1">總覽 <span className="adm-muted adm-num">{todayInTaipei(now)}</span></h1>

      <section aria-label="警示">
        <h2 className="adm-h2">警示</h2>
        {d.alerts.length === 0 ? (
          <p className="adm-muted">目前沒有需要處理的警示。</p>
        ) : (
          <ul className="adm-alerts">
            {d.alerts.map((a, i) => (
              <li key={`${a.kind}-${a.reservationId ?? a.code ?? i}-${a.since}`}>
                <Link href={alertHref(a)}>
                  <span className="adm-badge adm-badge-red">{ALERT_LABEL[a.kind]}</span>{" "}
                  {a.code ? <strong>{a.code}</strong> : null} {a.detail}{" "}
                  <span className="adm-muted adm-num">{taipeiTime(a.since)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="adm-grid">
        <KpiCard label="今日" kpi={d.kpis.today} />
        <KpiCard label="本月" kpi={d.kpis.month} />
        <section className="adm-card" aria-label="待付款">
          <h2 className="adm-h2">待付款訂單</h2>
          <p className="adm-kpi-num adm-num">{d.pendingPayment}</p>
          <StatusBadge status="pending_payment" />
        </section>
      </div>

      <h2 className="adm-h2">今日入住（{d.arrivalsToday.length}）</h2>
      <DataTable columns={stayColumns} rows={d.arrivalsToday} rowKey={(r) => r.id} empty="今天沒有入住" />
      <h2 className="adm-h2">今日退房（{d.departuresToday.length}）</h2>
      <DataTable columns={stayColumns} rows={d.departuresToday} rowKey={(r) => r.id} empty="今天沒有退房" />
      <h2 className="adm-h2">住房中（{d.inHouse.length}）</h2>
      <DataTable columns={stayColumns} rows={d.inHouse} rowKey={(r) => r.id} empty="目前沒有住房中的旅客" />
    </>
  );
}
