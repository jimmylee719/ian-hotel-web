import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { loadRooms } from "@/components/site/data";
import { PageHead } from "@/components/site/PageHead";
import { RoomCard } from "@/components/site/RoomCard";
import type { Locale } from "@/lib/db/schema";
import { buildMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "rooms" });
  return buildMetadata({ locale, path: "/rooms", title: t("title"), description: t("description"), image: "rooms/rooms_76.jpg" });
}

export default async function RoomsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "rooms" });
  const rooms = await loadRooms(locale);

  return (
    <main id="main" className="wrap">
      <PageHead title={t("title")} lead={t("intro")} />
      <div className="room-rows">
        {rooms.map((room, i) => (
          <RoomCard key={room.slug} room={room} locale={locale} headingLevel={2} flip={i % 2 === 1} priority={i === 0} />
        ))}
      </div>
    </main>
  );
}
