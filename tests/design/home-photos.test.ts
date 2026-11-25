import { describe, expect, it } from "vitest";
import { FEATURED_ROOMS, HOME_PHOTOS, HOME_ROOM_SLOTS, HOME_SLOTS } from "@/lib/content/home-photos";
import { roomImages } from "@/lib/content/old-site";
import { PHOTO_DIMENSIONS, frameBox, photoFits } from "@/lib/design/photo-fit";

const keys = Object.keys(HOME_PHOTOS) as (keyof typeof HOME_PHOTOS)[];

describe("home page photos", () => {
  it.each(keys)("%s is sharp in its desktop slot", (k) => {
    const tolerance = k === "arch" ? 1.4 : 1.5;
    expect(photoFits(HOME_PHOTOS[k], HOME_SLOTS[k], tolerance)).toBe(true);
    // Frame's own check (what throws in dev): the source fills the slot width, at the slot's full height.
    const box = frameBox(HOME_PHOTOS[k], HOME_SLOTS[k].w, HOME_SLOTS[k].h, tolerance);
    expect(box?.fits).toBe(true);
    expect(box?.h).toBe(HOME_SLOTS[k].h);
  });

  it("never uses the parking-lot graphic", () => {
    expect(Object.values(HOME_PHOTOS)).not.toContain("location/location_113.jpg");
  });

  it("only uses photos with recorded dimensions", () => {
    for (const v of Object.values(HOME_PHOTOS)) expect(PHOTO_DIMENSIONS[v], v).toBeDefined();
  });

  it("feeds the rooms grid with featured room covers that are sharp in their slots", () => {
    expect(FEATURED_ROOMS).toHaveLength(3);
    FEATURED_ROOMS.forEach((slug, i) => {
      const cover = roomImages(slug)[0];
      expect(cover, slug).toBeDefined();
      const slot = i === 0 ? HOME_ROOM_SLOTS.lead : HOME_ROOM_SLOTS.item;
      expect(photoFits(cover, slot), `${slug} ${cover}`).toBe(true);
      expect(frameBox(cover, slot.w, slot.h)?.fits).toBe(true);
    });
  });
});
