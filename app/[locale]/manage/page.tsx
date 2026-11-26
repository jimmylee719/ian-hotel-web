import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { BookingDisabledNotice } from "@/components/booking/BookingDisabledNotice";
import { ManageLookup } from "@/components/booking/ManageLookup";
import { PageHead } from "@/components/site/PageHead";
import { TestNote } from "@/components/site/TestMode";
import type { Locale } from "@/lib/db/schema";
import { isTestSite } from "@/lib/runtime/env";
import { buildMetadata } from "@/lib/seo";
import { bookingEnabled, requestEnv } from "@/lib/runtime/request-env";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "manage" });
  return { ...buildMetadata({ locale, path: "/manage", title: t("title"), description: t("description") }), robots: { index: false } };
}

export default async function ManagePage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "manage" });
  if (!(await bookingEnabled())) {
    return (
      <main id="main" className="wrap book-page narrow">
        <PageHead title={t("title")} theme="paper" />
        <BookingDisabledNotice locale={locale} />
      </main>
    );
  }
  return (
    <main id="main" className="wrap book-page narrow">
      <PageHead title={t("title")} lead={t("intro")} theme="paper" />
      {isTestSite(await requestEnv()) && <TestNote locale={locale} />}
      <ManageLookup />
    </main>
  );
}
