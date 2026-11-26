import { ContentPage, contentPageMetadata } from "@/components/site/ContentPage";
import type { Locale } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  return contentPageMetadata(locale, "company", "/company", "companyDescription");
}

export default async function CompanyPage({ params }: Props) {
  const { locale } = await params;
  return <ContentPage locale={locale} slug="company" />;
}
