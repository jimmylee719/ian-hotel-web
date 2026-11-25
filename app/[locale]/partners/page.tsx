import { getTranslations } from "next-intl/server";
import { CONTACT } from "@/components/layout/Footer";
import { ContentPage, contentPageMetadata } from "@/components/site/ContentPage";
import type { Locale } from "@/lib/db/schema";
import { mailtoWithSubject } from "@/lib/mailto";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  return contentPageMetadata(locale, "partners", "/partners", "partnersDescription");
}

export default async function PartnersPage({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "pages" });
  // The property's existing address with a localized subject line: a plain mailto, never a form.
  const contact = (
    <p className="partners-contact">
      <a className="text-link" href={mailtoWithSubject(CONTACT.email, t("partnersMailSubject"))}>
        {t("partnersMailLink")}
      </a>
      <span className="partners-contact-address">{CONTACT.email}</span>
    </p>
  );
  return <ContentPage locale={locale} slug="partners" layout="chapters" lastChapterExtra={contact} />;
}
