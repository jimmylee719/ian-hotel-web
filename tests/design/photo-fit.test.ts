import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PHOTO_DIMENSIONS, frameHeight, maxSlotHeight, photoFits } from "@/lib/design/photo-fit";

describe("photo dimensions manifest", () => {
  it("has an entry for every file under content/images and nothing else", () => {
    const root = join(process.cwd(), "content/images");
    const keys: string[] = [];
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory()) for (const f of readdirSync(join(root, d.name))) keys.push(`${d.name}/${f}`);
    }
    expect(Object.keys(PHOTO_DIMENSIONS).sort()).toEqual(keys.sort());
  });

  it("records known sizes", () => {
    expect(PHOTO_DIMENSIONS["rooms/rooms_76.jpg"]).toEqual({ w: 1100, h: 440 });
    expect(PHOTO_DIMENSIONS["amenities/amenities_32.jpg"]).toEqual({ w: 960, h: 501 });
  });
});

describe("photoFits", () => {
  it("applies the rule to both dimensions", () => {
    expect(photoFits("amenities/amenities_32.jpg", { w: 440, h: 340 }, 1.4)).toBe(true);
    expect(photoFits("amenities/amenities_32.jpg", { w: 400, h: 500 })).toBe(false);
    expect(photoFits("rooms/rooms_76.jpg", { w: 600, h: 290 })).toBe(true);
    expect(photoFits("rooms/rooms_76.jpg", { w: 600, h: 300 })).toBe(false);
  });
  it("is false for unknown keys", () => {
    expect(photoFits("nope.jpg", { w: 1, h: 1 })).toBe(false);
  });
});

describe("maxSlotHeight", () => {
  it("returns the largest height that still fits", () => {
    expect(maxSlotHeight("rooms/rooms_76.jpg", 600)).toBe(293);
  });
  it("is 0 for unknown keys or a slot too wide for the source", () => {
    expect(maxSlotHeight("nope.jpg", 600)).toBe(0);
    expect(maxSlotHeight("rooms/rooms_76.jpg", 1000)).toBe(0);
  });
});

describe("frameHeight", () => {
  it("is the sharp maximum, capped at the frame's own maximum", () => {
    expect(frameHeight("rooms/rooms_76.jpg", 600, 330)).toBe(293);
    expect(frameHeight("amenities/amenities_32.jpg", 495, 330)).toBe(330);
    expect(frameHeight("amenities/amenities_32.jpg", 440, 340, 1.4)).toBe(340);
  });
  it("is 0 when the source cannot fill the slot sharply", () => {
    expect(frameHeight("nope.jpg", 300, 300)).toBe(0);
    expect(frameHeight("rooms/rooms_76.jpg", 800, 300)).toBe(0);
  });
});
