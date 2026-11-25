"use client";

import { useEffect } from "react";

/**
 * A transient success or error message. Render it while `message` is set; it calls `onClose` after
 * `duration` ms (errors stay until dismissed) or when the close button is pressed.
 */
export function Toast({
  message, kind = "success", onClose, duration = 5000,
}: { message: string | null; kind?: "success" | "error"; onClose: () => void; duration?: number }) {
  useEffect(() => {
    if (!message || kind === "error") return;
    const t = setTimeout(onClose, duration);
    return () => clearTimeout(t);
  }, [message, kind, onClose, duration]);

  if (!message) return null;
  return (
    <div className={`adm-toast adm-toast-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span>{message}</span>
      <button type="button" onClick={onClose} aria-label="關閉訊息">×</button>
    </div>
  );
}
