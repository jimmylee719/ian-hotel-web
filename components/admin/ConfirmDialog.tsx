"use client";

import { useId, useRef, useState, type ReactNode } from "react";

/**
 * A button that asks "are you sure?" before running a risky action (cancel, refund, delete).
 * `onConfirm` may be async; the dialog stays open and disabled until it settles, then closes.
 * If it throws, the message is shown in the dialog and the action can be retried.
 */
export function ConfirmDialog({
  triggerLabel, title, children, confirmLabel, danger = false, onConfirm,
}: {
  triggerLabel: string;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      ref.current?.close();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "操作失敗，請再試一次");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={danger ? "adm-btn adm-btn-danger-ghost" : "adm-btn"} onClick={() => { setError(null); ref.current?.showModal(); }}>
        {triggerLabel}
      </button>
      <dialog ref={ref} className="adm-dialog" aria-labelledby={titleId} onCancel={(e) => busy && e.preventDefault()}>
        <h2 id={titleId}>{title}</h2>
        {children ? <div className="adm-dialog-body">{children}</div> : null}
        {error ? <p className="adm-form-error" role="alert">{error}</p> : null}
        <div className="adm-dialog-actions">
          <button type="button" className="adm-btn" disabled={busy} onClick={() => ref.current?.close()}>取消</button>
          <button type="button" className={danger ? "adm-btn adm-btn-danger" : "adm-btn adm-btn-primary"} disabled={busy} onClick={run}>
            {busy ? "處理中…" : confirmLabel}
          </button>
        </div>
      </dialog>
    </>
  );
}
