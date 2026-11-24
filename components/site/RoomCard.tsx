import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { RoomCard as Room } from "@/lib/content-repo";
import type { Locale } from "@/lib/db/schema";
import { Photo } from "./Photo";
import { formatPrice } from "./price";

/** Room card from design/tokens.md section 9: 4:3 photo, name, English name, summary, price row. */
export async function RoomCard({ room, locale, headingLevel = 3 }: { room: Room; locale: Locale; headingLevel?: 2 | 3 }) {
  const t = await getTranslations({ locale, namespace: "rooms" });
  const H = headingLevel === 2 ? "h2" : "h3";
  const href = `/rooms/${room.slug}`;
  return (
    <article className="room-card">
      {room.image && (
        <Link href={href} tabIndex={-1} aria-hidden="true">
          <Photo src={room.image} alt="" width={800} height={600} />
        </Link>
      )}
      <H>
        <Link href={href}>{room.name}</Link>
      </H>
      {room.name !== room.nameEn && (
        <span className="en" lang="en">
          {room.nameEn}
        </span>
      )}
      <p>{room.summary}</p>
      <p className="room-facts">
        <span>{t("guestsValue", { count: room.maxOccupancy })}</span>
        {room.sizeSqm ? <span>{t("sizeValue", { sqm: room.sizeSqm })}</span> : null}
      </p>
      <div className="meta">
        {room.fromPrice !== null ? (
          <span className="price">
            {formatPrice(room.fromPrice)} <small>{t("perNight")}</small>
          </span>
        ) : (
          <span />
        )}
        <Link className="book" href={href} aria-label={`${t("viewRoom")}：${room.name}`}>
          {t("viewRoom")}
        </Link>
      </div>
    </article>
  );
}
