"use client";

import { Fragment } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

/** "中文 / EN / 日本語 / 한국어" (short "中 / EN / 日 / 한" on phones); keeps the current page. */
export function LocaleSwitcher() {
  const t = useTranslations();
  const current = useLocale();
  const pathname = usePathname();

  return (
    <nav className="lang" aria-label={t("header.language")}>
      {routing.locales.map((locale, i) => (
        <Fragment key={locale}>
          {i > 0 && (
            <span className="sep" aria-hidden="true">
              /
            </span>
          )}
          <Link
            href={pathname}
            locale={locale}
            hrefLang={locale}
            lang={locale}
            aria-current={locale === current ? "true" : undefined}
          >
            <span className="long">{t(`localeNames.${locale}`)}</span>
            <span className="short" aria-hidden="true">
              {t(`localeShort.${locale}`)}
            </span>
          </Link>
        </Fragment>
      ))}
    </nav>
  );
}
