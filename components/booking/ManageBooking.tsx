"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { BookingSummary, EmailGate } from "./BookingSummary";
import { fetchStatus, recallBooking, rememberBooking, type StatusView } from "./client";
import { formatPrice } from "./format";

type Notice = { kind: "info" | "error"; text: string } | null;

/** One booking: its state, and online cancellation for confirmed bookings. */
export function ManageBooking({ code, hotelPhone, hotelEmail }: { code: string; hotelPhone: string; hotelEmail: string }) {
  const t = useTranslations("manage");
  const s = useTranslations("bookingStatus");
  const [email, setEmail] = useState<string | null>(null);
  const [view, setView] = useState<StatusView | null>(null);
  const [gateError, setGateError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async (addr: string): Promise<StatusView | null> => {
    setLoading(true);
    const r = await fetchStatus(code, addr);
    setLoading(false);
    if (r.ok) {
      setView(r.view);
      return r.view;
    }
    if (r.error === "NOT_FOUND") {
      setEmail(null);
      setGateError(s("notFound"));
    } else setNotice({ kind: "error", text: r.error === "RATE_LIMITED" ? s("rateLimited") : t("error") });
    return null;
  }, [code, s, t]);

  useEffect(() => {
    const addr = recallBooking(code)?.email;
    if (addr) {
      setEmail(addr);
      void load(addr);
    } else setLoading(false);
  }, [code, load]);

  async function cancel() {
    if (!email) return;
    setCancelling(true);
    setNotice(null);
    let res: Response | null = null;
    try {
      res = await fetch(`/api/bookings/${encodeURIComponent(code)}/cancel`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }),
      });
    } catch {
      res = null;
    }
    const json = (await res?.json().catch(() => ({}))) as { refunded?: number; frontDeskRefundDue?: number; error?: string } | undefined;
    // Whatever happened, show the booking as it is now.
    const now = await load(email);
    setCancelling(false);
    setConfirming(false);
    if (res?.ok) {
      const amount = json?.refunded ?? 0;
      const desk = json?.frontDeskRefundDue ? ` ${t("frontDeskRefund", { amount: formatPrice(json.frontDeskRefundDue) })}` : "";
      setNotice({ kind: "info", text: (amount > 0 ? t("cancelledRefund", { amount: formatPrice(amount) }) : t("cancelledNoRefund")) + desk });
    } else if (json?.error === "NOT_CANCELLABLE") {
      // Another request is cancelling it, or it moved on: say where it stands rather than "error".
      if (now?.status === "cancelled") setNotice({ kind: "info", text: t("cancelledNoRefund") });
      else if (now?.status === "confirmed") setNotice({ kind: "info", text: now.canCancel ? t("inProgress") : t("pastCheckIn") });
      else if (now) setNotice({ kind: "info", text: t("notCancellable", { status: s(`status_${now.status}`) }) });
    } else if (json?.error === "REFUND_FAILED") setNotice({ kind: "error", text: t("refundFailed") });
    else if (res?.status === 429) setNotice({ kind: "error", text: s("rateLimited") });
    else setNotice({ kind: "error", text: t("error") });
  }

  if (!email && !loading)
    return (
      <EmailGate
        error={gateError}
        onEmail={(addr) => {
          rememberBooking(code, { email: addr, body: recallBooking(code)?.body ?? null });
          setGateError(undefined);
          setEmail(addr);
          void load(addr);
        }}
      />
    );

  return (
    <div className="manage-booking">
      <p className="status-message" role="status" aria-live="polite">
        {loading && !view ? s("checking") : notice?.kind === "info" ? notice.text : ""}
      </p>
      {notice?.kind === "error" && (
        <p className="field-error" role="alert">
          {notice.text}
        </p>
      )}
      {view && <BookingSummary view={view} />}

      {view && (
        <section className="cancel-box" aria-labelledby="cancel-title">
          <h2 id="cancel-title">{t("cancelTitle")}</h2>
          {view.canCancel ? (
            <>
              <p>{view.refundIfCancelledNow > 0 ? t("refundPreview", { amount: formatPrice(view.refundIfCancelledNow) }) : t("noRefund")}</p>
              {confirming ? (
                <div className="cancel-actions">
                  <button type="button" className="cta" onClick={cancel} disabled={cancelling}>
                    {cancelling ? t("cancelling") : t("confirmCancel")}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => setConfirming(false)} disabled={cancelling}>
                    {t("keep")}
                  </button>
                </div>
              ) : (
                <button type="button" className="ghost-button" onClick={() => setConfirming(true)}>
                  {t("cancel")}
                </button>
              )}
            </>
          ) : (
            <p>{view.status === "cancelled" ? s("cancelled") : view.status === "confirmed" ? t("pastCheckIn") : t("onlineOnlyConfirmed")}</p>
          )}
          <p className="muted small">{t("contact", { phone: hotelPhone, email: hotelEmail })}</p>
        </section>
      )}

      <p className="link-row">
        <Link className="text-link" href="/manage">
          {t("another")}
        </Link>
      </p>
    </div>
  );
}
