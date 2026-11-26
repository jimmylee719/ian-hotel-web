import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ManageBooking } from "@/components/booking/ManageBooking";
import { CONTACT } from "@/components/layout/Footer";
import { loadProperty } from "@/components/site/data";
import { PageHead } from "@/components/site/PageHead";
import { TestNote } from "@/components/site/TestMode";
import type { Locale } from "@/lib/db/schema";
import { isTestSite } from "@/lib/runtime/env";
import { requestEnv } from "@/lib/runtime/request-env";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale; code: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "manage" });
  return { title: t("title"), robots: { index: false } };
}

export default async function ManageCodePage({ params }: Props) {
  const { locale, code } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "manage" });
  const property = await loadProperty();
  return (
    <main id="main" className="wrap book-page">
      <PageHead title={t("title")} theme="paper" />
      {isTestSite(await requestEnv()) && <TestNote locale={locale} />}
      <ManageBooking
        code={decodeURIComponent(code).toUpperCase()}
        hotelPhone={property?.phone ?? CONTACT.phone}
        hotelEmail={property?.email ?? CONTACT.email}
      />
    </main>
  );
}
