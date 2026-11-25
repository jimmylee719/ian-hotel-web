import Link from "next/link";
import { notFound } from "next/navigation";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { DateRange } from "@/components/admin/DateRange";
import { Money } from "@/components/admin/Money";
import {
  CancelReservationAction, ModifyReservationAction, RecordFrontDeskPaymentAction, RecordFrontDeskRefundAction,
  ResendNotificationAction,
  VoidFrontDeskPaymentAction,
} from "@/components/admin/StaffActions";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { canVoidFrontDesk, frontDeskOpen, voidableOn } from "@/lib/admin/front-desk";
import { modifyFormOptions } from "@/lib/admin/modify";
import { can } from "@/lib/admin/permissions";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { getReservationDetail, NOTE_MAX, type ReservationDetail } from "@/lib/admin/reservations";
import { staffCancelPreview } from "@/lib/admin/staff-cancel";
import { getDb } from "@/lib/db/client";
import { todayInTaipei } from "@/lib/domain/dates";
import { addNoteAction } from "./actions";

export const metadata = { title: "訂單詳情" };

const taipei = (ms: number) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", dateStyle: "short", timeStyle: "medium" }).format(ms);

const NOTE_ERRORS: Record<string, string> = {
  NOTE_EMPTY: "備註不能是空的。",
  NOTE_TOO_LONG: `備註最多 ${NOTE_MAX} 字。`,
  NOT_FOUND: "找不到這筆訂單。",
};

type Quote = { roomSubtotal?: number; addonSubtotal?: number; discount?: number; total?: number; payNow?: number; payLater?: number; promoCode?: string };

type PaymentRow = ReservationDetail["payments"][number];

const paymentColumns = (voidable: (p: PaymentRow) => boolean): Column<PaymentRow>[] => [
  { key: "at", header: "時間", render: (p) => <span className="adm-num">{taipei(p.createdAt)}</span> },
  { key: "kind", header: "類型", render: (p) => p.kind },
  { key: "method", header: "方式", render: (p) => p.method },
  { key: "status", header: "狀態", render: (p) => p.status },
  { key: "amount", header: "金額", align: "right", render: (p) => <Money amount={p.kind === "refund" ? -p.amount : p.amount} /> },
  { key: "last4", header: "末四碼", render: (p) => p.last4 ?? "—" },
  { key: "auth", header: "授權碼", render: (p) => p.authCode ?? "—" },
  { key: "key", header: "Idempotency key", render: (p) => <code>{p.idempotencyKey ?? "—"}</code> },
  { key: "note", header: "備註", render: (p) => p.note ?? "—" },
  { key: "void", header: "", render: (p) => (voidable(p) ? <VoidFrontDeskPaymentAction paymentId={p.id} amount={p.amount} /> : null) },
];

const eventColumns: Column<ReservationDetail["events"][number]>[] = [
  { key: "at", header: "時間", render: (e) => <span className="adm-num">{taipei(e.at)}</span> },
  { key: "provider", header: "金流", render: (e) => e.provider },
  { key: "ref", header: "交易編號", render: (e) => e.providerRef ?? "—" },
  { key: "verdict", header: "判定", render: (e) => e.verdict },
  { key: "len", header: "內容長度", align: "right", render: (e) => <span className="adm-num">{e.bodyLength}</span> },
];

const notificationColumns = (canResend: boolean): Column<ReservationDetail["notifications"][number]>[] => [
  { key: "at", header: "時間", render: (n) => <span className="adm-num">{taipei(n.at)}</span> },
  { key: "kind", header: "類型", render: (n) => n.kind },
  { key: "to", header: "收件人", render: (n) => n.to },
  { key: "status", header: "狀態", render: (n) => n.status },
  ...(canResend ? [{
    key: "resend", header: "", render: (n: ReservationDetail["notifications"][number]) =>
      n.status === "failed" ? <ResendNotificationAction notificationId={n.id} to={n.to} /> : null,
  }] : []),
];

export default async function Page({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ noteError?: string }> }) {
  const ctx = await requirePage("reservations.view");
  const propertyId = await currentProperty(ctx);
  const { id } = await params;
  const { noteError } = await searchParams;
  const db = await getDb();
  const d = await getReservationDetail(db, propertyId, id);
  if (!d) notFound();
  const r = d.reservation;
  const cancelPreview = can(ctx.staff, "reservations.cancel", propertyId) ? await staffCancelPreview(db, r.id, new Date()) : null;
  const quote = (d.quote ?? {}) as Quote;
  const now = new Date();
  // Desk money moves only while no cancellation has started (the server enforces the same rule).
  const deskOpen = await frontDeskOpen(db, r.id);
  const mayVoid = deskOpen && canVoidFrontDesk(ctx.staff, propertyId);
  const voidable = (p: PaymentRow) => mayVoid && p.kind === "front_desk" && p.status === "succeeded" && voidableOn(p.createdAt, now);
  const canTakePayment = deskOpen && d.money.balanceDue !== null && d.money.balanceDue > 0
    && can(ctx.staff, "payments.front_desk", propertyId);
  // The server re-checks everything (including no other modification in flight); this only hides a button that cannot work.
  // The desk pays money back on an open or a cancelled booking (not mid-cancel; the server enforces the same rule).
  const canPayOut = r.frontDeskRefundDue > 0 && (deskOpen || r.status === "cancelled") && can(ctx.staff, "payments.front_desk", propertyId);
  // OTA bookings are changed through the OTA / SiteMinder, not here.
  const modifyOptions = deskOpen && r.channel !== "siteminder_ota" && todayInTaipei(now) <= r.checkIn
    && can(ctx.staff, "reservations.modify", propertyId)
    ? await modifyFormOptions(db, propertyId, r.id) : null;

  return (
    <>
      <p className="adm-muted"><Link href="/admin/reservations">← 訂單列表</Link></p>
      <h1 className="adm-h1">
        {r.code} <StatusBadge status={r.status} /> <StatusBadge status={r.syncState} kind="sync" />
      </h1>

      <div className="adm-actions" role="group" aria-label="訂單操作">
        {cancelPreview?.modifyRefundPending ? (
          <span>
            <button type="button" className="adm-btn" disabled aria-describedby="cancel-blocked">取消</button>{" "}
            <span id="cancel-blocked" className="adm-muted">修改產生的退款尚未完成，請先到<Link href="/admin/refunds">退款對帳</Link>處理。</span>
          </span>
        ) : cancelPreview ? (
          <CancelReservationAction reservationId={r.id} refund={cancelPreview.refund}
            frontDeskRefundDue={cancelPreview.frontDeskRefundDue} maxOverride={cancelPreview.maxOverride}
            canOverride={can(ctx.staff, "reservations.refund_override", propertyId)} />
        ) : null}
        {canTakePayment ? <RecordFrontDeskPaymentAction reservationId={r.id} balanceDue={d.money.balanceDue!} /> : null}
        {canPayOut ? <RecordFrontDeskRefundAction reservationId={r.id} deskDue={r.frontDeskRefundDue} /> : null}
        {modifyOptions ? (
          <ModifyReservationAction reservationId={r.id} options={modifyOptions}
            stay={{ checkIn: r.checkIn, checkOut: r.checkOut, adults: r.adults, children: r.children }} />
        ) : null}
      </div>

      <div className="adm-grid">
        <section className="adm-card" aria-label="訂單資訊">
          <h2 className="adm-h2">訂單資訊</h2>
          <dl className="adm-dl">
            <dt>住宿</dt><dd><DateRange checkIn={r.checkIn} checkOut={r.checkOut} /></dd>
            <dt>人數</dt><dd>成人 {r.adults}、兒童 {r.children}</dd>
            <dt>通路</dt><dd>{r.channel}</dd>
            <dt>語言</dt><dd>{r.locale}</dd>
            <dt>建立</dt><dd className="adm-num">{taipei(r.createdAt)}</dd>
            {r.cancelledAt ? (<><dt>取消</dt><dd className="adm-num">{taipei(r.cancelledAt)}</dd></>) : null}
            {r.smConfirmation ? (<><dt>通路確認碼</dt><dd>{r.smConfirmation}</dd></>) : null}
            {r.lastSyncError ? (<><dt>同步錯誤</dt><dd>{r.lastSyncError}</dd></>) : null}
          </dl>
        </section>
        <section className="adm-card" aria-label="旅客">
          <h2 className="adm-h2">旅客</h2>
          <dl className="adm-dl">
            <dt>姓名</dt><dd><Link href={`/admin/guests/${d.guest.id}`}>{d.guest.name}</Link></dd>
            <dt>Email</dt><dd>{d.guest.email}</dd>
            <dt>電話</dt><dd>{d.guest.phone}</dd>
            <dt>國家</dt><dd>{d.guest.country}</dd>
          </dl>
        </section>
        <section className="adm-card" aria-label="金額">
          <h2 className="adm-h2">金額</h2>
          <dl className="adm-dl">
            <dt>總額</dt><dd><Money amount={r.totalAmount} /></dd>
            <dt>已收（淨額）</dt><dd><Money amount={d.money.paid} /></dd>
            <dt>已退</dt><dd><Money amount={d.money.refunded} /></dd>
            <dt>待收</dt><dd>{d.money.balanceDue !== null ? <Money amount={d.money.balanceDue} /> : <span className="adm-muted">—</span>}</dd>
            <dt>已收款（退款前）</dt><dd className="adm-muted"><Money amount={d.money.grossReceived} /></dd>
            {r.frontDeskRefundDue > 0 ? (
              <><dt>需由櫃檯退款</dt><dd><Money amount={r.frontDeskRefundDue} /> <span className="adm-muted">（櫃檯收款不會自動退回）</span></dd></>
            ) : null}
          </dl>
        </section>
      </div>

      <h2 className="adm-h2">房型與方案</h2>
      <ul className="adm-plain">
        {d.rooms.map((x, i) => (
          <li key={i}>{x.unitTypeName}・{x.ratePlanName} <span className="adm-muted adm-num">每晚 {x.nightlyPrices.join(" / ")}</span></li>
        ))}
      </ul>

      <h2 className="adm-h2">報價明細</h2>
      <dl className="adm-dl adm-dl-narrow">
        <dt>房價小計</dt><dd><Money amount={quote.roomSubtotal ?? 0} /></dd>
        <dt>加購小計</dt><dd><Money amount={quote.addonSubtotal ?? 0} /></dd>
        <dt>折扣{quote.promoCode ? `（${quote.promoCode}）` : ""}</dt><dd><Money amount={-(quote.discount ?? 0)} /></dd>
        <dt>總額</dt><dd><Money amount={quote.total ?? r.totalAmount} /></dd>
        <dt>應付現在 / 到店</dt><dd><Money amount={quote.payNow ?? 0} /> / <Money amount={quote.payLater ?? 0} /></dd>
      </dl>

      <h2 className="adm-h2">付款紀錄</h2>
      <DataTable columns={paymentColumns(voidable)} rows={d.payments} rowKey={(p) => p.id} empty="沒有付款紀錄" />
      <h2 className="adm-h2">收款回呼</h2>
      <DataTable columns={eventColumns} rows={d.events} rowKey={(e) => e.id} empty="沒有收款回呼" />
      <h2 className="adm-h2">通知信</h2>
      <DataTable columns={notificationColumns(can(ctx.staff, "notifications.resend", propertyId))} rows={d.notifications} rowKey={(n) => n.id} empty="沒有通知信" />

      <h2 className="adm-h2">內部備註</h2>
      {d.notes.length === 0 ? <p className="adm-muted">還沒有備註。</p> : (
        <ul className="adm-notes">
          {d.notes.map((n) => (
            <li key={n.id}><span className="adm-muted adm-num">{taipei(n.createdAt)}・{n.staffEmail}</span><p>{n.body}</p></li>
          ))}
        </ul>
      )}
      <form action={addNoteAction.bind(null, r.id)} className="adm-note-form">
        <label htmlFor="note-body">新增備註（只能新增，不能修改或刪除）</label>
        <textarea id="note-body" name="body" rows={3} maxLength={NOTE_MAX} required />
        {noteError ? <p className="adm-form-error" role="alert">{NOTE_ERRORS[noteError] ?? "無法新增備註。"}</p> : null}
        <button type="submit" className="adm-btn adm-btn-primary">新增備註</button>
      </form>

      <h2 className="adm-h2">時間軸</h2>
      {d.timeline.length === 0 ? <p className="adm-muted">沒有紀錄。</p> : (
        <ol className="adm-timeline">
          {d.timeline.map((t) => (
            <li key={`${t.type}-${t.id}`}>
              <span className="adm-muted adm-num">{taipei(t.at)}</span>{" "}
              <span className="adm-badge adm-badge-grey">{TYPE_LABEL[t.type]}</span> {t.title}
              {t.detail ? <span className="adm-muted">　{t.detail}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

const TYPE_LABEL = { payment: "付款", event: "回呼", notification: "通知", audit: "操作", note: "備註" } as const;
