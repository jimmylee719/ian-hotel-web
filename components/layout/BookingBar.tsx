"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { addDaysIso, bookingSearchPath, defaultStay, nightsBetween, type BookingSearch } from "@/lib/booking-search";

const LIMITS = { adults: [1, 12], children: [0, 6], rooms: [1, 6] } as const;
type Counter = keyof typeof LIMITS;

/** Date range, adults, children and rooms; submits to /{locale}/book?checkIn=&checkOut=&adults=&children=&rooms= */
export function BookingBar({ initial }: { initial?: Partial<BookingSearch> }) {
  const t = useTranslations("booking");
  const locale = useLocale();
  const router = useRouter();
  const panelId = useId();
  const guestsRef = useRef<HTMLDivElement>(null);

  const [search, setSearch] = useState<BookingSearch>({ checkIn: "", checkOut: "", adults: 2, children: 0, rooms: 1, ...initial });
  const [panelOpen, setPanelOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default dates depend on "today", so set them on the client to avoid a hydration mismatch.
  useEffect(() => {
    setSearch((s) => (s.checkIn ? s : { ...s, ...defaultStay(new Date()) }));
  }, []);

  useEffect(() => {
    if (!panelOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !guestsRef.current?.contains(e.target as Node)) setPanelOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [panelOpen]);

  const fmtDay = (iso: string) =>
    iso ? new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`)) : t("selectDate");
  const fmtWeekday = (iso: string) =>
    iso ? new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`)) : "";
  const nights = nightsBetween(search.checkIn, search.checkOut);

  const setCount = (key: Counter, delta: number) =>
    setSearch((s) => ({ ...s, [key]: Math.min(LIMITS[key][1], Math.max(LIMITS[key][0], s[key] + delta)) }));

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!search.checkIn || !search.checkOut || nights < 1) {
      setError(t("checkOutAfterCheckIn"));
      return;
    }
    setError(null);
    router.push(bookingSearchPath(search));
  }

  return (
    <form className="booking" aria-label={t("title")} onSubmit={onSubmit} noValidate>
      <label className="field field-in">
        <small>{t("checkIn")}</small>
        <strong aria-hidden="true">
          {fmtDay(search.checkIn)}
          {search.checkIn && <em>{fmtWeekday(search.checkIn)}</em>}
        </strong>
        <input
          type="date"
          aria-label={t("checkIn")}
          value={search.checkIn}
          onChange={(e) => {
            const checkIn = e.target.value;
            setSearch((s) => ({ ...s, checkIn, checkOut: !checkIn || s.checkOut > checkIn ? s.checkOut : addDaysIso(checkIn, 1) }));
          }}
        />
      </label>
      <label className="field field-out">
        <small>{t("checkOut")}</small>
        <strong aria-hidden="true">
          {fmtDay(search.checkOut)}
          {nights > 0 && <em>{t("nights", { count: nights })}</em>}
        </strong>
        <input
          type="date"
          aria-label={t("checkOut")}
          value={search.checkOut}
          min={search.checkIn || undefined}
          onChange={(e) => setSearch((s) => ({ ...s, checkOut: e.target.value }))}
        />
      </label>
      <div ref={guestsRef} style={{ display: "contents" }}>
        <button
          type="button"
          className="field field-guests"
          aria-expanded={panelOpen}
          aria-controls={panelId}
          onClick={() => setPanelOpen((o) => !o)}
        >
          <small>{t("guests")}</small>
          <strong>{t("guestSummary", { adults: search.adults, children: search.children, rooms: search.rooms })}</strong>
        </button>
        {panelOpen && (
          <div id={panelId} className="guests-panel" role="group" aria-label={t("guests")}>
            {(Object.keys(LIMITS) as Counter[]).map((key) => (
              <div className="stepper" key={key}>
                <span id={`${panelId}-${key}`}>{t(key)}</span>
                <span className="controls">
                  <button
                    type="button"
                    aria-label={t("decrease", { label: t(key) })}
                    disabled={search[key] <= LIMITS[key][0]}
                    onClick={() => setCount(key, -1)}
                  >
                    −
                  </button>
                  <output aria-labelledby={`${panelId}-${key}`} aria-live="polite">
                    {search[key]}
                  </output>
                  <button
                    type="button"
                    aria-label={t("increase", { label: t(key) })}
                    disabled={search[key] >= LIMITS[key][1]}
                    onClick={() => setCount(key, 1)}
                  >
                    +
                  </button>
                </span>
              </div>
            ))}
            <button type="button" className="done" onClick={() => setPanelOpen(false)}>
              {t("done")}
            </button>
          </div>
        )}
      </div>
      <button className="cta" type="submit">
        {t("search")}
      </button>
      {error && (
        <p className="booking-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
