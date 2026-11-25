import { formatPrice } from "@/components/site/price";
import { maxSlotHeight, pickFitting } from "./photo-fit";

/*
 * Photo picks for the rooms list rows and the room page gallery, within the sharpness rule (spec §5.2).
 *
 * Each slot is `{ w, h }` where `w` is the frame's desktop width and `h` the smallest frame height worth showing:
 * frames are cover-fit and shortened to the source (`Frame` sets height = min(cap, source.h / 1.5)), so a photo is
 * picked when it fills the width and still gives a frame at least `h` tall. Staff uploads (no recorded size) are
 * trusted and shown at the slot's design height.
 */

/** Rooms list row photo: 520px wide, frame height <= ROW_CAP. */
export const ROW_SLOT = { w: 520, h: 200 } as const;
export const ROW_CAP = 290;

/** Room page gallery slots; widths mirror PhotoGrid3 (lead 596, item 288) and PhotoSplit (large 495, small 381). */
export const GALLERY_SLOTS = {
  lead: { w: 596, h: 240 },
  item: { w: 288, h: 200 },
  large: { w: 495, h: 240 },
  small: { w: 381, h: 200 },
} as const;

/**
 * Display data for a rooms list row. `photo` is the first of the room's photos that fills the row (a cover too small
 * for it gives way to the next photo); `photoHeight` is the frame height Frame gives it (ROW_CAP for an upload),
 * 0 with no photo. `price` is null when there is no price, so no price text is shown.
 */
export function roomRowProps(room: { photos: readonly string[]; fromPrice: number | null }): {
  hasPhoto: boolean;
  photo: string | null;
  price: string | null;
  photoHeight: number;
} {
  const photo = pickFitting(room.photos, ROW_SLOT);
  const price = room.fromPrice === null ? null : formatPrice(room.fromPrice);
  if (!photo) return { hasPhoto: false, photo: null, price, photoHeight: 0 };
  const sharp = maxSlotHeight(photo, ROW_SLOT.w);
  return { hasPhoto: true, photo, price, photoHeight: sharp === 0 ? ROW_CAP : Math.min(ROW_CAP, sharp) };
}

export type RoomGalleryLayout =
  | { kind: "grid3"; lead: string; items: string[]; more: string[] }
  | { kind: "split"; large: string; small: string | null; more: string[] }
  | { kind: "none"; more: string[] };

/**
 * The room page gallery: grid3 (a lead wide enough for the 596px slot, then two items) when some photo can fill the
 * lead; otherwise split (large + small). Every remaining photo that fills a 288px item goes in `more`. Photos are used
 * once each, in the room's order; photos too small for any slot they could take are left out.
 */
export function roomGallery(images: readonly string[]): RoomGalleryLayout {
  const rest = [...new Set(images)];
  const take = (slot: { w: number; h: number }): string | null => {
    const k = pickFitting(rest, slot);
    if (k !== null) rest.splice(rest.indexOf(k), 1);
    return k;
  };
  const takeAll = (slot: { w: number; h: number }, max = Infinity): string[] => {
    const out: string[] = [];
    while (out.length < max) {
      const k = take(slot);
      if (k === null) break;
      out.push(k);
    }
    return out;
  };

  const lead = take(GALLERY_SLOTS.lead);
  if (lead) {
    const items = takeAll(GALLERY_SLOTS.item, 2);
    return { kind: "grid3", lead, items, more: takeAll(GALLERY_SLOTS.item) };
  }
  const large = take(GALLERY_SLOTS.large);
  if (large) {
    const small = take(GALLERY_SLOTS.small);
    return { kind: "split", large, small, more: takeAll(GALLERY_SLOTS.item) };
  }
  return { kind: "none", more: takeAll(GALLERY_SLOTS.item) };
}
