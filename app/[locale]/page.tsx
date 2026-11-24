import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { BookingBar } from "@/components/layout/BookingBar";
import { INLINE_BOOKING_ID } from "@/components/site/BookingDock";
import { loadProperty, loadRooms } from "@/components/site/data";
import { JsonLd } from "@/components/site/JsonLd";
import { Photo } from "@/components/site/Photo";
import { RoomCard } from "@/components/site/RoomCard";
import { Link } from "@/i18n/navigation";
import { FACILITY_PHOTOS } from "@/lib/content/facility-photos";
import { HOME_AWARDS } from "@/lib/content/reviews";
import type { Locale } from "@/lib/db/schema";
import { hotelJsonLd, MAP_URL } from "@/lib/jsonld";
import { mediaSrcSet, mediaUrl } from "@/lib/media";
import { buildMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

const HERO_IMAGE = "rooms/rooms_76.jpg"; // 景緻雙人套房, 1100 × 440 source
const FEATURED_ROOMS = ["deluxe-room", "classic-room", "mixed-cube"];
const HOME_FACILITY_PHOTOS = ["amenities/amenities_109.jpg", "amenities/amenities_33.jpg", "amenities/amenities_36.jpg"];
const STORY_PHOTO = "amenities/amenities_32.jpg";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return buildMetadata({ locale, path: "/", title: t("title"), description: t("description"), image: HERO_IMAGE });
}

export default async function Home({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, f, fp, property, rooms] = await Promise.all([
    getTranslations({ locale, namespace: "home" }),
    getTranslations({ locale, namespace: "footer" }),
    getTranslations({ locale, namespace: "facilityPhoto" }),
    loadProperty(),
    loadRooms(locale),
  ]);
  const featured = FEATURED_ROOMS.map((s) => rooms.find((room) => room.slug === s)).filter((room) => room !== undefined);
  // The vertical tagline is Chinese on the zh-TW and en sites, native on ja and ko.
  const taglineLang = locale === "en" ? "zh-TW" : undefined;

  return (
    <main id="main" className="wrap">
      {property && <JsonLd data={hotelJsonLd(property, locale)} />}
      <section className="hero">
        <h1 className="tagline" lang={taglineLang}>
          <span>{t("taglineFirst")}</span>
          <span>{t("taglineSecond")}</span>
        </h1>
        <figure className="hero-photo">
          {/* eslint-disable-next-line @next/next/no-img-element -- served from R2 via /media; source is only 1100px wide */}
          <img className="photo-warm" src={mediaUrl(HERO_IMAGE, 1100)}
            srcSet={mediaSrcSet(HERO_IMAGE, 1100)}
            sizes="(max-width: 700px) calc(100vw - 120px), (max-width: 1100px) calc(100vw - 238px), 640px"
            alt={t("heroAlt")} width={1100} height={880} fetchPriority="high" />
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
      <div id={INLINE_BOOKING_ID}>
        <BookingBar />
      </div>

      <section className="section story" aria-labelledby="story-title">
        <div className="story-text">
          <h2 id="story-title">{t("storyTitle")}</h2>
          <p className="story-lead">{t("storyLead")}</p>
          <p>{t("storyBody1")}</p>
          <p>{t("storyBody2")}</p>
          <p>{t("storyBody3")}</p>
        </div>
        <Photo src={STORY_PHOTO} alt={t("storyPhotoAlt")} width={960} height={720} />
      </section>

      <section className="section" aria-labelledby="rooms-title">
        <div className="section-head">
          <h2 id="rooms-title">{t("roomsTitle")}</h2>
          <Link href="/rooms">{t("allRooms", { count: rooms.length })}</Link>
        </div>
        <div className="room-grid">
          {featured.map((room) => (
            <RoomCard key={room.slug} room={room} locale={locale} />
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="facilities-title">
        <div className="section-head">
          <h2 id="facilities-title">{t("facilitiesTitle")}</h2>
          <Link href="/facilities">{t("facilitiesMore")}</Link>
        </div>
        <p className="section-lead">{t("facilitiesBody")}</p>
        <div className="photo-row">
          {HOME_FACILITY_PHOTOS.map((key) => (
            <figure key={key}>
              <Photo src={key} alt="" width={800} height={600} />
              <figcaption>{fp(FACILITY_PHOTOS[key])}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <div className="section home-split">
        <section aria-labelledby="reviews-title">
          <div className="section-head">
            <h2 id="reviews-title">{t("reviewsTitle")}</h2>
          </div>
          <p className="section-lead">{t("reviewsBody")}</p>
          <dl className="score-list">
            {HOME_AWARDS.map((a) => (
              <div key={a.platform}>
                <dt lang="en">{a.platform}</dt>
                <dd>
                  <strong>{a.score}</strong> <small>/ {a.scale}</small>
                </dd>
              </div>
            ))}
          </dl>
          <p>
            <Link className="text-link" href="/reviews">
              {t("reviewsMore")}
            </Link>
          </p>
        </section>
        <section aria-labelledby="location-title">
          <div className="section-head">
            <h2 id="location-title">{t("locationTitle")}</h2>
          </div>
          <p className="section-lead">{t("locationBody")}</p>
          <address className="home-address">{f("address")}</address>
          <p className="link-row">
            <Link className="text-link" href="/location">
              {t("directions")}
            </Link>
            <a className="text-link" href={MAP_URL} target="_blank" rel="noopener noreferrer">
              {t("openMap")}
            </a>
          </p>
        </section>
      </div>
    </main>
  );
}
