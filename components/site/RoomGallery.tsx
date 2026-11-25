import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { GALLERY_SLOTS, roomGallery } from "@/lib/design/room-row";
import { Frame } from "./sections/Frame";
import { PhotoGrid3 } from "./sections/PhotoGrid3";
import { PhotoSplit } from "./sections/PhotoSplit";

/**
 * Room photos as grid3 (wide lead + two items, `children` in the text slot), or split when no photo can fill the
 * lead, followed by the room's other photos in a three-column grid. Every photo is placed only in a slot it fills
 * sharply (lib/design/room-row.ts); photos too small for any slot are left out. No lightbox.
 */
export async function RoomGallery({ images, roomName, children }: { images: string[]; roomName: string; children?: ReactNode }) {
  const t = await getTranslations("rooms");
  const layout = roomGallery(images);
  const order = new Map(images.map((k, i) => [k, i] as const));
  const alt = (key: string) => t("photoAlt", { room: roomName, n: (order.get(key) ?? 0) + 1 });

  return (
    <div className="room-gallery">
      {layout.kind === "grid3" && (
        <PhotoGrid3 lead={{ src: layout.lead, alt: alt(layout.lead) }} items={layout.items.map((k) => ({ src: k, alt: alt(k) }))}>
          {children}
        </PhotoGrid3>
      )}
      {layout.kind === "split" && (
        <PhotoSplit large={{ src: layout.large, alt: alt(layout.large) }} small={layout.small ? { src: layout.small, alt: alt(layout.small) } : undefined}>
          {children}
        </PhotoSplit>
      )}
      {layout.kind === "none" && children}
      {layout.more.length > 0 && (
        <ul className="room-gallery-more" aria-label={t("photos", { room: roomName })}>
          {layout.more.map((k) => (
            <li key={k}>
              <Frame className="room-gallery-photo" src={k} alt={alt(k)} slotWidth={GALLERY_SLOTS.item.w} cap={210} sizes="(max-width: 700px) calc(100vw - 40px), 288px" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
