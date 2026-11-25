import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { RoomCard as Room } from "@/lib/content-repo";
import type { Locale } from "@/lib/db/schema";
import { ROW_SLOT, roomRowProps } from "@/lib/design/room-row";
import { Frame } from "./sections/Frame";

/**
 * Editorial room row (spec §5.3 Rooms list): photo on one side (the other side when `flip`), then name, English name,
 * summary, facts, the "from" price and the booking link. The photo is the room's first photo sharp enough for the row
 * (lib/design/room-row.ts); with none, the row is text only, and with no price there is no price text. `priority` loads
 * the photo first (the rooms list's first row is its LCP image).
 */
export async function RoomCard({ room, locale, headingLevel = 3, flip = false, priority = false }: { room: Room; locale: Locale; headingLevel?: 2 | 3; flip?: boolean; priority?: boolean }) {
  const t = await getTranslations({ locale, namespace: "rooms" });
  const H = headingLevel === 2 ? "h2" : "h3";
  const href = `/rooms/${room.slug}`;
  const row = roomRowProps(room);
  return (
    <article className={["room-row", flip && "is-flipped", !row.photo && "no-photo"].filter(Boolean).join(" ")}>
      {row.photo && (
        <Link className="room-row-media" href={href} tabIndex={-1} aria-hidden="true">
          <Frame className="room-row-photo" src={row.photo} alt="" slotWidth={ROW_SLOT.w} cap={row.photoHeight} sizes="(max-width: 900px) calc(100vw - 40px), 520px" priority={priority} />
        </Link>
      )}
      <div className="room-row-text">
        <H className="room-row-name">
          <Link href={href}>{room.name}</Link>
        </H>
        {room.name !== room.nameEn && (
          <p className="room-row-en" lang="en">
            {room.nameEn}
          </p>
        )}
        <p className="room-row-summary">{room.summary}</p>
        <p className="room-facts">
          <span>{t("guestsValue", { count: room.maxOccupancy })}</span>
          {room.bedType ? <span>{room.bedType}</span> : null}
          {room.sizeSqm ? <span>{t("sizeValue", { sqm: room.sizeSqm })}</span> : null}
        </p>
        <div className="room-row-meta">
          {row.price !== null && (
            <span className="price">
              {row.price} <small>{t("perNight")}</small>
            </span>
          )}
          <span className="room-row-actions">
            <Link className="text-link" href={href} aria-label={`${t("viewRoom")}：${room.name}`}>
              {t("viewRoom")}
            </Link>
            <Link className="cta room-row-book" href={{ pathname: "/book", query: { room: room.slug } }} aria-label={`${t("bookRoom")}：${room.name}`}>
              {t("bookRoom")}
            </Link>
          </span>
        </div>
      </div>
    </article>
  );
}
