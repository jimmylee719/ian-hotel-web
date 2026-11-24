"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { LocaleSwitcher } from "./LocaleSwitcher";

export const NAV_ITEMS = [
  { key: "rooms", href: "/rooms" },
  { key: "facilities", href: "/facilities" },
  { key: "access", href: "/location" },
  { key: "faq", href: "/faq" },
] as const;

export function Header() {
  const t = useTranslations("header");
  const nav = useTranslations("nav");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="site-head">
      <Link className="brand" href="/" aria-label={t("home")}>
        <b>{t("brand")}</b>
        <span lang="en">{t("brandEn")}</span>
      </Link>
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
      <div className="head-right">
        <LocaleSwitcher />
        <Link className="head-cta" href="/book">
          {t("bookNow")}
        </Link>
      </div>
    </header>
  );
}
