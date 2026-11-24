"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { BookingSummary, EmailGate } from "./BookingSummary";
import { fetchStatus, followChargeStart, recallBooking, rememberBooking, startBooking, type StatusView } from "./client";

const POLL_MS = 2000;
const POLL_FOR_MS = 60_000;
/** Wait after a 429 without Retry-After. */
const BACKOFF_MS = 5000;

/** States after which the status will not change by itself. */
const SETTLED = new Set(["confirmed", "confirm_failed_refunded", "expired", "cancelled"]);

type Phase = "needEmail" | "polling" | "done" | "timedOut";

/** Back from the payment page: poll the booking every 2 seconds for up to a minute and say where it stands. */
export function ReturnStatus({ code }: { code: string }) {
  const t = useTranslations("bookingStatus");
  const [email, setEmail] = useState<string | null>(null);
  const [view, setView] = useState<StatusView | null>(null);
  const [phase, setPhase] = useState<Phase>("polling");
  const [error, setError] = useState<string | undefined>();
  const [retrying, setRetrying] = useState(false);
  const [retryGone, setRetryGone] = useState(false);
  const run = useRef(0);

  const poll = useCallback(async (addr: string) => {
    const id = ++run.current;
    const until = Date.now() + POLL_FOR_MS;
    setPhase("polling");
    setError(undefined);
    while (id === run.current) {
      const r = await fetchStatus(code, addr);
      if (id !== run.current) return;
      if (!r.ok && r.error === "NOT_FOUND") {
        setPhase("needEmail");
        setError(t("notFound"));
        return;
      }
      if (r.ok) {
        setView(r.view);
        if (SETTLED.has(r.view.status) || (r.view.status === "pending_payment" && r.view.paymentState === "failed")) {
          setPhase("done");
          return;
        }
      }
      // Rate-limited: back off as asked (or 5 s), but still look once more before the minute is up.
      const wait = !r.ok && r.error === "RATE_LIMITED" ? r.retryAfterMs || BACKOFF_MS : POLL_MS;
      const left = until - Date.now();
      if (left <= 0) {
        setPhase("timedOut");
        return;
      }
      await new Promise((res) => setTimeout(res, Math.min(wait, Math.max(left - 500, 0))));
    }
  }, [code, t]);

  useEffect(() => {
    const runs = run; // a counter, not a DOM node: bumping it on unmount stops the poll loop
    const stored = recallBooking(code);
    if (stored?.email) {
      setEmail(stored.email);
      void poll(stored.email);
    } else setPhase("needEmail");
    return () => {
      runs.current++;
    };
  }, [code, poll]);

  async function retry() {
    const stored = recallBooking(code);
    if (!stored?.body) return setRetryGone(true);
    setRetrying(true);
    const r = await startBooking(stored.body);
    if (r.ok) return followChargeStart(r.start);
    setRetrying(false);
    setRetryGone(true);
  }

  if (phase === "needEmail")
    return (
      <EmailGate
        error={error}
        onEmail={(addr) => {
          rememberBooking(code, { email: addr, body: recallBooking(code)?.body ?? null });
          setEmail(addr);
          void poll(addr);
        }}
      />
    );

  const s = view?.status;
  const failed = s === "pending_payment" && view?.paymentState === "failed";
  return (
    <div className="return-status">
      <div className="status-message" role="status" aria-live="polite">
        {!view && <p>{t("checking")}</p>}
        {s === "confirmed" && (
          <>
            <h2>{t("confirmedTitle")}</h2>
            <p>{t("confirmedBody", { email: email ?? "" })}</p>
          </>
        )}
        {s === "paid_pending_confirm" && <p>{t("paidPending", { email: email ?? "" })}</p>}
        {s === "confirm_failed_refunded" && <p>{t("refunded")}</p>}
        {s === "expired" && <p>{t("expired")}</p>}
        {s === "cancelled" && <p>{t("cancelled")}</p>}
        {failed && <p>{t("failed")}</p>}
        {s === "pending_payment" && !failed && (phase === "timedOut" ? <p>{t("slow")}</p> : <p>{t("checking")}</p>)}
      </div>

      {failed && !retryGone && (
        <button type="button" className="cta" onClick={retry} disabled={retrying}>
          {t("retry")}
        </button>
      )}
      {retryGone && <p className="field-error">{t("retryGone")}</p>}
      {phase === "timedOut" && email && (
        <button type="button" className="ghost-button" onClick={() => void poll(email)}>
          {t("checkAgain")}
        </button>
      )}

      {view && <BookingSummary view={view} />}

      <p className="link-row">
        <Link className="text-link" href={`/manage/${code}`}>
          {t("manage")}
        </Link>
        {(s === "expired" || retryGone) && (
          <Link className="text-link" href="/book">
            {t("searchAgain")}
          </Link>
        )}
      </p>
    </div>
  );
}
