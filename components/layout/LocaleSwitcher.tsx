"use client";

import { Fragment } from "react";
import { useLocale, useTranslations, type Locale } from "next-intl";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

/**
 * "中文 / EN / 日本語 / 한국어" (short "中 / EN / 日 / 한" on phones); keeps the current page and its
 * query string (a /book search or details selection survives the switch). The query is read on click,
 * not with useSearchParams, so statically rendered pages need no Suspense boundary.
 */
export function LocaleSwitcher() {
  const t = useTranslations();
  const current = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  const keepQuery = (locale: Locale) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    const search = window.location.search;
    if (!search || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    router.push(`${pathname}${search}`, { locale });
  };

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
            aria-label={t(`localeNames.${locale}`)}
            onClick={keepQuery(locale)}
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
