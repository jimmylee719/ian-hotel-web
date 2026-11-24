"use client";

import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/lib/db/schema";
import type { StatusView } from "./client";
import { formatPrice } from "./format";
import { StayFolio } from "./StayFolio";

/** A booking as the guest sees it on the return and manage pages. */
export function BookingSummary({ view }: { view: StatusView }) {
  const t = useTranslations("bookingStatus");
  const locale = useLocale() as Locale;
  return (
    <div className="booking-summary">
      <StayFolio
        code={view.code}
        checkIn={view.checkIn}
        checkOut={view.checkOut}
        nights={view.quote.nights}
        adults={view.adults}
        childCount={view.children}
        rooms={view.rooms}
        roomName={view.roomTypeName[locale]}
        planName={view.ratePlanName[locale]}
      />
      <dl className="price-lines">
        <div>
          <dt>{t("state")}</dt>
          <dd>
            <span className={`status-tag status-${view.status}`}>{t(`status_${view.status}`)}</span>
          </dd>
        </div>
        <div className="grand">
          <dt>{t("total")}</dt>
          <dd>{formatPrice(view.quote.total)}</dd>
        </div>
        {view.paid + view.refunded > 0 && (
          <div>
            <dt>{t("paid")}</dt>
            <dd>{formatPrice(view.paid + view.refunded)}</dd>
          </div>
        )}
        {view.refunded > 0 && (
          <div>
            <dt>{t("refundedAmount")}</dt>
            <dd>{formatPrice(view.refunded)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** "Enter the email you booked with" — for when this browser doesn't know it. */
export function EmailGate({ onEmail, error, busy }: { onEmail: (email: string) => void; error?: string; busy?: boolean }) {
  const t = useTranslations("bookingStatus");
  const m = useTranslations("manage");
  return (
    <form
      className="email-gate"
      onSubmit={(e) => {
        e.preventDefault();
        const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
        if (email) onEmail(email);
      }}
    >
      <p>{t("needEmail")}</p>
      <label className="form-field">
        <span>{m("email")}</span>
        <input name="email" type="email" autoComplete="email" required aria-invalid={!!error || undefined} aria-describedby={error ? "gate-error" : undefined} />
      </label>
      {error && (
        <em id="gate-error" className="field-error" role="alert">
          {error}
        </em>
      )}
      <button className="cta" type="submit" disabled={busy}>
        {t("show")}
      </button>
    </form>
  );
}
