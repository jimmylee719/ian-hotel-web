"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { Quote } from "@/lib/domain/quote";
import { followChargeStart, rememberBooking, startBooking } from "./client";
import { countryOptions, DIAL_CODES, LOCALE_COUNTRY } from "./countries";
import { formatPrice } from "./format";
import { clearKey, idempotencyKeyFor, retryWithFreshKey, sessionStore, type StaySelection } from "./idempotency";
import { StayFolio } from "./StayFolio";

export type Stay = {
  propertySlug: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  rooms: number;
  unitTypeSlug: string;
  ratePlanSlug: string;
  roomName: string;
  planName: string;
  includesBreakfast: boolean;
};
export type AddonOption = { id: string; slug: string; name: string; price: number; unit: "per_stay" | "per_night" | "per_person_night" };

type Fields = { lastName: string; firstName: string; email: string; dial: string; phone: string; country: string };
type FieldName = keyof Fields | "terms";
type Promo = { input: string; applied: string; state: "none" | "applied" | "invalid" };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Add-ons, promo code, guest details and terms; prices live from /api/quote; submits to /api/bookings. */
export function BookingForm({ stay, addons, initialQuote, policyText }: { stay: Stay; addons: AddonOption[]; initialQuote: Quote; policyText: string }) {
  const t = useTranslations("checkout");
  const locale = useLocale();
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const home = LOCALE_COUNTRY[locale] ?? "";

  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [promo, setPromo] = useState<Promo>({ input: "", applied: "", state: "none" });
  const [quote, setQuote] = useState<Quote>(initialQuote);
  const [quoting, setQuoting] = useState(false);
  const [fields, setFields] = useState<Fields>({ lastName: "", firstName: "", email: "", dial: DIAL_CODES[home] ?? "", phone: "", country: home });
  const [terms, setTerms] = useState(false);
  const [invalid, setInvalid] = useState<Set<FieldName>>(new Set());
  const [status, setStatus] = useState<{ kind: "idle" | "submitting" } | { kind: "error"; message: string }>({ kind: "idle" });
  const quoteSeq = useRef(0);

  // One key per stay selection, kept in sessionStorage: a double submit, or coming back from the
  // payment page and submitting again, replays the same booking instead of holding a second one.
  // Keys expire with the 20-minute hold (KEY_TTL_MS), so a lapsed booking is never replayed.
  const addonSig = addons.filter((a) => selected[a.slug]).map((a) => a.slug).join(",");
  const selection = (): StaySelection => ({
    propertySlug: stay.propertySlug, unitTypeSlug: stay.unitTypeSlug, ratePlanSlug: stay.ratePlanSlug,
    checkIn: stay.checkIn, checkOut: stay.checkOut, adults: stay.adults, children: stay.children, rooms: stay.rooms,
    addons: addonSig ? addonSig.split(",").map((slug) => ({ slug, qty: 1 })) : [],
  });
  const currentKey = () => idempotencyKeyFor(selection(), sessionStore(), () => crypto.randomUUID());
  useEffect(() => {
    setIdempotencyKey(currentKey());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- currentKey only reads the values listed
  }, [addonSig, stay.propertySlug, stay.unitTypeSlug, stay.ratePlanSlug, stay.checkIn, stay.checkOut, stay.adults, stay.children, stay.rooms]);

  const chosenAddons = addons.filter((a) => selected[a.slug]).map((a) => ({ slug: a.slug, qty: 1 }));
  const priceBody = (promoCode: string, list = chosenAddons) => ({
    propertySlug: stay.propertySlug, checkIn: stay.checkIn, checkOut: stay.checkOut,
    adults: stay.adults, children: stay.children, rooms: stay.rooms,
    unitTypeSlug: stay.unitTypeSlug, ratePlanSlug: stay.ratePlanSlug,
    addons: list, ...(promoCode ? { promoCode } : {}),
  });

  async function requote(promoCode: string, list = chosenAddons): Promise<"none" | "applied" | "invalid" | null> {
    const seq = ++quoteSeq.current;
    setQuoting(true);
    try {
      const res = await fetch("/api/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(priceBody(promoCode, list)) });
      if (seq !== quoteSeq.current) return null;
      if (res.status === 409) {
        setStatus({ kind: "error", message: t("errorGone") });
        return null;
      }
      if (!res.ok) return null;
      const json = (await res.json()) as { quote: Quote; promo: "none" | "applied" | "invalid" };
      setQuote(json.quote);
      return json.promo;
    } catch {
      return null;
    } finally {
      if (seq === quoteSeq.current) setQuoting(false);
    }
  }

  function toggleAddon(slug: string, on: boolean) {
    const next = { ...selected, [slug]: on };
    setSelected(next);
    void requote(promo.applied, addons.filter((a) => next[a.slug]).map((a) => ({ slug: a.slug, qty: 1 })));
  }

  async function applyPromo() {
    const code = promo.input.trim().toUpperCase();
    if (!code) return;
    const r = await requote(code);
    if (r) setPromo({ input: code, applied: r === "applied" ? code : "", state: r });
  }

  function removePromo() {
    setPromo({ input: "", applied: "", state: "none" });
    void requote("");
  }

  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.value;
    setFields((f) => ({ ...f, [k]: v, ...(k === "country" && DIAL_CODES[v] && !f.phone ? { dial: DIAL_CODES[v] } : {}) }));
    setInvalid((s) => {
      const n = new Set(s);
      n.delete(k);
      return n;
    });
  };

  function validate(): Set<FieldName> {
    const bad = new Set<FieldName>();
    if (!fields.lastName.trim()) bad.add("lastName");
    if (!fields.firstName.trim()) bad.add("firstName");
    if (!EMAIL_RE.test(fields.email.trim())) bad.add("email");
    if (!/^\+?\d{1,4}$/.test(fields.dial.trim())) bad.add("dial");
    if (fields.phone.replace(/[\s()-]/g, "").length < 5) bad.add("phone");
    if (!fields.country) bad.add("country");
    if (!terms) bad.add("terms");
    return bad;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const bad = validate();
    setInvalid(bad);
    if (bad.size) {
      setStatus({ kind: "error", message: bad.size === 1 && bad.has("terms") ? t("termsRequired") : t("errorFields") });
      document.querySelector<HTMLElement>(`[name="${[...bad][0]}"]`)?.focus();
      return;
    }
    if (!idempotencyKey) return;
    setStatus({ kind: "submitting" });
    const dial = fields.dial.trim().startsWith("+") ? fields.dial.trim() : `+${fields.dial.trim()}`;
    const bodyWith = (key: string) => ({
      ...priceBody(promo.applied),
      guest: {
        firstName: fields.firstName.trim(), lastName: fields.lastName.trim(), email: fields.email.trim(),
        phone: `${dial} ${fields.phone.trim()}`, country: fields.country,
      },
      locale, idempotencyKey: key, acceptTerms: true,
    });
    // Re-read at submit time: the key may have aged past the hold while the guest was typing.
    let body = bodyWith(currentKey());
    let r = await startBooking(body);
    // The key belongs to a booking that is no longer payable (confirmed, cancelled or expired):
    // start a new booking with a fresh key, once.
    for (let attempt = 0; retryWithFreshKey(r, attempt); attempt++) {
      clearKey(selection(), sessionStore());
      const fresh = currentKey();
      setIdempotencyKey(fresh);
      body = bodyWith(fresh);
      r = await startBooking(body);
    }
    if (r.ok) {
      rememberBooking(r.code, { email: body.guest.email, body });
      followChargeStart(r.start);
      return; // leave "submitting" on while the browser navigates
    }
    if (r.error === "PROMO_INVALID") {
      setPromo((p) => ({ ...p, applied: "", state: "invalid" }));
      void requote("");
    }
    if (r.error === "INVALID_INPUT" && r.detail?.includes("guest.")) {
      const fromApi = new Set<FieldName>();
      for (const path of r.detail.split(",")) {
        const f = path.replace(/^guest\./, "");
        if (f === "phone") fromApi.add("phone");
        else if (["firstName", "lastName", "email", "country"].includes(f)) fromApi.add(f as FieldName);
      }
      setInvalid(fromApi);
    }
    setStatus({
      kind: "error",
      message: r.status === 429 ? t("errorRate") : r.status === 409 ? t("errorGone") : r.error === "INVALID_INPUT" && r.detail?.includes("guest.") ? t("errorFields") : t("errorGeneric"),
    });
  }

  const err = (f: FieldName) => invalid.has(f);
  const describedBy = (f: FieldName, hint?: string) => [hint, err(f) ? `${f}-error` : ""].filter(Boolean).join(" ") || undefined;
  const fieldError = (f: FieldName) =>
    err(f) ? (
      <em id={`${f}-error`} className="field-error">
        {t("fieldError")}
      </em>
    ) : null;
  const req = <small className="req">{t("required")}</small>;
  const nights = quote.nights;
  const addonName = (id: string) => addons.find((a) => a.id === id)?.name ?? "";

  return (
    <form className="checkout" onSubmit={onSubmit} noValidate aria-describedby="checkout-status">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="checkout-main">
        {addons.length > 0 && (
          <fieldset className="checkout-section">
            <legend>{t("addonsTitle")}</legend>
            <ul className="addon-list">
              {addons.map((a) => (
                <li key={a.slug}>
                  <label className="addon">
                    <input type="checkbox" checked={!!selected[a.slug]} onChange={(e) => toggleAddon(a.slug, e.target.checked)} />
                    <span className="addon-name">{a.name}</span>
                    <span className="addon-price">
                      {formatPrice(a.price)} <small>{t(`unit_${a.unit}`)}</small>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}

        <fieldset className="checkout-section">
          <legend>{t("promoLabel")}</legend>
          {promo.state === "applied" ? (
            <p className="promo-applied" role="status">
              {t("promoApplied", { code: promo.applied })}{" "}
              <button type="button" className="link-button" onClick={removePromo}>
                {t("promoRemove")}
              </button>
            </p>
          ) : (
            <div className="promo-row">
              <label className="visually-hidden" htmlFor="promo">
                {t("promoLabel")}
              </label>
              <input
                id="promo"
                name="promo"
                autoComplete="off"
                autoCapitalize="characters"
                value={promo.input}
                maxLength={32}
                aria-invalid={promo.state === "invalid" || undefined}
                aria-describedby={promo.state === "invalid" ? "promo-error" : undefined}
                onChange={(e) => setPromo({ input: e.target.value, applied: "", state: "none" })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void applyPromo();
                  }
                }}
              />
              <button type="button" className="ghost-button" onClick={applyPromo} disabled={!promo.input.trim() || quoting}>
                {t("promoApply")}
              </button>
              {promo.state === "invalid" && (
                <em id="promo-error" className="field-error" role="alert">
                  {t("promoInvalid")}
                </em>
              )}
            </div>
          )}
        </fieldset>

        <fieldset className="checkout-section">
          <legend>{t("guestTitle")}</legend>
          <div className="guest-grid">
            <label className="form-field">
              <span>
                {t("lastName")}
                {req}
              </span>
              <input name="lastName" autoComplete="family-name" value={fields.lastName} onChange={set("lastName")} maxLength={100} required aria-invalid={err("lastName") || undefined} aria-describedby={describedBy("lastName")} />
              {fieldError("lastName")}
            </label>
            <label className="form-field">
              <span>
                {t("firstName")}
                {req}
              </span>
              <input name="firstName" autoComplete="given-name" value={fields.firstName} onChange={set("firstName")} maxLength={100} required aria-invalid={err("firstName") || undefined} aria-describedby={describedBy("firstName")} />
              {fieldError("firstName")}
            </label>
            <label className="form-field span-2">
              <span>
                {t("email")}
                {req}
              </span>
              <input name="email" type="email" autoComplete="email" inputMode="email" value={fields.email} onChange={set("email")} maxLength={254} required aria-invalid={err("email") || undefined} aria-describedby={describedBy("email", "email-hint")} />
              <small id="email-hint">{t("emailHint")}</small>
              {fieldError("email")}
            </label>
            <label className="form-field span-2">
              <span>
                {t("country")}
                {req}
              </span>
              <select name="country" autoComplete="country" value={fields.country} onChange={set("country")} required aria-invalid={err("country") || undefined} aria-describedby={describedBy("country")}>
                <option value="">{t("choose")}</option>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
              {fieldError("country")}
            </label>
            <div className="form-field span-2 phone-field" role="group" aria-labelledby="phone-label">
              <span id="phone-label">
                {t("phone")}
                {req}
              </span>
              <div className="phone-inputs">
                <input name="dial" aria-label={t("dialCode")} autoComplete="tel-country-code" inputMode="tel" value={fields.dial} onChange={set("dial")} maxLength={5} placeholder="+886" aria-invalid={err("dial") || undefined} list="dial-codes" />
                <datalist id="dial-codes">
                  {[...new Set(Object.values(DIAL_CODES))].map((d) => (
                    <option key={d} value={d} />
                  ))}
                </datalist>
                <input name="phone" type="tel" aria-label={t("phone")} autoComplete="tel-national" inputMode="tel" value={fields.phone} onChange={set("phone")} maxLength={30} required aria-invalid={err("phone") || undefined} aria-describedby={describedBy("phone")} />
              </div>
              {fieldError(err("dial") ? "dial" : "phone")}
            </div>
          </div>
        </fieldset>

        <section className="checkout-section policy" aria-labelledby="policy-title">
          <h2 id="policy-title">{t("policyTitle")}</h2>
          <p>{policyText}</p>
          <p className="muted">{t("policyNote")}</p>
        </section>

        <div className="checkout-section terms">
          <label className="terms-check">
            <input type="checkbox" name="terms" checked={terms} onChange={(e) => { setTerms(e.target.checked); setInvalid((s) => { const n = new Set(s); n.delete("terms"); return n; }); }} required aria-invalid={err("terms") || undefined} aria-describedby={err("terms") ? "terms-error" : undefined} />
            <span>
              {t.rich("terms", {
                terms: (c) => <Link href="/terms" target="_blank">{c}</Link>,
                privacy: (c) => <Link href="/privacy" target="_blank">{c}</Link>,
              })}
            </span>
          </label>
          {err("terms") && (
            <em id="terms-error" className="field-error">
              {t("termsRequired")}
            </em>
          )}
        </div>
      </div>

      <aside className="checkout-aside" aria-label={t("summaryTitle")}>
        <StayFolio
          checkIn={stay.checkIn}
          checkOut={stay.checkOut}
          nights={nights}
          adults={stay.adults}
          childCount={stay.children}
          rooms={stay.rooms}
          roomName={stay.roomName}
          planName={stay.planName}
        />
        <div className="price-lines" aria-live="polite" aria-busy={quoting}>
          <h2 className="visually-hidden">{t("summaryTitle")}</h2>
          <dl>
            <div>
              <dt>{t("roomsLine", { room: stay.roomName, rooms: stay.rooms, nights })}</dt>
              <dd>{formatPrice(quote.roomSubtotal)}</dd>
            </div>
            {quote.addonLines.map((l) => (
              <div key={l.addonId}>
                <dt>{addonName(l.addonId)}</dt>
                <dd>{formatPrice(l.amount)}</dd>
              </div>
            ))}
            {quote.discount > 0 && (
              <div className="discount">
                <dt>{t("discount", { code: quote.promoCode ?? "" })}</dt>
                <dd>−{formatPrice(quote.discount)}</dd>
              </div>
            )}
            <div className="grand">
              <dt>{t("total")}</dt>
              <dd>{formatPrice(quote.total)}</dd>
            </div>
            {quote.payLater > 0 && (
              <>
                <div>
                  <dt>{t("payNow")}</dt>
                  <dd>{formatPrice(quote.payNow)}</dd>
                </div>
                <div>
                  <dt>{t("payLater")}</dt>
                  <dd>{formatPrice(quote.payLater)}</dd>
                </div>
              </>
            )}
          </dl>
          {quoting && <p className="muted small">{t("updating")}</p>}
        </div>
        <button className="cta cta-block submit" type="submit" disabled={status.kind === "submitting" || !idempotencyKey}>
          {status.kind === "submitting" ? t("submitting") : `${t("submit")}  ${formatPrice(quote.payNow)}`}
        </button>
        <p id="checkout-status" className="checkout-status" role="status" aria-live="polite">
          {status.kind === "error" ? status.message : ""}
        </p>
        <p className="muted small">{t("holdNote")}</p>
        <p className="muted small">{t("payNote")}</p>
      </aside>
    </form>
  );
}
