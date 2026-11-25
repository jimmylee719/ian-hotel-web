/**
 * Photos on the home page (spec §5.3 Home) and the desktop slot each one fills. Every pick must pass the sharpness
 * rule in its slot (tests/design/home-photos.test.ts); `Frame` also throws outside production if one does not.
 *
 * Slot sizes mirror the section components: ArchPhoto 440 x <=340 (tolerance 1.4), PhotoSplit large 495 x <=330 and
 * small 381 x <=240, PhotoGrid3 lead 596 x <=290 and items 288 x <=210.
 */
export const HOME_PHOTOS = {
  /** Hero arch: the 8F lounge (960 x 501). The 1100 x 440 room covers are too short for a 340px arch. */
  arch: "amenities/amenities_32.jpg",
  /** Chapter 02, large: the reading corner in the 5F lounge (960 x 501). */
  spacesLarge: "amenities/amenities_34.jpg",
  /** Chapter 02, small: the NK BAR counter on 5F (930 x 553). */
  spacesSmall: "amenities/amenities_109.jpg",
  /** Chapter 03: the 14F roof terrace with Taipei 101 in the distance (944 x 561). */
  access: "amenities/amenities_36.jpg",
} as const;

export type HomePhotoSlot = keyof typeof HOME_PHOTOS;

export const HOME_SLOTS: Record<HomePhotoSlot, { w: number; h: number }> = {
  arch: { w: 440, h: 340 },
  spacesLarge: { w: 495, h: 330 },
  spacesSmall: { w: 381, h: 240 },
  access: { w: 495, h: 330 },
};

/** Chapter 01 shows these room types' cover photos: the first as the grid3 lead, the other two as captioned items. */
export const FEATURED_ROOMS = ["deluxe-room", "classic-room", "mixed-cube"] as const;

export const HOME_ROOM_SLOTS = {
  lead: { w: 596, h: 290 },
  item: { w: 288, h: 210 },
} as const;
