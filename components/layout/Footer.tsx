import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/lib/db/schema";

export const CONTACT = {
  phone: "+886 2 2769 0200",
  phoneHref: "tel:+886227690200",
  email: "info@nkhostel.com",
};

export const SOCIAL = [
  { key: "facebook", href: "https://www.facebook.com/Nkmansion" },
  { key: "instagram", href: "https://www.instagram.com/nkhostel/" },
  { key: "line", href: "https://line.me/R/ti/p/3_Pw43MsVn" },
] as const;

/** Footer links, split into the main column and the secondary column (spec §5.2 "Ink footer"). */
const FOOTER_MAIN_LINKS = [
  ["rooms", "/rooms"],
  ["facilities", "/facilities"],
  ["access", "/location"],
  ["attractions", "/attractions"],
  ["faq", "/faq"],
] as const;

const FOOTER_MORE_LINKS = [
  ["reviews", "/reviews"],
  ["news", "/news"],
  ["groups", "/groups"],
] as const;

/** Rendered inside the ink footer band (app/[locale]/layout.tsx): brand + contact, main links, secondary links. */
export async function Footer({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "footer" });
  const h = await getTranslations({ locale, namespace: "header" });
  const nav = await getTranslations({ locale, namespace: "nav" });

  return (
    <footer className="site-foot">
      <div className="foot-grid">
        <div className="foot-brand">
          <h2>
            {h("brand")}
            <span lang="en">{h("brandEn")}</span>
          </h2>
          <address>
            {t("address")}
            <small>{t("nearMrt")}</small>
          </address>
          <ul className="foot-contact">
            <li>
              {t("phone")} <a href={CONTACT.phoneHref}>{CONTACT.phone}</a>
            </li>
            <li>
              {t("email")} <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>
            </li>
            <li className="foot-social">
              {SOCIAL.map((s) => (
                <a key={s.key} href={s.href} target="_blank" rel="noopener noreferrer">
                  {t(s.key)}
                </a>
              ))}
            </li>
          </ul>
        </div>
        <nav className="foot-links" aria-label={t("siteLinks")}>
          <ul>
            {FOOTER_MAIN_LINKS.map(([k, href]) => (
              <li key={k}>
                <Link href={href}>{nav(k)}</Link>
              </li>
            ))}
          </ul>
          <ul>
            {FOOTER_MORE_LINKS.map(([k, href]) => (
              <li key={k}>
                <Link href={href}>{nav(k)}</Link>
              </li>
            ))}
            <li>
              <Link href="/manage">{t("manageBooking")}</Link>
            </li>
            <li>
              <Link href="/privacy">{t("privacy")}</Link>
            </li>
            <li>
              <Link href="/terms">{t("terms")}</Link>
            </li>
          </ul>
        </nav>
      </div>
      <p className="foot-legal">
        © {new Date().getFullYear()} {t("copyright")}
      </p>
    </footer>
  );
}
