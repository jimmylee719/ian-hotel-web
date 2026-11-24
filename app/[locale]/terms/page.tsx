import { ContentPage, contentPageMetadata } from "@/components/site/ContentPage";
import type { Locale } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }> };

// The content page is stored as "booking-terms" (see lib/content/old-site.ts PAGE_SOURCES).
export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  return contentPageMetadata(locale, "booking-terms", "/terms", "termsDescription");
}

export default async function TermsPage({ params }: Props) {
  const { locale } = await params;
  return <ContentPage locale={locale} slug="booking-terms" plain />;
}
