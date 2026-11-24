"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "sent"; email: string } | { kind: "invalid"; fields: string[] } | { kind: "failed" };

const FIELDS = ["name", "email", "phone", "groupSize", "checkIn", "checkOut"] as const;
const TYPES: Record<(typeof FIELDS)[number], string> = { name: "text", email: "email", phone: "tel", groupSize: "number", checkIn: "date", checkOut: "date" };
const AUTOCOMPLETE: Partial<Record<(typeof FIELDS)[number], string>> = { name: "name", email: "email", phone: "tel" };
const REQUIRED = new Set(["name", "email", "groupSize", "checkIn", "checkOut"]);

/** Group / long-stay inquiry, posted to /api/inquiry. */
export function InquiryForm({ hotelEmail }: { hotelEmail: string }) {
  const t = useTranslations("inquiry");
  const locale = useLocale();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/inquiry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...data, groupSize: Number(data.groupSize), locale }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; fields?: string[] };
      if (json.ok) {
        setStatus({ kind: "sent", email: data.email });
        form.reset();
      } else if (json.error === "VALIDATION") setStatus({ kind: "invalid", fields: json.fields ?? [] });
      else setStatus({ kind: "failed" });
    } catch {
      setStatus({ kind: "failed" });
    }
  }

  const invalid = (f: string) => status.kind === "invalid" && status.fields.includes(f);

  return (
    <form className="inquiry" onSubmit={onSubmit} noValidate aria-labelledby="inquiry-title">
      <h2 id="inquiry-title">{t("title")}</h2>
      <p>{t("intro")}</p>
      <div className="inquiry-grid">
        {FIELDS.map((f) => (
          <label key={f} className={`inquiry-field inquiry-${f}`}>
            <span>
              {t(f)}
              {REQUIRED.has(f) && <small className="req">{t("required")}</small>}
            </span>
            <input
              name={f}
              type={TYPES[f]}
              required={REQUIRED.has(f)}
              autoComplete={AUTOCOMPLETE[f]}
              min={f === "groupSize" ? 1 : undefined}
              max={f === "groupSize" ? 200 : undefined}
              inputMode={f === "groupSize" ? "numeric" : undefined}
              aria-invalid={invalid(f) || undefined}
              aria-describedby={invalid(f) ? `${f}-error` : undefined}
            />
            {invalid(f) && (
              <em id={`${f}-error`} className="field-error">
                {t("fieldError")}
              </em>
            )}
          </label>
        ))}
        <label className="inquiry-field inquiry-message">
          <span>{t("message")}</span>
          <textarea name="message" rows={5} aria-describedby="message-hint" aria-invalid={invalid("message") || undefined} />
          <small id="message-hint">{t("messageHint")}</small>
        </label>
        <label className="hp" aria-hidden="true">
          {t("honeypot")}
          <input name="honeypot" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <button className="cta" type="submit" disabled={status.kind === "sending"}>
        {status.kind === "sending" ? t("sending") : t("submit")}
      </button>
      <p className="inquiry-status" role="status" aria-live="polite">
        {status.kind === "sent" && t("success", { email: status.email })}
        {status.kind === "invalid" && t("errorValidation")}
        {status.kind === "failed" && t("errorSend", { email: hotelEmail })}
      </p>
    </form>
  );
}
