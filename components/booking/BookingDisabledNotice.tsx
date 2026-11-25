import { getTranslations } from "next-intl/server";
import { CONTACT } from "@/components/layout/Footer";
import type { Locale } from "@/lib/db/schema";

/** Shown in place of the booking flow while payments are not configured (PAYMENT_MODE unset). */
export async function BookingDisabledNotice({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "book" });
  return (
    <div className="book-message book-disabled" role="status">
      <h2>{t("disabledTitle")}</h2>
      <p>{t("disabledBody")}</p>
      <p>
        {t("disabledPhone")}: <a href={CONTACT.phoneHref}>{CONTACT.phone}</a>
        <br />
        {t("disabledEmail")}: <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>
      </p>
    </div>
  );
}
