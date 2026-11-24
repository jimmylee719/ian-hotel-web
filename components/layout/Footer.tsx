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

const FOOTER_LINKS = [
  ["rooms", "/rooms"],
  ["facilities", "/facilities"],
  ["access", "/location"],
  ["attractions", "/attractions"],
  ["groups", "/groups"],
  ["reviews", "/reviews"],
  ["news", "/news"],
  ["faq", "/faq"],
] as const;

export async function Footer({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "footer" });
  const h = await getTranslations({ locale, namespace: "header" });
  const nav = await getTranslations({ locale, namespace: "nav" });

  return (
    <footer className="site-foot">
      <div className="foot-grid">
        <div>
          <h2>{h("brand")}</h2>
          <address>
            {t("address")}
            <small>{t("nearMrt")}</small>
          </address>
        </div>
        <div>
          <h2>{t("contact")}</h2>
          <ul>
            <li>
              {t("phone")} <a href={CONTACT.phoneHref}>{CONTACT.phone}</a>
            </li>
            <li>
              {t("email")} <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>
            </li>
            {SOCIAL.map((s) => (
              <li key={s.key}>
                <a href={s.href} target="_blank" rel="noopener noreferrer">
                  {t(s.key)}
                </a>
              </li>
            ))}
          </ul>
        </div>
        <nav aria-label={t("siteLinks")}>
          <ul>
            {FOOTER_LINKS.map(([k, href]) => (
              <li key={k}>
                <Link href={href}>{nav(k)}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="foot-legal">
        <span>
          © {new Date().getFullYear()} {t("copyright")}
        </span>
        <nav aria-label={t("legal")}>
          <Link href="/manage">{t("manageBooking")}</Link>
          <Link href="/privacy">{t("privacy")}</Link>
          <Link href="/terms">{t("terms")}</Link>
        </nav>
      </div>
    </footer>
  );
}
