import { describe, expect, it } from "vitest";
import { formatPrice } from "@/components/site/price";
import { roomImages } from "@/lib/content/old-site";
import { GALLERY_SLOTS, ROW_SLOT, galleryPhotos, roomGallery, roomRowProps } from "@/lib/design/room-row";
import { frameBox, photoFits } from "@/lib/design/photo-fit";

const room = (photos: string[], fromPrice: number | null = 2980) => ({ photos, fromPrice });

describe("roomRowProps", () => {
  it("uses a sharp cover at the full row height", () => {
    expect(roomRowProps(room(["rooms/rooms_76.jpg"]))).toEqual({ hasPhoto: true, photo: "rooms/rooms_76.jpg", price: formatPrice(2980), photoHeight: 290 });
  });

  it("shortens the frame for a 790 x 380 photo (380 / 1.5)", () => {
    expect(roomRowProps(room(["rooms/rooms_399.jpg"]))).toMatchObject({ photo: "rooms/rooms_399.jpg", photoHeight: 253 });
  });

  it("skips a cover too small for the row and uses the next photo that fits", () => {
    expect(roomRowProps(room(["rooms/rooms_409.jpg", "rooms/rooms_76.jpg"]))).toMatchObject({ hasPhoto: true, photo: "rooms/rooms_76.jpg", photoHeight: 290 });
  });

  it("trusts a staff upload and gives it the full row height", () => {
    expect(roomRowProps(room(["uploads/rooms/abc123.jpg", "rooms/rooms_76.jpg"]))).toMatchObject({ hasPhoto: true, photo: "uploads/rooms/abc123.jpg", photoHeight: 290 });
  });

  it("has no photo when there is none, or none fits", () => {
    expect(roomRowProps(room([]))).toEqual({ hasPhoto: false, photo: null, price: formatPrice(2980), photoHeight: 0 });
    expect(roomRowProps(room(["rooms/rooms_138.jpg", "rooms/rooms_409.jpg"]))).toMatchObject({ hasPhoto: false, photo: null, photoHeight: 0 });
  });

  it("has no price text when there is no price", () => {
    expect(roomRowProps(room(["rooms/rooms_76.jpg"], null)).price).toBeNull();
  });

  it("matches the height Frame gives the chosen photo", () => {
    for (const key of ["rooms/rooms_76.jpg", "rooms/rooms_399.jpg"]) {
      const { photoHeight } = roomRowProps(room([key]));
      const box = frameBox(key, ROW_SLOT.w, 290);
      expect(box.fits).toBe(true);
      expect(box.h).toBe(photoHeight);
    }
  });
});

const ROOMS = ["mixed-cube", "deluxe-room", "classic-room", "mini-room", "buddy-room-six", "buddy-room", "female-cube", "connecting-room"];

describe("roomGallery", () => {
  it("lays the old-site photos out as grid3 (1100-wide lead, two items) plus the rest", () => {
    const g = roomGallery(roomImages("deluxe-room"));
    expect(g).toEqual({
      kind: "grid3",
      lead: "rooms/rooms_76.jpg",
      items: ["rooms/rooms_399.jpg", "rooms/rooms_131.jpg"],
      more: ["rooms/rooms_309.jpg", "rooms/rooms_78.jpg", "rooms/rooms_313.jpg", "rooms/rooms_312.jpg", "rooms/rooms_316.jpg"],
    });
  });

  it("keeps short 500-wide photos in the shorter 'more' slot (500 x 221 -> 288 x 147)", () => {
    const g = roomGallery(roomImages("mixed-cube"));
    expect(g.kind).toBe("grid3");
    const all = g.kind === "grid3" ? [g.lead, ...g.items, ...g.more] : [];
    expect(g.kind === "grid3" && g.items).not.toContain("rooms/rooms_138.jpg"); // too short for a 210px grid3 item
    expect(g.more).toContain("rooms/rooms_138.jpg");
    expect(all).toHaveLength(8);
  });

  it.each(["mixed-cube", "female-cube"])("%s shows all 8 of its photos", (slug) => {
    expect(galleryPhotos(roomGallery(roomImages(slug)))).toHaveLength(8);
  });

  it.each(ROOMS)("%s shows every one of its photos that fits some gallery slot", (slug) => {
    const images = roomImages(slug);
    const fitsSome = images.filter((k) => Object.values(GALLERY_SLOTS).some((slot) => photoFits(k, slot)));
    expect(new Set(galleryPhotos(roomGallery(images)))).toEqual(new Set(fitsSome));
  });

  it("lists the gallery's photos in display order (the viewer's order)", () => {
    expect(galleryPhotos({ kind: "split", large: "a", small: "b", more: ["c"] })).toEqual(["a", "b", "c"]);
    expect(galleryPhotos({ kind: "split", large: "a", small: null, more: [] })).toEqual(["a"]);
    expect(galleryPhotos({ kind: "grid3", lead: "a", items: ["b", "c"], more: ["d"] })).toEqual(["a", "b", "c", "d"]);
    expect(galleryPhotos({ kind: "none", more: ["d"] })).toEqual(["d"]);
  });

  it("falls back to split when no photo can fill the grid3 lead", () => {
    expect(roomGallery(["rooms/rooms_399.jpg", "rooms/rooms_131.jpg", "rooms/rooms_309.jpg"])).toEqual({
      kind: "split",
      large: "rooms/rooms_399.jpg",
      small: "rooms/rooms_131.jpg",
      more: ["rooms/rooms_309.jpg"],
    });
  });

  it("trusts staff uploads in any slot", () => {
    expect(roomGallery(["uploads/a.jpg", "uploads/b.jpg"])).toEqual({ kind: "grid3", lead: "uploads/a.jpg", items: ["uploads/b.jpg"], more: [] });
  });

  it("is empty when nothing fits", () => {
    expect(roomGallery([])).toEqual({ kind: "none", more: [] });
    expect(roomGallery(["attractions/attractions_19.png"])).toEqual({ kind: "none", more: [] }); // 55 x 48 icon
  });

  it("never repeats a photo", () => {
    expect(roomGallery(["rooms/rooms_76.jpg", "rooms/rooms_76.jpg", "rooms/rooms_399.jpg"])).toEqual({ kind: "grid3", lead: "rooms/rooms_76.jpg", items: ["rooms/rooms_399.jpg"], more: [] });
  });

  it.each(ROOMS)("%s: every picked photo fills its slot width (Frame would not throw)", (slug) => {
    const g = roomGallery(roomImages(slug));
    const placed: [string, { w: number; h: number }][] =
      g.kind === "grid3"
        ? [[g.lead, GALLERY_SLOTS.lead], ...g.items.map((k) => [k, GALLERY_SLOTS.item] as [string, { w: number; h: number }])]
        : g.kind === "split"
          ? [[g.large, GALLERY_SLOTS.large], ...(g.small ? [[g.small, GALLERY_SLOTS.small] as [string, { w: number; h: number }]] : [])]
          : [];
    for (const k of g.more) placed.push([k, GALLERY_SLOTS.more]);
    expect(placed.length).toBeGreaterThan(0);
    for (const [key, slot] of placed) expect(frameBox(key, slot.w, slot.h).fits, `${key} in ${slot.w}`).toBe(true);
  });
});
