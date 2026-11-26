import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { Footer } from "@/components/layout/Footer";
import { CjkFonts } from "@/components/layout/CjkFonts";
import { Header } from "@/components/layout/Header";
import { BookingDock } from "@/components/site/BookingDock";
import { TestSiteBanner } from "@/components/site/TestMode";
import type { Locale } from "@/lib/db/schema";
import { isTestSite } from "@/lib/runtime/env";
import { isIndexable, NOINDEX, SITE_URL } from "@/lib/seo";
import { fontVariables } from "./fonts";
import { requestEnv } from "@/lib/runtime/request-env";

/**
 * Every page under [locale] renders at request time (no generateStaticParams, no prerender): the layout reads the
 * Worker's env (requestEnv) for the 測試用 banner and the noindex tag, and a build-time prerender would bake the build
 * machine's top-level wrangler vars (ENVIRONMENT "local", PAYMENT_MODE "mock") into production HTML.
 * tests/ops/request-time-rendering.test.ts and scripts/check-prerender.ts keep it so.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: t("title"), template: `%s｜${t("siteName")}` },
    description: t("description"),
    // Only production may be indexed; the preview, staging and local copies are noindex, nofollow (lib/seo.ts).
    ...(isIndexable(await requestEnv()) ? {} : { robots: NOINDEX }),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{ children: React.ReactNode; params: Promise<{ locale: string }> }>) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "header" });
  const testSite = isTestSite(await requestEnv());

  return (
    <html lang={locale} className={fontVariables}>
      <body>
        <CjkFonts locale={locale} />
        <NextIntlClientProvider>
          <a className="skip-link" href="#main">
            {t("skipToContent")}
          </a>
          {testSite && <TestSiteBanner locale={locale as Locale} />}
          <Header />
          {children}
          <BookingDock />
          <div className="foot-band band-ink">
            <div className="wrap">
              <Footer locale={locale} />
            </div>
          </div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
