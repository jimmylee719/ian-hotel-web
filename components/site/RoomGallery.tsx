import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { GALLERY_SLOTS, MORE_CAP, galleryPhotos, roomGallery } from "@/lib/design/room-row";
import { PhotoViewer } from "./PhotoViewer";
import { Frame } from "./sections/Frame";
import { PhotoGrid3 } from "./sections/PhotoGrid3";
import { PhotoSplit } from "./sections/PhotoSplit";

/**
 * Room photos as grid3 (wide lead + two items, `children` in the text slot), or split when no photo can fill the
 * lead, followed by the room's other photos in a three-column grid. Every photo is placed only in a slot it fills
 * sharply (lib/design/room-row.ts). Each photo is a button that opens it at full source size in PhotoViewer.
 * The lead (or split large) photo is the page's LCP image, so it loads first.
 */
export async function RoomGallery({ images, roomName, children }: { images: string[]; roomName: string; children?: ReactNode }) {
  const t = await getTranslations("rooms");
  const layout = roomGallery(images);
  const shown = galleryPhotos(layout);
  const order = new Map(images.map((k, i) => [k, i] as const));
  const alt = (key: string) => t("photoAlt", { room: roomName, n: (order.get(key) ?? 0) + 1 });
  /** Photo props for a gallery slot: its alt text and the viewer button (index in display order). */
  const photo = (key: string) => {
    const i = shown.indexOf(key);
    return { src: key, alt: alt(key), open: { index: i, label: t("openPhoto", { n: i + 1 }) } };
  };

  return (
    <PhotoViewer photos={shown.map((k) => ({ src: k, alt: alt(k) }))} label={t("photos", { room: roomName })}>
      <div className="room-gallery">
        {layout.kind === "grid3" && (
          <PhotoGrid3 lead={photo(layout.lead)} items={layout.items.map(photo)} priority>
            {children}
          </PhotoGrid3>
        )}
        {layout.kind === "split" && (
          <PhotoSplit large={photo(layout.large)} small={layout.small ? photo(layout.small) : undefined} priority>
            {children}
          </PhotoSplit>
        )}
        {layout.kind === "none" && children}
        {layout.more.length > 0 && (
          <ul className="room-gallery-more" aria-label={t("photos", { room: roomName })}>
            {layout.more.map((k) => (
              <li key={k}>
                <Frame
                  className="room-gallery-photo"
                  {...photo(k)}
                  slotWidth={GALLERY_SLOTS.more.w}
                  cap={MORE_CAP}
                  sizes="(max-width: 700px) calc(100vw - 40px), 288px"
                  priority={layout.kind === "none" && k === layout.more[0]}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </PhotoViewer>
  );
}
