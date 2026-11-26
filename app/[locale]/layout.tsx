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
import { appEnv, isTestSite } from "@/lib/runtime/env";
import { isIndexable, NOINDEX, SITE_URL } from "@/lib/seo";
import { fontVariables } from "./fonts";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: t("title"), template: `%s｜${t("siteName")}` },
    description: t("description"),
    // Only production may be indexed; the preview, staging and local copies are noindex, nofollow (lib/seo.ts).
    ...(isIndexable(await appEnv()) ? {} : { robots: NOINDEX }),
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
  const testSite = isTestSite(await appEnv());

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
