import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Messages } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { loadRoom, loadRooms } from "@/components/site/data";
import { JsonLd } from "@/components/site/JsonLd";
import { PageHead } from "@/components/site/PageHead";
import { formatPrice } from "@/components/site/price";
import { RichText } from "@/components/site/RichText";
import { RoomCard } from "@/components/site/RoomCard";
import { RoomGallery } from "@/components/site/RoomGallery";
import { Band } from "@/components/site/sections/Band";
import { Chapter } from "@/components/site/sections/Chapter";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/lib/db/schema";
import { roomJsonLd } from "@/lib/jsonld";
import { buildMetadata } from "@/lib/seo";

type AmenityKey = keyof Messages["amenities"];

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const room = await loadRoom(slug, locale);
  if (!room) return {};
  return buildMetadata({ locale, path: `/rooms/${slug}`, title: room.name, description: room.summary.slice(0, 160), image: room.image ?? undefined });
}

export default async function RoomPage({ params }: Props) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const room = await loadRoom(slug, locale);
  if (!room) notFound();
  const [t, a, all] = await Promise.all([
    getTranslations({ locale, namespace: "rooms" }),
    getTranslations({ locale, namespace: "amenities" }),
    loadRooms(locale),
  ]);
  const others = all.filter((r) => r.slug !== slug).slice(0, 3);
  const bookHref = { pathname: "/book", query: { room: slug } };

  return (
    <main id="main" className="wrap room-page">
      <JsonLd data={roomJsonLd(room, locale)} />
      <PageHead title={room.name} sub={room.name !== room.nameEn ? room.nameEn : undefined}>
        <nav className="page-back" aria-label={t("allRooms")}>
          <Link href="/rooms">{t("allRooms")}</Link>
        </nav>
      </PageHead>

      <Band theme="paper">
        <Chapter num={1} title={t("aboutTitle")}>
          <RoomGallery images={room.images} roomName={room.name}>
            <div className="room-about">
              <RichText text={room.description} headingLevel={3} />
            </div>
          </RoomGallery>
        </Chapter>
        <Chapter num={2} title={t("amenitiesTitle")}>
          <div className="room-spec">
            <dl>
              <div>
                <dt>{t("guests")}</dt>
                <dd>{t("guestsValue", { count: room.maxOccupancy })}</dd>
              </div>
              {room.bedType && (
                <div>
                  <dt>{t("bed")}</dt>
                  <dd>{room.bedType}</dd>
                </div>
              )}
              {room.sizeSqm && (
                <div>
                  <dt>{t("size")}</dt>
                  <dd>{t("sizeValue", { sqm: room.sizeSqm })}</dd>
                </div>
              )}
            </dl>
            {room.amenities.length > 0 && (
              <ul className="room-amenities">
                {room.amenities.map((k) => (
                  // Amenity codes come from content data; a code with no label shows as itself.
                  <li key={k}>{a.has(k as AmenityKey) ? a(k as AmenityKey) : k}</li>
                ))}
              </ul>
            )}
          </div>
        </Chapter>
      </Band>

      <Band theme="ink" className="room-cta-band">
        <div className="room-cta">
          <div>
            {room.fromPrice !== null && (
              <p className="room-cta-price">
                <span className="room-cta-label">{t("fromPrice")}</span>
                <span className="price">
                  {formatPrice(room.fromPrice)} <small>{t("perNight")}</small>
                </span>
              </p>
            )}
            <p className="room-cta-note">{t("priceNote")}</p>
          </div>
          <Link className="cta" href={bookHref}>
            {t("checkPrices")}
          </Link>
        </div>
      </Band>

      {others.length > 0 && (
        <section className="section room-others" aria-labelledby="other-rooms">
          <div className="section-head">
            <h2 id="other-rooms">{t("otherRooms")}</h2>
            <Link href="/rooms">{t("allRooms")}</Link>
          </div>
          <div className="room-rows">
            {others.map((r, i) => (
              <RoomCard key={r.slug} room={r} locale={locale} flip={i % 2 === 1} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
