import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PHOTO_DIMENSIONS, frameBox, frameHeight, frameImageSize, maxSlotHeight, photoFits, pickFitting } from "@/lib/design/photo-fit";
import { mediaSrcSet } from "@/lib/media";

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

describe("frameBox", () => {
  it("fits: full slot, height capped, max width = source.w / tolerance", () => {
    expect(frameBox("rooms/rooms_76.jpg", 596, 290)).toEqual({ known: true, fits: true, maxW: 733, h: 290 });
    expect(frameBox("amenities/amenities_32.jpg", 440, 340, 1.4)).toEqual({ known: true, fits: true, maxW: 685, h: 340 });
  });
  it("reports a source too narrow for the slot and gives the largest sharp box", () => {
    // portrait 703x915 in the 596px grid3 lead: at most 468 wide, height still capped at 290
    expect(frameBox("rooms/rooms_409.jpg", 596, 290)).toEqual({ known: true, fits: false, maxW: 468, h: 290 });
  });
  it("gives a staff upload (key with no recorded dimensions) the slot's own box", () => {
    expect(frameBox("uploads/abc123.jpg", 596, 290)).toEqual({ known: false, fits: true, maxW: 596, h: 290 });
    // only own keys count as known
    expect(frameBox("constructor", 300, 200)).toEqual({ known: false, fits: true, maxW: 300, h: 200 });
  });
});

describe("frameImageSize", () => {
  it("is the recorded size for a known photo", () => {
    expect(frameImageSize("rooms/rooms_76.jpg", 596, 290)).toEqual({ w: 1100, h: 440 });
    expect(frameImageSize("amenities/amenities_32.jpg", 300, 210)).toEqual({ w: 960, h: 501 });
  });
  it("is the widest upload variant (1100px) at the slot's aspect ratio for a staff upload", () => {
    expect(frameImageSize("uploads/abc123.jpg", 596, 290)).toEqual({ w: 1100, h: 535 });
    expect(frameImageSize("uploads/abc123.jpg", 288, 210)).toEqual({ w: 1100, h: 802 });
  });
  it("lets a staff upload's srcset reach the 1100w variant for 2x screens", () => {
    const { w } = frameImageSize("uploads/abc123.jpg", 288, 210);
    expect(mediaSrcSet("uploads/abc123.jpg", w)).toContain("/media/_w1100/uploads/abc123.jpg.webp 1100w");
  });
});

describe("pickFitting", () => {
  const lead = { w: 596, h: 290 };
  it("returns the first known photo that fits", () => {
    expect(pickFitting(["rooms/rooms_76.jpg", "rooms/rooms_242.jpg"], lead)).toBe("rooms/rooms_76.jpg");
  });
  it("skips known photos too small for the slot", () => {
    // portrait 703x915 is too narrow for the 596px lead; location_* 490x230 too small in both dimensions
    expect(pickFitting(["rooms/rooms_409.jpg", "location/location_116.jpg", "rooms/rooms_76.jpg"], lead)).toBe("rooms/rooms_76.jpg");
  });
  it("accepts a staff upload (unknown key) as it comes", () => {
    expect(pickFitting(["rooms/rooms_409.jpg", "uploads/new-cover.jpg", "rooms/rooms_76.jpg"], lead)).toBe("uploads/new-cover.jpg");
  });
  it("is null when every photo is too small, or the list is empty", () => {
    expect(pickFitting(["rooms/rooms_409.jpg", "location/location_116.jpg"], lead)).toBeNull();
    expect(pickFitting([], lead)).toBeNull();
  });
  it("uses the tolerance", () => {
    expect(pickFitting(["amenities/amenities_32.jpg"], { w: 440, h: 340 })).toBeNull();
    expect(pickFitting(["amenities/amenities_32.jpg"], { w: 440, h: 340 }, 1.4)).toBe("amenities/amenities_32.jpg");
  });
});
