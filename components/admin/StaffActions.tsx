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
  reservationId, refund, frontDeskRefundDue, maxOverride, canOverride,
}: { reservationId: string; refund: number; frontDeskRefundDue: number; maxOverride: number; canOverride: boolean }) {
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
    const r = await post<{ refunded: number; frontDeskRefundDue?: number; alreadyCancelled: boolean; overrideIgnored?: boolean }>(
      `/api/admin/reservations/${encodeURIComponent(reservationId)}/cancel`, body);
    const desk = r.frontDeskRefundDue ? `，另需由櫃檯退款 ${formatMoney(r.frontDeskRefundDue)}` : "";
    show(r.alreadyCancelled
      ? `這筆訂單已經取消過了（線上已退 ${formatMoney(r.refunded)}${desk}）`
      : `已取消，線上退款 ${formatMoney(r.refunded)}${desk}${r.overrideIgnored ? "（先前已建立退款，依原金額處理，自訂金額未套用）" : ""}`);
    router.refresh();
  }

  return (
    <>
      <ConfirmDialog triggerLabel="取消" title="取消這筆訂單？" confirmLabel="確定取消" danger onConfirm={confirm}>
        <div className="adm-dialog-form">
          <p>
            依取消規則退款 <strong>{formatMoney(refund)}</strong>
            {frontDeskRefundDue > 0 ? <>，其中 <strong>{formatMoney(frontDeskRefundDue)}</strong> 是櫃檯收的款項，需由櫃檯退還（系統不會自動退）</> : null}
            。入住後取消只釋放今天以後的晚數。
          </p>
          <label htmlFor="cancel-reason">取消原因（必填）</label>
          <textarea id="cancel-reason" rows={3} required aria-required="true" value={reason} onChange={(e) => setReason(e.target.value)} />
          {canOverride ? (
            <>
              <label htmlFor="cancel-override">自訂退款總額（選填，0 到 {formatMoney(maxOverride)}；超過線上已收的部分由櫃檯退還；留空依規則）</label>
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

const METHOD_LABEL = { edc: "刷卡機", cash: "現金", transfer: "匯款" } as const;
type Method = keyof typeof METHOD_LABEL;

/** 登錄收款: money taken at the desk (card terminal, cash, transfer), at most the balance due. */
export function RecordFrontDeskPaymentAction({ reservationId, balanceDue }: { reservationId: string; balanceDue: number }) {
  const router = useRouter();
  const { show, view } = useToast();
  const [method, setMethod] = useState<Method>("cash");
  const [amount, setAmount] = useState(String(balanceDue));
  const [last4, setLast4] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [note, setNote] = useState("");

  async function confirm() {
    const n = Number(amount);
    if (!Number.isInteger(n) || n <= 0 || n > balanceDue) throw new Error(`收款金額必須是 1 到 ${formatMoney(balanceDue)} 之間的整數`);
    if (method === "edc" && !/^\d{4}$/.test(last4.trim())) throw new Error("請填寫卡號末四碼（4 位數字）");
    if (method === "edc" && !authCode.trim()) throw new Error("請填寫授權碼");
    const r = await post<{ balanceDue: number }>(`/api/admin/reservations/${encodeURIComponent(reservationId)}/payments`, {
      method, amount: n, note,
      ...(method === "edc" ? { last4, authCode } : {}),
    });
    show(`已登錄${METHOD_LABEL[method]}收款 ${formatMoney(n)}，待收 ${formatMoney(r.balanceDue)}`);
    router.refresh();
  }

  return (
    <>
      <ConfirmDialog triggerLabel="登錄收款" title="登錄櫃檯收款" confirmLabel="登錄" onConfirm={confirm}>
        <div className="adm-dialog-form">
          <p>待收 <strong>{formatMoney(balanceDue)}</strong>。櫃檯收款不經過線上金流，取消時也不會自動退款。</p>
          <label htmlFor="fd-method">收款方式</label>
          <select id="fd-method" value={method} onChange={(e) => setMethod(e.target.value as Method)}>
            {(Object.keys(METHOD_LABEL) as Method[]).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
          </select>
          <label htmlFor="fd-amount">金額</label>
          <input id="fd-amount" type="number" inputMode="numeric" min={1} max={balanceDue} step={1} required
            value={amount} onChange={(e) => setAmount(e.target.value)} />
          {method === "edc" ? (
            <>
              <label htmlFor="fd-last4">卡號末四碼（必填）</label>
              <input id="fd-last4" inputMode="numeric" pattern="\d{4}" maxLength={4} required aria-required="true"
                value={last4} onChange={(e) => setLast4(e.target.value)} />
              <label htmlFor="fd-auth">授權碼（必填）</label>
              <input id="fd-auth" maxLength={32} required aria-required="true" value={authCode} onChange={(e) => setAuthCode(e.target.value)} />
            </>
          ) : null}
          <label htmlFor="fd-note">備註（選填，例如匯款末五碼）</label>
          <input id="fd-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </ConfirmDialog>
      {view}
    </>
  );
}

/** 作廢 on a front-desk payment taken today (owner or manager): the row is kept as failed. */
export function VoidFrontDeskPaymentAction({ paymentId, amount }: { paymentId: string; amount: number }) {
  const router = useRouter();
  const { show, view } = useToast();
  const [reason, setReason] = useState("");
  async function confirm() {
    if (!reason.trim()) throw new Error("請填寫作廢原因");
    const r = await post<{ balanceDue: number }>(`/api/admin/payments/${encodeURIComponent(paymentId)}/void`, { reason });
    show(`已作廢，待收 ${formatMoney(r.balanceDue)}`);
    router.refresh();
  }
  return (
    <>
      <ConfirmDialog triggerLabel="作廢" title="作廢這筆櫃檯收款？" confirmLabel="作廢" danger onConfirm={confirm}>
        <div className="adm-dialog-form">
          <p>{formatMoney(amount)} 會改為失敗，不再算入已收；紀錄會保留。只能作廢今天登錄的收款。</p>
          <label htmlFor={`void-${paymentId}`}>作廢原因（必填）</label>
          <textarea id={`void-${paymentId}`} rows={2} required aria-required="true" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </ConfirmDialog>
      {view}
    </>
  );
}

type Stay = { checkIn: string; checkOut: string; adults: number; children: number };
type ModifyOptions = {
  unitTypes: { slug: string; name: string }[];
  ratePlans: { slug: string; name: string }[];
  current: { unitTypeSlug: string; ratePlanSlug: string };
};
type ModifyPreview = {
  newQuote: { nights: number; total: number };
  difference: number; refundIfLower: number; frontDeskRefundIfLower: number; balanceIfHigher: number;
};

/**
 * 修改訂單: new dates, guests, room type or rate plan. Staff first 試算 (preview, nothing changes); 確定修改 then
 * applies exactly that difference (the server answers PRICE_CHANGED if it moved meanwhile).
 */
export function ModifyReservationAction({ reservationId, stay, options }: { reservationId: string; stay: Stay; options: ModifyOptions }) {
  const router = useRouter();
  const { show, view } = useToast();
  const [form, setForm] = useState({ ...stay, ...options.current });
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{ key: string; p: ModifyPreview } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/admin/reservations/${encodeURIComponent(reservationId)}/modify`;
  const key = JSON.stringify(form);
  const current = preview?.key === key ? preview.p : null;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: k === "adults" || k === "children" ? Number(e.target.value) : e.target.value }));

  async function runPreview() {
    setBusy(true);
    setPreviewError(null);
    try {
      setPreview({ key, p: await post<ModifyPreview>(`${base}/preview`, form) });
    } catch (e) {
      setPreview(null);
      setPreviewError(e instanceof Error ? e.message : "試算失敗");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!current) throw new Error("請先按「試算差額」，確認新的金額後再修改");
    if (!reason.trim()) throw new Error("請填寫修改原因");
    const r = await post<{ difference: number; refunded: number; frontDeskRefundDue: number; balanceDue: number; refundFailed?: boolean }>(
      base, { ...form, expectedDifference: current.difference, reason });
    show(r.difference > 0 ? `已修改，待收 ${formatMoney(r.balanceDue)}`
      : r.difference < 0
        ? `已修改，線上退款 ${formatMoney(r.refunded)}${r.frontDeskRefundDue ? `，另需由櫃檯退款 ${formatMoney(r.frontDeskRefundDue)}` : ""}`
          + (r.refundFailed ? "（線上退款沒有完成，已通知管理者，請到退款對帳頁確認）" : "")
        : "已修改，金額不變");
    setPreview(null);
    router.refresh();
  }

  return (
    <>
      <ConfirmDialog triggerLabel="修改訂單" title="修改這筆訂單" confirmLabel="確定修改" onConfirm={confirm}>
        <div className="adm-dialog-form">
          <label htmlFor="mod-in">入住日</label>
          <input id="mod-in" type="date" required value={form.checkIn} onChange={set("checkIn")} />
          <label htmlFor="mod-out">退房日</label>
          <input id="mod-out" type="date" required value={form.checkOut} onChange={set("checkOut")} />
          <label htmlFor="mod-adults">成人</label>
          <input id="mod-adults" type="number" inputMode="numeric" min={1} max={12} step={1} value={form.adults} onChange={set("adults")} />
          <label htmlFor="mod-children">兒童</label>
          <input id="mod-children" type="number" inputMode="numeric" min={0} max={6} step={1} value={form.children} onChange={set("children")} />
          <label htmlFor="mod-unit">房型</label>
          <select id="mod-unit" value={form.unitTypeSlug} onChange={set("unitTypeSlug")}>
            {options.unitTypes.map((u) => <option key={u.slug} value={u.slug}>{u.name}</option>)}
          </select>
          <label htmlFor="mod-plan">方案</label>
          <select id="mod-plan" value={form.ratePlanSlug} onChange={set("ratePlanSlug")}>
            {options.ratePlans.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </select>
          <button type="button" className="adm-btn" disabled={busy} onClick={runPreview}>{busy ? "試算中…" : "試算差額"}</button>
          {previewError ? <p className="adm-form-error" role="alert">{previewError}</p> : null}
          {current ? (
            <p aria-live="polite">
              新總額 <strong>{formatMoney(current.newQuote.total)}</strong>（{current.newQuote.nights} 晚），差額{" "}
              <strong>{formatMoney(current.difference)}</strong>：
              {current.difference > 0 ? <>待收增加，修改後待收 <strong>{formatMoney(current.balanceIfHigher)}</strong>，由櫃檯收款。</>
                : current.difference < 0 ? (
                  <>線上退回 <strong>{formatMoney(current.refundIfLower)}</strong>
                    {current.frontDeskRefundIfLower > 0 ? <>，另 <strong>{formatMoney(current.frontDeskRefundIfLower)}</strong> 需由櫃檯退還</> : null}。</>
                ) : <>金額不變。</>}
            </p>
          ) : preview ? <p className="adm-muted">內容已變更，請重新試算。</p> : null}
          <label htmlFor="mod-reason">修改原因（必填）</label>
          <textarea id="mod-reason" rows={2} required aria-required="true" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </ConfirmDialog>
      {view}
    </>
  );
}
