import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { loadRoom, loadRooms } from "@/components/site/data";
import { JsonLd } from "@/components/site/JsonLd";
import { formatPrice } from "@/components/site/price";
import { RichText } from "@/components/site/RichText";
import { RoomCard } from "@/components/site/RoomCard";
import { RoomGallery } from "@/components/site/RoomGallery";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/lib/db/schema";
import { roomJsonLd } from "@/lib/jsonld";
import { buildMetadata } from "@/lib/seo";

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
      <nav className="crumbs" aria-label={t("allRooms")}>
        <Link href="/rooms">{t("allRooms")}</Link>
      </nav>
      <header className="page-head room-head">
        <h1>{room.name}</h1>
        {room.name !== room.nameEn && (
          <p className="page-sub" lang="en">
            {room.nameEn}
          </p>
        )}
      </header>

      <RoomGallery images={room.images} roomName={room.name} />

      <div className="room-body">
        <section aria-labelledby="about-room">
          <h2 id="about-room">{t("aboutTitle")}</h2>
          <RichText text={room.description} headingLevel={3} />
        </section>

        <aside className="room-spec" aria-label={room.name}>
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
            {room.fromPrice !== null && (
              <div>
                <dt>{t("fromPrice")}</dt>
                <dd className="price">
                  {formatPrice(room.fromPrice)} <small>{t("perNight")}</small>
                </dd>
              </div>
            )}
          </dl>
          <Link className="cta cta-block" href={bookHref}>
            {t("checkPrices")}
          </Link>
          <p className="spec-note">{t("priceNote")}</p>
        </aside>
      </div>

      {room.amenities.length > 0 && (
        <section className="amenities" aria-labelledby="amenities-title">
          <h2 id="amenities-title">{t("amenitiesTitle")}</h2>
          <ul>
            {room.amenities.map((k) => (
              <li key={k}>{a.has(k) ? a(k) : k}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="section" aria-labelledby="other-rooms">
        <div className="section-head">
          <h2 id="other-rooms">{t("otherRooms")}</h2>
          <Link href="/rooms">{t("allRooms")}</Link>
        </div>
        <div className="room-grid">
          {others.map((r) => (
            <RoomCard key={r.slug} room={r} locale={locale} />
          ))}
        </div>
      </section>
    </main>
  );
}
