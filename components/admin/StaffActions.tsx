"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { formatMoney } from "./Money";
import { Toast } from "./Toast";

/** POST JSON to an admin API route; a failed answer throws its `message` (shown in the dialog). */
async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as ({ message?: string } & T) | null;
  if (!res.ok || !json) throw new Error(json?.message ?? "操作失敗，請再試一次");
  return json;
}

function useToast() {
  const [toast, setToast] = useState<string | null>(null);
  const close = useCallback(() => setToast(null), []);
  return { toast, show: setToast, view: <Toast message={toast} onClose={close} /> };
}

/** The 取消 button on a reservation: reason (required), optional refund override, and whether to email the guest. */
export function CancelReservationAction({
  reservationId, refund, maxOverride, canOverride,
}: { reservationId: string; refund: number; maxOverride: number; canOverride: boolean }) {
  const router = useRouter();
  const { show, view } = useToast();
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState("");
  const [notifyGuest, setNotifyGuest] = useState(true);

  async function confirm() {
    if (!reason.trim()) throw new Error("請填寫取消原因");
    const body: Record<string, unknown> = { reason, notifyGuest };
    if (canOverride && override.trim() !== "") {
      const n = Number(override);
      if (!Number.isInteger(n) || n < 0 || n > maxOverride) throw new Error(`退款金額必須是 0 到 ${formatMoney(maxOverride)} 之間的整數`);
      body.refundOverride = n;
    }
    const r = await post<{ refunded: number; alreadyCancelled: boolean; overrideIgnored?: boolean }>(
      `/api/admin/reservations/${encodeURIComponent(reservationId)}/cancel`, body);
    show(r.alreadyCancelled
      ? `這筆訂單已經取消過了（已退 ${formatMoney(r.refunded)}）`
      : `已取消，退款 ${formatMoney(r.refunded)}${r.overrideIgnored ? "（先前已建立退款，依原金額處理，自訂金額未套用）" : ""}`);
    router.refresh();
  }

  return (
    <>
      <ConfirmDialog triggerLabel="取消" title="取消這筆訂單？" confirmLabel="確定取消" danger onConfirm={confirm}>
        <div className="adm-dialog-form">
          <p>依取消規則退款 <strong>{formatMoney(refund)}</strong>。入住後取消只釋放今天以後的晚數。</p>
          <label htmlFor="cancel-reason">取消原因（必填）</label>
          <textarea id="cancel-reason" rows={3} required aria-required="true" value={reason} onChange={(e) => setReason(e.target.value)} />
          {canOverride ? (
            <>
              <label htmlFor="cancel-override">自訂退款金額（選填，0 到 {formatMoney(maxOverride)}；留空依規則）</label>
              <input id="cancel-override" type="number" inputMode="numeric" min={0} max={maxOverride} step={1}
                value={override} onChange={(e) => setOverride(e.target.value)} />
            </>
          ) : null}
          <label className="adm-check">
            <input type="checkbox" checked={notifyGuest} onChange={(e) => setNotifyGuest(e.target.checked)} /> 寄取消通知信給旅客
          </label>
        </div>
      </ConfirmDialog>
      {view}
    </>
  );
}

/** 重寄 on a failed notification row. */
export function ResendNotificationAction({ notificationId, to }: { notificationId: string; to: string }) {
  const router = useRouter();
  const { show, view } = useToast();
  async function confirm() {
    const r = await post<{ status: "sent" | "failed" }>(`/api/admin/notifications/${encodeURIComponent(notificationId)}/resend`, {});
    if (r.status === "failed") throw new Error("郵件服務仍然拒絕寄送，請稍後再試");
    show("已重寄");
    router.refresh();
  }
  return (
    <>
      <ConfirmDialog triggerLabel="重寄" title="重寄這封通知信？" confirmLabel="重寄" onConfirm={confirm}>
        <p>會依訂單目前的內容重新產生信件，寄到 {to}。</p>
      </ConfirmDialog>
      {view}
    </>
  );
}

/** The reconcile actions on one refund row: pending → mark succeeded / mark failed; failed → retry. */
export function ReconcileRefundActions({ paymentId, status, amount }: { paymentId: string; status: "pending" | "failed"; amount: number }) {
  const router = useRouter();
  const { show, view } = useToast();
  const [providerRef, setProviderRef] = useState("");
  const url = `/api/admin/refunds/${encodeURIComponent(paymentId)}/reconcile`;
  const done = (r: { completed: string | null; reservationStatus?: string }, text: string) => {
    show(r.completed === "cancellation" ? `${text}，訂單已完成取消`
      : r.completed === "refund_and_fail" ? `${text}，訂單已結案並通知旅客`
      : `${text}（訂單狀態：${r.reservationStatus ?? "未變"}）`);
    router.refresh();
  };

  if (status === "failed")
    return (
      <>
        <ConfirmDialog triggerLabel="重試退款" title="重試這筆退款？" confirmLabel="重試"
          onConfirm={async () => done(await post(url, { kind: "retry" }), "已重試，退款成功")}>
          <p>會用原本的退款編號（idempotency key）再向金流退款 {formatMoney(amount)}。</p>
        </ConfirmDialog>
        {view}
      </>
    );
  return (
    <>
      <ConfirmDialog triggerLabel="標記已退款" title="確認銀行已退款？" confirmLabel="標記已退款"
        onConfirm={async () => {
          if (!providerRef.trim()) throw new Error("請填寫退款交易編號");
          done(await post(url, { kind: "mark_succeeded", providerRef }), "已標記為退款成功");
        }}>
        <div className="adm-dialog-form">
          <p>只有在金流後台或銀行確認這筆 {formatMoney(amount)} 已退回後才標記。</p>
          <label htmlFor={`ref-${paymentId}`}>退款交易編號（必填）</label>
          <input id={`ref-${paymentId}`} required aria-required="true" value={providerRef} onChange={(e) => setProviderRef(e.target.value)} />
        </div>
      </ConfirmDialog>{" "}
      <ConfirmDialog triggerLabel="標記失敗" title="確認這筆退款沒有成功？" confirmLabel="標記失敗" danger
        onConfirm={async () => done(await post(url, { kind: "mark_failed" }), "已標記為失敗，可以重試")}>
        <p>只會把狀態改成失敗，不會自動重試。之後可以在這裡按「重試退款」。</p>
      </ConfirmDialog>
      {view}
    </>
  );
}
