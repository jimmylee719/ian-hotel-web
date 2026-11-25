import { describe, expect, it } from "vitest";
import { FEATURED_ROOMS, HOME_PHOTOS, HOME_ROOM_SLOTS, HOME_SLOTS, featuredRoomPhotos } from "@/lib/content/home-photos";
import { roomImages } from "@/lib/content/old-site";
import { PHOTO_DIMENSIONS, frameBox, photoFits } from "@/lib/design/photo-fit";

const keys = Object.keys(HOME_PHOTOS) as (keyof typeof HOME_PHOTOS)[];

describe("home page photos", () => {
  it.each(keys)("%s is sharp in its desktop slot", (k) => {
    const tolerance = k === "arch" ? 1.4 : 1.5;
    expect(photoFits(HOME_PHOTOS[k], HOME_SLOTS[k], tolerance)).toBe(true);
    // Frame's own check (what throws in dev): a known old-site photo that fills the slot width at full height.
    const box = frameBox(HOME_PHOTOS[k], HOME_SLOTS[k].w, HOME_SLOTS[k].h, tolerance);
    expect(box.known).toBe(true);
    expect(box.fits).toBe(true);
    expect(box.h).toBe(HOME_SLOTS[k].h);
  });

  it("never uses the parking-lot graphic", () => {
    expect(Object.values(HOME_PHOTOS)).not.toContain("location/location_113.jpg");
  });

  it("only uses photos with recorded dimensions", () => {
    for (const v of Object.values(HOME_PHOTOS)) expect(PHOTO_DIMENSIONS[v], v).toBeDefined();
  });

  it("feeds the rooms grid with the old-site covers of the featured rooms, each sharp in its slot", () => {
    const rooms = FEATURED_ROOMS.map((slug) => ({ slug, photos: roomImages(slug) }));
    const grid = featuredRoomPhotos(rooms);
    expect(grid.map((g) => [g.room.slug, g.photo])).toEqual([
      ["deluxe-room", "rooms/rooms_76.jpg"],
      ["classic-room", "rooms/rooms_242.jpg"],
      ["mixed-cube", "rooms/rooms_4.jpg"],
    ]);
    grid.forEach((g, i) => {
      const slot = i === 0 ? HOME_ROOM_SLOTS.lead : HOME_ROOM_SLOTS.item;
      expect(frameBox(g.photo, slot.w, slot.h).fits, g.photo).toBe(true);
    });
  });

  it("uses a staff-uploaded cover as it is", () => {
    const grid = featuredRoomPhotos([
      { slug: "deluxe-room", photos: ["uploads/deluxe-new.jpg", "rooms/rooms_76.jpg"] },
      { slug: "classic-room", photos: ["rooms/rooms_242.jpg"] },
    ]);
    expect(grid.map((g) => g.photo)).toEqual(["uploads/deluxe-new.jpg", "rooms/rooms_242.jpg"]);
  });

  it("skips a cover too small for its slot in favour of the room's next photo", () => {
    // portrait rooms_409 (703 wide) cannot fill the 596px lead
    const grid = featuredRoomPhotos([{ slug: "deluxe-room", photos: ["rooms/rooms_409.jpg", "rooms/rooms_76.jpg"] }]);
    expect(grid.map((g) => g.photo)).toEqual(["rooms/rooms_76.jpg"]);
  });

  it("leaves out a room with no photo that fits, and the next room becomes the lead", () => {
    const grid = featuredRoomPhotos([
      { slug: "deluxe-room", photos: ["rooms/rooms_409.jpg", "location/location_116.jpg"] },
      { slug: "classic-room", photos: ["rooms/rooms_242.jpg"] },
      { slug: "mixed-cube", photos: [] },
    ]);
    expect(grid.map((g) => [g.room.slug, g.photo])).toEqual([["classic-room", "rooms/rooms_242.jpg"]]);
    expect(frameBox(grid[0].photo, HOME_ROOM_SLOTS.lead.w, HOME_ROOM_SLOTS.lead.h).fits).toBe(true);
  });
});
