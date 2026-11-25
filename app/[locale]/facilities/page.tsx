import { getTranslations } from "next-intl/server";
import { ContentPage, contentPageMetadata } from "@/components/site/ContentPage";
import { FACILITY_PHOTOS } from "@/lib/content/facility-photos";
import type { Locale } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  return contentPageMetadata(locale, "facilities", "/facilities", "facilitiesDescription");
}

export default async function FacilitiesPage({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "facilityPhoto" });
  const captions = Object.fromEntries(Object.entries(FACILITY_PHOTOS).map(([k, v]) => [k, t(v)]));
  return <ContentPage locale={locale} slug="facilities" captions={captions} maxPhotos={7} layout="chapters" />;
}
