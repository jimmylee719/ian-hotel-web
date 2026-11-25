import { describe, expect, it } from "vitest";
import { formatPrice } from "@/components/site/price";
import { roomImages } from "@/lib/content/old-site";
import { GALLERY_SLOTS, ROW_SLOT, roomGallery, roomRowProps } from "@/lib/design/room-row";
import { frameBox } from "@/lib/design/photo-fit";

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

  it("leaves out photos too small for any slot (500 x 221, a 703-wide portrait in the lead)", () => {
    const g = roomGallery(roomImages("mixed-cube"));
    expect(g.kind).toBe("grid3");
    const all = g.kind === "grid3" ? [g.lead, ...g.items, ...g.more] : [];
    expect(all).not.toContain("rooms/rooms_138.jpg");
    expect(all).toContain("rooms/rooms_137.jpg"); // 500 x 333 still fills a 288 item slot
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
    expect(roomGallery(["rooms/rooms_138.jpg"])).toEqual({ kind: "none", more: [] });
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
    for (const k of g.more) placed.push([k, GALLERY_SLOTS.item]);
    expect(placed.length).toBeGreaterThan(0);
    for (const [key, slot] of placed) expect(frameBox(key, slot.w, slot.h).fits, `${key} in ${slot.w}`).toBe(true);
  });
});
