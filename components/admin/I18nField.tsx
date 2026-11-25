"use client";

import { useId, useState, type KeyboardEvent } from "react";
import type { I18n, Locale } from "@/lib/db/schema";

/** The four site languages, in tab order (lib/db/schema LOCALES; repeated so the client bundle skips drizzle). */
export const I18N_LOCALES: readonly Locale[] = ["zh-TW", "en", "ja", "ko"];
const LABELS: Record<Locale, string> = { "zh-TW": "中文", en: "English", ja: "日本語", ko: "한국어" };

/** Every language filled in (not blank): the only state the server accepts. */
export const i18nComplete = (v: I18n): boolean => I18N_LOCALES.every((l) => !!v[l]?.trim());

/**
 * One text field in four languages, one tab per language. A tab whose text is blank shows a red dot,
 * and the form it sits in should not save until `i18nComplete` holds.
 */
export function I18nField({
  label, value, onChange, multiline = false, rows = 6,
}: { label: string; value: I18n; onChange: (v: I18n) => void; multiline?: boolean; rows?: number }) {
  const base = useId();
  const [active, setActive] = useState<Locale>("zh-TW");
  const missing = I18N_LOCALES.filter((l) => !value[l]?.trim());

  function onKey(e: KeyboardEvent, i: number) {
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const l = I18N_LOCALES[(next + I18N_LOCALES.length) % I18N_LOCALES.length];
    setActive(l);
    document.getElementById(`${base}-tab-${l}`)?.focus();
  }

  return (
    <fieldset className="adm-i18n">
      <legend>
        {label}
        {missing.length ? <span className="adm-i18n-missing">（未填：{missing.map((l) => LABELS[l]).join("、")}）</span> : null}
      </legend>
      <div role="tablist" aria-label={`${label}的語言`} className="adm-i18n-tabs">
        {I18N_LOCALES.map((l, i) => (
          <button key={l} type="button" role="tab" id={`${base}-tab-${l}`} aria-selected={active === l} aria-controls={`${base}-panel`}
            tabIndex={active === l ? 0 : -1} onClick={() => setActive(l)} onKeyDown={(e) => onKey(e, i)}>
            {LABELS[l]}
            {!value[l]?.trim() ? <span className="adm-i18n-dot" aria-label="未填" /> : null}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${active}`}>
        {multiline ? (
          <textarea id={`${base}-${active}`} lang={active} rows={rows} value={value[active] ?? ""} aria-label={`${label}（${LABELS[active]}）`}
            aria-invalid={!value[active]?.trim()} onChange={(e) => onChange({ ...value, [active]: e.target.value })} />
        ) : (
          <input id={`${base}-${active}`} lang={active} value={value[active] ?? ""} aria-label={`${label}（${LABELS[active]}）`}
            aria-invalid={!value[active]?.trim()} onChange={(e) => onChange({ ...value, [active]: e.target.value })} />
        )}
      </div>
    </fieldset>
  );
}
