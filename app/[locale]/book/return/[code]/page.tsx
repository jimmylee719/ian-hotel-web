import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ReturnStatus } from "@/components/booking/ReturnStatus";
import { PageHead } from "@/components/site/PageHead";
import { TestNote } from "@/components/site/TestMode";
import type { Locale } from "@/lib/db/schema";
import { appEnv, isTestSite } from "@/lib/runtime/env";

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
  const env = await appEnv();
  const noEmail = isTestSite(env) && !env.RESEND_API_KEY;
  const tt = await getTranslations({ locale, namespace: "testMode" });
  return (
    <main id="main" className="wrap book-page">
      <PageHead title={t("title")} theme="paper" />
      {/* Without a Resend key nothing is sent (lib/runtime/deps.ts emailSender only logs it). */}
      {isTestSite(env) && <TestNote locale={locale} noEmail={noEmail} />}
      <ReturnStatus code={decodeURIComponent(code).toUpperCase()} confirmedNoEmail={noEmail ? tt("confirmedNoEmail") : undefined} />
    </main>
  );
}
