import { getTranslations } from "next-intl/server";
import { ContentPage, contentPageMetadata } from "@/components/site/ContentPage";
import { FACILITY_PHOTOS } from "@/lib/content/facility-photos";
import { floorOf } from "@/lib/content/sections";
import type { Locale } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  return contentPageMetadata(locale, "facilities", "/facilities", "facilitiesDescription");
}

export default async function FacilitiesPage({ params }: Props) {
  const { locale } = await params;
  const [t, en] = await Promise.all([getTranslations({ locale, namespace: "facilityPhoto" }), getTranslations({ locale: "en", namespace: "facilityPhoto" })]);
  const captions = Object.fromEntries(Object.entries(FACILITY_PHOTOS).map(([k, v]) => [k, t(v)]));
  // Each photo's floor, read from its English caption ("… on 5F"), so every floor chapter shows its own photos.
  const photoFloors = Object.fromEntries(Object.entries(FACILITY_PHOTOS).map(([k, v]) => [k, floorOf(en(v))]));
  return <ContentPage locale={locale} slug="facilities" captions={captions} maxPhotos={7} layout="chapters" photoFloors={photoFloors} />;
}
