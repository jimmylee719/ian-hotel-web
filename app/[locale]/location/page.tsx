import { getTranslations } from "next-intl/server";
import { ContentPage, contentPageMetadata } from "@/components/site/ContentPage";
import type { Locale } from "@/lib/db/schema";
import { MAP_URL } from "@/lib/jsonld";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }> };

// The content page is stored as "access" (the old site's location.php).
export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  return contentPageMetadata(locale, "access", "/location", "locationDescription");
}

export default async function LocationPage({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "pages" });
  const f = await getTranslations({ locale, namespace: "footer" });
  const h = await getTranslations({ locale, namespace: "home" });
  const aside = (
    <div className="address-card">
      <h2>{t("addressTitle")}</h2>
      <address>
        {f("address")}
        <small>{f("nearMrt")}</small>
      </address>
      <a href={MAP_URL} target="_blank" rel="noopener noreferrer">
        {h("openMap")}
      </a>
    </div>
  );
  return <ContentPage locale={locale} slug="access" aside={aside} maxPhotos={3} />;
}
