"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { headerTheme } from "@/lib/design/header-theme";
import { LocaleSwitcher } from "./LocaleSwitcher";

export const NAV_ITEMS = [
  { key: "rooms", href: "/rooms" },
  { key: "facilities", href: "/facilities" },
  { key: "access", href: "/location" },
  { key: "faq", href: "/faq" },
] as const;

/**
 * Full-bleed header band: ink on most pages, paper on the booking and manage flows (headerTheme).
 * Grid `1fr auto 1fr`: nav left, brand centred, languages + book-now right. At ≤900px the nav
 * collapses behind the menu button and opens as a full-width panel in the band's own colours.
 */
export function Header() {
  const t = useTranslations("header");
  const nav = useTranslations("nav");
  const pathname = usePathname();
  const theme = headerTheme(pathname);
  const [open, setOpen] = useState(false);

  return (
    <div className={`head-band band-${theme}`} data-theme={theme}>
      <div className="wrap">
        <header className="site-head">
          <button
            type="button"
            className="menu-toggle"
            aria-expanded={open}
            aria-controls="main-nav"
            onClick={() => setOpen((o) => !o)}
          >
            {t("menu")}
          </button>
          <nav id="main-nav" className="nav" aria-label={t("mainNav")} data-open={open}>
            <ul>
              {NAV_ITEMS.map((item) => (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    aria-current={pathname.startsWith(item.href) ? "page" : undefined}
                    onClick={() => setOpen(false)}
                  >
                    {nav(item.key)}
                  </Link>
                </li>
              ))}
              <li className="nav-book">
                <Link href="/book" onClick={() => setOpen(false)}>
                  {t("bookNow")}
                </Link>
              </li>
            </ul>
          </nav>
          <Link className="brand" href="/" aria-label={t("home")}>
            <b>{t("brand")}</b>
            <span lang="en">{t("brandEn")}</span>
          </Link>
          <div className="head-right">
            <LocaleSwitcher />
            <Link className="head-cta" href="/book">
              {t("bookNow")}
            </Link>
          </div>
        </header>
      </div>
    </div>
  );
}
