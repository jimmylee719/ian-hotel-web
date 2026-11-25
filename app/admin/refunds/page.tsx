import Link from "next/link";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { Money } from "@/components/admin/Money";
import { ReconcileRefundActions } from "@/components/admin/StaffActions";
import { requirePage } from "@/lib/admin/page-guard";
import { currentProperty } from "@/lib/admin/property-scope";
import { listPendingRefunds, type RefundListRow } from "@/lib/admin/reconcile";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "退款對帳" };

const taipei = (ms: number) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", dateStyle: "short", timeStyle: "medium" }).format(ms);

const columns = (status: "pending" | "failed"): Column<RefundListRow>[] => [
  { key: "at", header: "建立時間", render: (r) => <span className="adm-num">{taipei(r.createdAt)}</span> },
  { key: "code", header: "訂單編號", render: (r) => <Link href={`/admin/reservations/${r.reservationId}`}>{r.code}</Link> },
  { key: "amount", header: "金額", align: "right", render: (r) => <Money amount={r.amount} /> },
  { key: "key", header: "Idempotency key", render: (r) => <code>{r.idempotencyKey ?? "—"}</code> },
  { key: "actions", header: "處理", render: (r) => <ReconcileRefundActions paymentId={r.id} status={status} amount={r.amount} /> },
];

export default async function Page() {
  const ctx = await requirePage("payments.reconcile");
  const propertyId = await currentProperty(ctx);
  const db = await getDb();
  const [pending, failed] = await Promise.all([listPendingRefunds(db, propertyId), listPendingRefunds(db, propertyId, "failed")]);
  return (
    <>
      <h1 className="adm-h1">退款對帳</h1>
      <p className="adm-muted">
        「處理中」的退款已送出，但系統不知道結果（例如金流逾時）。請先到金流後台或銀行確認，再標記成功或失敗。
        標記成功後，等著這筆退款的取消或退款流程會自動完成。
      </p>
      <h2 className="adm-h2">處理中（結果未知）</h2>
      <DataTable columns={columns("pending")} rows={pending} rowKey={(r) => r.id} empty="沒有處理中的退款" />
      <h2 className="adm-h2">失敗（可重試）</h2>
      <DataTable columns={columns("failed")} rows={failed} rowKey={(r) => r.id} empty="沒有失敗的退款" />
    </>
  );
}
