import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CONTACT } from "@/components/layout/Footer";
import { loadFaqs } from "@/components/site/data";
import { JsonLd } from "@/components/site/JsonLd";
import { PageHead } from "@/components/site/PageHead";
import { RichText } from "@/components/site/RichText";
import type { Locale } from "@/lib/db/schema";
import { faqJsonLd } from "@/lib/jsonld";
import { buildMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "faq" });
  return buildMetadata({ locale, path: "/faq", title: t("title"), description: t("description") });
}

export default async function FaqPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, faqs] = await Promise.all([getTranslations({ locale, namespace: "faq" }), loadFaqs(locale)]);

  return (
    <main id="main" className="wrap">
      <JsonLd data={faqJsonLd(faqs)} />
      <PageHead title={t("title")} lead={t("intro")} />
      <div className="faq-list">
        {faqs.map((f) => (
          <details key={f.slug} id={f.slug}>
            <summary>
              <h2>{f.question}</h2>
            </summary>
            <RichText text={f.answer} headingLevel={3} />
          </details>
        ))}
      </div>
      <p className="faq-contact">
        {t("stillQuestions")} <a href={CONTACT.phoneHref}>{CONTACT.phone}</a>
        {" · "}
        <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>
      </p>
    </main>
  );
}
