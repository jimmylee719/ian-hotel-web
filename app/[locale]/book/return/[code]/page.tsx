import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ReturnStatus } from "@/components/booking/ReturnStatus";
import { PageHead } from "@/components/site/PageHead";
import type { Locale } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale; code: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "bookingStatus" });
  return { title: t("title"), robots: { index: false } };
}

export default async function ReturnPage({ params }: Props) {
  const { locale, code } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "bookingStatus" });
  return (
    <main id="main" className="wrap book-page">
      <PageHead title={t("title")} />
      <ReturnStatus code={decodeURIComponent(code).toUpperCase()} />
    </main>
  );
}
