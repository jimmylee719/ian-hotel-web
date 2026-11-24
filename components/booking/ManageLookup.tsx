"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { fetchStatus, recallBooking, rememberBooking } from "./client";

/** Booking code + email; on a match, opens /manage/[code] (the email stays in this tab, not in the URL). */
export function ManageLookup() {
  const t = useTranslations("manage");
  const s = useTranslations("bookingStatus");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const code = String(data.get("code") ?? "").trim().toUpperCase();
    const email = String(data.get("email") ?? "").trim();
    if (!code || !email) return setError(s("notFound"));
    setBusy(true);
    setError(null);
    const r = await fetchStatus(code, email);
    if (r.ok) {
      rememberBooking(r.view.code, { email, body: recallBooking(r.view.code)?.body ?? null });
      router.push(`/manage/${r.view.code}`);
      return;
    }
    setBusy(false);
    setError(r.error === "NOT_FOUND" ? s("notFound") : r.error === "RATE_LIMITED" ? s("rateLimited") : t("error"));
  }

  return (
    <form className="manage-lookup" onSubmit={onSubmit} noValidate>
      <label className="form-field">
        <span>{t("code")}</span>
        <input name="code" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="NK-" maxLength={12} required aria-describedby="code-hint" aria-invalid={!!error || undefined} />
        <small id="code-hint">{t("codeHint")}</small>
      </label>
      <label className="form-field">
        <span>{t("email")}</span>
        <input name="email" type="email" autoComplete="email" inputMode="email" required aria-invalid={!!error || undefined} aria-describedby={error ? "lookup-error" : undefined} />
      </label>
      <p id="lookup-error" className="field-error" role="alert">
        {error ?? ""}
      </p>
      <button className="cta" type="submit" disabled={busy}>
        {busy ? t("finding") : t("find")}
      </button>
    </form>
  );
}
