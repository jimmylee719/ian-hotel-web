import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { BookingBar } from "@/components/layout/BookingBar";
import { INLINE_BOOKING_ID } from "@/components/site/BookingDock";
import { loadProperty, loadRooms } from "@/components/site/data";
import { JsonLd } from "@/components/site/JsonLd";
import { ArchPhoto } from "@/components/site/sections/ArchPhoto";
import { Band } from "@/components/site/sections/Band";
import { Chapter } from "@/components/site/sections/Chapter";
import { PhotoGrid3 } from "@/components/site/sections/PhotoGrid3";
import { PhotoSplit } from "@/components/site/sections/PhotoSplit";
import { RatingsStrip } from "@/components/site/sections/RatingsStrip";
import { Reveal } from "@/components/site/sections/Reveal";
import { Link } from "@/i18n/navigation";
import { FACILITY_PHOTOS } from "@/lib/content/facility-photos";
import { FEATURED_ROOMS, HOME_PHOTOS } from "@/lib/content/home-photos";
import { HOME_AWARDS } from "@/lib/content/reviews";
import type { Locale } from "@/lib/db/schema";
import { hotelJsonLd, MAP_URL } from "@/lib/jsonld";
import { buildMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

const SHARE_IMAGE = "rooms/rooms_76.jpg"; // 景緻雙人套房, 1100 × 440 source

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return buildMetadata({ locale, path: "/", title: t("title"), description: t("description"), image: SHARE_IMAGE });
}

/** The chapter's English label, unless it would only repeat the (English) title. */
function enLabel(title: string, en: string): string | undefined {
  return title.toLowerCase() === en.toLowerCase() ? undefined : en;
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
  // Featured rooms with a cover photo, in FEATURED_ROOMS order (the first one is the grid's wide lead).
  const featured = FEATURED_ROOMS.flatMap((slug) => {
    const room = rooms.find((r) => r.slug === slug);
    return room?.image ? [{ ...room, image: room.image }] : [];
  });
  const [lead, ...items] = featured;
  // The vertical tagline is Chinese on the zh-TW and en sites, native on ja and ko.
  const taglineLang = locale === "en" ? "zh-TW" : undefined;
  // storyLead + storyBody1 read as one statement; spaced scripts need a space between the sentences.
  const statement = [t("storyLead"), t("storyBody1")].join(locale === "en" || locale === "ko" ? " " : "");
  const photoAlt = (key: string) => fp(FACILITY_PHOTOS[key]);
  const ratings = HOME_AWARDS.flatMap((a) => (a.score !== null && a.scale !== null ? [{ platform: a.platform, score: String(a.score), scale: String(a.scale) }] : []));

  return (
    <main id="main" className="wrap home">
      {property && <JsonLd data={hotelJsonLd(property, locale)} />}

      <Band theme="ink" className="home-hero-band">
        <section className="home-hero">
          <h1 className="tagline" lang={taglineLang}>
            <span>{t("taglineFirst")}</span>
            <span>{t("taglineSecond")}</span>
          </h1>
          <ArchPhoto src={HOME_PHOTOS.arch} alt={t("storyPhotoAlt")} priority />
          <div className="home-hero-copy">
            <p className="home-hero-en" lang="en">
              {t("taglineEn")}
            </p>
            <p>{t("intro")}</p>
          </div>
        </section>
      </Band>

      <Band theme="paper" className="home-booking-band">
        <div id={INLINE_BOOKING_ID} className="home-booking">
          <BookingBar />
        </div>
      </Band>

      <Band theme="paper">
        <section className="home-statement" aria-labelledby="story-title">
          <h2 id="story-title" className="chapter-title">
            {t("storyTitle")}
          </h2>
          <p className="home-statement-text">{statement}</p>
        </section>
      </Band>

      <Band theme="paper">
        <Chapter num={1} title={t("roomsTitle")} en={enLabel(t("roomsTitle"), t("chapterRoomsEn"))}>
          {lead && (
            <Reveal>
              <PhotoGrid3
                lead={{ src: lead.image, alt: lead.name }}
                items={items.map((room) => ({ src: room.image, alt: "", caption: room.name, captionEn: room.name !== room.nameEn ? room.nameEn : undefined }))}
              >
                <Link className="text-link" href="/rooms">
                  {t("allRooms", { count: rooms.length })}
                </Link>
              </PhotoGrid3>
            </Reveal>
          )}
        </Chapter>
      </Band>

      <Band theme="ink">
        <Chapter num={2} title={t("facilitiesTitle")} en={enLabel(t("facilitiesTitle"), t("chapterSpacesEn"))}>
          <Reveal>
            <PhotoSplit
              large={{ src: HOME_PHOTOS.spacesLarge, alt: photoAlt(HOME_PHOTOS.spacesLarge) }}
              small={{ src: HOME_PHOTOS.spacesSmall, alt: photoAlt(HOME_PHOTOS.spacesSmall) }}
            >
              <p className="chapter-body-text">{t("facilitiesBody")}</p>
              <Link className="text-link" href="/facilities">
                {t("facilitiesMore")}
              </Link>
            </PhotoSplit>
          </Reveal>
        </Chapter>
      </Band>

      <Band theme="paper">
        <Chapter num={3} title={t("locationTitle")} en={enLabel(t("locationTitle"), t("chapterAccessEn"))}>
          <Reveal>
            <PhotoSplit large={{ src: HOME_PHOTOS.access, alt: photoAlt(HOME_PHOTOS.access) }}>
              <address className="home-address">
                {f("address")}
                <br />
                {t("nearMrt")}
              </address>
              <p className="chapter-body-text">{t("locationBody")}</p>
              <p className="link-row">
                <Link className="text-link" href="/location">
                  {t("directions")}
                </Link>
                <a className="text-link" href={MAP_URL} target="_blank" rel="noopener noreferrer">
                  {t("openMap")}
                </a>
              </p>
            </PhotoSplit>
          </Reveal>
        </Chapter>
      </Band>

      <Band theme="ink" className="home-ratings-band">
        <section aria-labelledby="reviews-title">
          <h2 id="reviews-title" className="visually-hidden">
            {t("reviewsTitle")}
          </h2>
          <RatingsStrip awards={ratings} />
          <p className="home-ratings-more">
            <Link className="text-link" href="/reviews">
              {t("reviewsMore")}
            </Link>
          </p>
        </section>
      </Band>
    </main>
  );
}
