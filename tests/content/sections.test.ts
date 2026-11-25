import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FACILITY_PHOTOS } from "@/lib/content/facility-photos";
import { oldSiteContent, pageImages } from "@/lib/content/old-site";
import {
  GRID3_SLOTS,
  NEWS_THUMB,
  READING_PHOTO,
  SPLIT_SLOTS,
  assignPhotos,
  floorOf,
  photosByFloor,
  englishLabels,
  listPhotos,
  splitIntro,
  splitPhotos,
  splitSections,
} from "@/lib/content/sections";
import { frameBox } from "@/lib/design/photo-fit";

const PARKING = "location/location_113.jpg";

describe("splitSections", () => {
  it("splits on '## ' lines, keeping the text before the first heading as an untitled section", () => {
    expect(splitSections("intro\n## 5F\na\n## 8F\nb")).toEqual([
      { heading: null, body: "intro" },
      { heading: "5F", body: "a" },
      { heading: "8F", body: "b" },
    ]);
  });

  it("returns one untitled section for a body with no headings", () => {
    expect(splitSections("no headings here")).toEqual([{ heading: null, body: "no headings here" }]);
  });

  it("omits a blank intro", () => {
    expect(splitSections("\n\n## A\none\n\ntwo\n")).toEqual([{ heading: "A", body: "one\n\ntwo" }]);
  });

  it("splits every localized content page into the same number of sections in all four languages", () => {
    for (const page of oldSiteContent().pages) {
      const counts = (["zh-TW", "en", "ja", "ko"] as const).map((l) => splitSections(page.body[l]).length);
      expect(new Set(counts).size, page.slug).toBe(1);
    }
  });
});

describe("splitIntro", () => {
  it("turns a one-paragraph intro into the page lead", () => {
    expect(splitIntro(splitSections("Lead line.\n## A\na"))).toEqual({
      lead: "Lead line.",
      intro: null,
      sections: [{ heading: "A", body: "a" }],
    });
  });

  it("keeps a longer intro as running text", () => {
    expect(splitIntro(splitSections("one\n\n- two\n## A\na"))).toEqual({
      lead: null,
      intro: "one\n\n- two",
      sections: [{ heading: "A", body: "a" }],
    });
  });

  it("has neither when the body starts with a heading", () => {
    expect(splitIntro(splitSections("## A\na"))).toEqual({
      lead: null,
      intro: null,
      sections: [{ heading: "A", body: "a" }],
    });
  });
});

describe("englishLabels", () => {
  const zh = splitSections("## 五樓\na\n## 八樓\nb\n## 十四樓\nc");
  it("labels each section with the matching English heading", () => {
    expect(englishLabels(zh, splitSections("## 5th floor\na\n## 8th floor\nb\n## 14th floor\nc"))).toEqual(["5th floor", "8th floor", "14th floor"]);
  });

  it("gives no labels when the English page has a different number of headed sections", () => {
    expect(englishLabels(zh, splitSections("## 5th floor\na\n## 8th floor\nb"))).toEqual([null, null, null]);
  });

  it("counts only headed sections and leaves the intro unlabelled", () => {
    expect(englishLabels(splitSections("前言\n## 甲\na"), splitSections("## A\na"))).toEqual([null, "A"]);
  });
});

describe("assignPhotos", () => {
  it("gives each chapter at most two photos, in order", () => {
    expect(assignPhotos(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });
  it("leaves later chapters empty when photos run out", () => {
    expect(assignPhotos(["a"], 3)).toEqual([["a"], [], []]);
    expect(assignPhotos([], 2)).toEqual([[], []]);
  });
  it("returns no chapters for a chapter count of 0", () => {
    expect(assignPhotos(["a"], 0)).toEqual([]);
  });
  it("drops photos beyond two per chapter", () => {
    expect(assignPhotos(["a", "b", "c", "d", "e"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("splitPhotos", () => {
  it("takes the first photo that fills the large slot and the next that fills the small one", () => {
    // location_116 (490 x 230) fills neither; amenities_34 (960 x 501) fills both.
    expect(splitPhotos(["location/location_116.jpg", "amenities/amenities_34.jpg", "amenities/amenities_109.jpg"])).toEqual({
      large: "amenities/amenities_34.jpg",
      small: "amenities/amenities_109.jpg",
    });
  });
  it("returns null when nothing fills the large slot", () => {
    expect(splitPhotos(["location/location_116.jpg"])).toBeNull();
    expect(splitPhotos([])).toBeNull();
  });
  it("trusts a staff upload", () => {
    expect(splitPhotos(["uploads/new.jpg"])).toEqual({ large: "uploads/new.jpg", small: undefined });
  });
});

describe("photos the old-site content pages get", () => {
  const sharp = (key: string, slot: { w: number; h: number }) => {
    const box = frameBox(key, slot.w, slot.h);
    expect(box.known, key).toBe(true);
    expect(box.fits, key).toBe(true);
  };

  it("facilities: every chapter's split photos are sharp in their slots", () => {
    const page = oldSiteContent().pages.find((p) => p.slug === "facilities")!;
    const chapters = splitIntro(splitSections(page.body["zh-TW"])).sections;
    const groups = assignPhotos(page.images.slice(0, 7), chapters.length);
    expect(groups).toHaveLength(3);
    for (const g of groups) {
      const pick = splitPhotos(g);
      expect(pick, g.join()).not.toBeNull();
      sharp(pick!.large, SPLIT_SLOTS.large);
      if (pick!.small) sharp(pick!.small, SPLIT_SLOTS.small);
    }
  });

  it("attractions and groups: a grid3 whose lead and two items are sharp", () => {
    for (const slug of ["attractions", "groups"]) {
      const pick = listPhotos(oldSiteContent().pages.find((p) => p.slug === slug)!.images);
      expect(pick, slug).not.toBeNull();
      if (!pick) continue;
      sharp(pick.lead, GRID3_SLOTS.lead);
      expect(pick.items).toHaveLength(2);
      pick.items.forEach((k) => sharp(k, GRID3_SLOTS.item));
    }
  });

  it("location: its photos are too small for any slot, so none are shown (and never the parking-lot graphic)", () => {
    const images = pageImages("access");
    expect(images).toContain(PARKING);
    expect(listPhotos(images)).toBeNull();
    expect(listPhotos([PARKING, "uploads/x.jpg"])).toEqual({ lead: "uploads/x.jpg", items: [] });
  });

  it("leads with the first photo that fills the lead slot, then up to two that fill an item slot", () => {
    // attractions_361 (640 x 430) is too narrow for the 596px lead (needs 894) but fills a 288px item.
    expect(
      listPhotos([
        "attractions/attractions_361.jpg",
        "location/location_116.jpg",
        "attractions/attractions_104.jpg",
        "attractions/attractions_358.jpg",
        "attractions/attractions_356.jpg",
      ]),
    ).toEqual({ lead: "attractions/attractions_104.jpg", items: ["attractions/attractions_361.jpg", "attractions/attractions_358.jpg"] });
  });

  it("news: every old-site news photo fits the reading-column slot and the list thumbnail", () => {
    for (const n of oldSiteContent().news)
      for (const k of n.images) {
        sharp(k, READING_PHOTO);
        sharp(k, NEWS_THUMB);
      }
  });
});

describe("photosByFloor", () => {
  it("reads the floor from an English heading or caption", () => {
    expect(floorOf("8th floor (8th-floor guests only)")).toBe(8);
    expect(floorOf("The 14F roof terrace, with Taipei 101 in the distance")).toBe(14);
    expect(floorOf("Self-service laundry on 8F")).toBe(8);
    expect(floorOf("Rooftop")).toBeNull();
  });

  it("gives each chapter its own floor's photos, in order, at most two", () => {
    const floors = { a: 5, b: 14, c: 8, d: 5, e: 5, f: 8 };
    expect(photosByFloor(["a", "b", "c", "d", "e", "f"], [5, 8, 14], floors)).toEqual([["a", "d"], ["c", "f"], ["b"]]);
  });

  it("falls back to the plain order when a chapter has no floor or no photo of its floor", () => {
    expect(photosByFloor(["a", "b", "c"], [5, null], { a: 5, b: 8, c: 5 })).toEqual([["a", "b"], ["c"]]);
    expect(photosByFloor(["a", "upload"], [5, 8], { a: 5 })).toEqual([["a", "upload"], []]);
  });

  it("facilities: every floor chapter shows only its own floor's photos", () => {
    const en = JSON.parse(readFileSync("messages/en.json", "utf8")).facilityPhoto as Record<string, string>;
    const photoFloors = Object.fromEntries(Object.entries(FACILITY_PHOTOS).map(([k, v]) => [k, floorOf(en[v])]));
    const page = oldSiteContent().pages.find((p) => p.slug === "facilities")!;
    const chapterFloors = splitIntro(splitSections(page.body.en)).sections.map((s) => floorOf(s.heading!));
    const groups = photosByFloor(page.images, chapterFloors, photoFloors);
    expect(groups.map((g) => g.map((k) => FACILITY_PHOTOS[k]))).toEqual([["bar", "lounge5"], ["laundry", "lounge8"], ["rooftop"]]);
  });
});
