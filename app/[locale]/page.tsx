import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { BookingBar } from "@/components/layout/BookingBar";
import type { Locale } from "@/lib/db/schema";
import { mediaUrl } from "@/lib/media";
import { buildMetadata } from "@/lib/seo";

const HERO_IMAGE = "rooms/rooms_76.jpg"; // 景緻雙人套房, 1100 × 440 source

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return buildMetadata({ locale, path: "/", title: t("title"), description: t("description"), image: HERO_IMAGE });
}

export default async function Home({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "home" });
  const f = await getTranslations({ locale, namespace: "footer" });
  // The vertical tagline is Chinese on the zh-TW and en sites, native on ja and ko.
  const taglineLang = locale === "en" ? "zh-TW" : undefined;

  return (
    <main id="main" className="wrap">
      <section className="hero">
        <h1 className="tagline" lang={taglineLang}>
          <span>{t("taglineFirst")}</span>
          <span>{t("taglineSecond")}</span>
        </h1>
        <figure className="hero-photo">
          {/* eslint-disable-next-line @next/next/no-img-element -- served from R2 via /media; source is only 1100px wide */}
          <img className="photo-warm" src={mediaUrl(HERO_IMAGE, 1100)} alt={t("heroAlt")} width={1100} height={880} fetchPriority="high" />
          <figcaption>{t("heroCaption")}</figcaption>
        </figure>
        <div className="intro">
          <p className="en" lang="en">
            {t("taglineEn")}
          </p>
          <p>{t("intro")}</p>
          <address>
            {f("address")}
            <br />
            {t("nearMrt")}
          </address>
        </div>
      </section>
      <BookingBar />
    </main>
  );
}
