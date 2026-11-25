import { pickFitting } from "@/lib/design/photo-fit";

/**
 * Content-page bodies (content/localized/pages.ts format: "## " starts a heading) split into the sections the
 * chapter layouts are built from (spec §5.3 Facilities, location, attractions, groups), and the photos each gets.
 */
export type Section = { heading: string | null; body: string };

/**
 * Splits a body on lines starting with "## ". Text before the first heading is a section with `heading: null`
 * (left out when blank); a body with no heading is one such section.
 */
export function splitSections(body: string): Section[] {
  const out: Section[] = [];
  let current: { heading: string | null; lines: string[] } = { heading: null, lines: [] };
  const flush = () => {
    const text = current.lines.join("\n").trim();
    if (current.heading !== null || text) out.push({ heading: current.heading, body: text });
  };
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      current = { heading: line.slice(3).trim(), lines: [] };
    } else current.lines.push(line);
  }
  flush();
  return out;
}

/**
 * Separates the untitled intro from the headed sections. A one-line intro becomes the page lead (shown in the page
 * head); anything longer stays running text (`intro`).
 */
export function splitIntro(sections: Section[]): {
  lead: string | null;
  intro: string | null;
  sections: Section[];
} {
  const [first, ...rest] = sections;
  if (!first || first.heading !== null) return { lead: null, intro: null, sections };
  const oneLine = !first.body.includes("\n") && !first.body.startsWith("- ");
  return { lead: oneLine ? first.body : null, intro: oneLine ? null : first.body, sections: rest };
}

/**
 * Small-caps English label for each section: the i-th headed section gets the i-th English heading, when both lists
 * have the same number of headed sections; otherwise (or for an untitled section) null.
 */
export function englishLabels(sections: Section[], enSections: Section[]): (string | null)[] {
  const en = enSections.filter((s) => s.heading !== null);
  if (sections.filter((s) => s.heading !== null).length !== en.length) return sections.map(() => null);
  let k = 0;
  return sections.map((s) => (s.heading === null ? null : en[k++].heading));
}

/** The page's flat photo list, in order, at most two per chapter; chapters past the end get none. */
export function assignPhotos(photos: string[], chapterCount: number): string[][] {
  return Array.from({ length: chapterCount }, (_, i) => photos.slice(i * 2, i * 2 + 2));
}

/** The first whole number in a text: the floor in "5th floor" or "The NK BAR counter on 5F"; null if none. */
export function floorOf(text: string): number | null {
  const m = /\d+/.exec(text);
  return m ? Number(m[0]) : null;
}

/**
 * Photos per chapter by floor: each chapter gets (in order, at most two) the photos whose floor matches its own.
 * `chapterFloors[i]` is chapter i's floor; `photoFloors` maps a photo key to its floor. When any chapter has no floor
 * or no photo of its floor (an unknown caption, a staff upload), falls back to `assignPhotos` in order.
 */
export function photosByFloor(photos: string[], chapterFloors: (number | null)[], photoFloors: Record<string, number | null | undefined>): string[][] {
  const groups = chapterFloors.map((floor) => (floor === null ? [] : photos.filter((k) => photoFloors[k] === floor).slice(0, 2)));
  return groups.some((g) => g.length === 0) ? assignPhotos(photos, chapterFloors.length) : groups;
}

/*
 * Desktop slots of the section components (keep in sync with components/site/sections/PhotoSplit.tsx and
 * PhotoGrid3.tsx), and the photo slot of the news reading column (app/[locale]/news/[slug]/page.tsx).
 */
export const SPLIT_SLOTS = {
  large: { w: 495, h: 330 },
  small: { w: 381, h: 240 },
} as const;
export const GRID3_SLOTS = {
  lead: { w: 596, h: 290 },
  item: { w: 288, h: 210 },
} as const;
export const READING_PHOTO = { w: 420, h: 300 } as const;
/** News list thumbnail: the 280px column at 3:2. */
export const NEWS_THUMB = { w: 280, h: 186 } as const;

/** The old site's parking-lot graphic: never shown as a photo. */
const NEVER_SHOWN = new Set(["location/location_113.jpg"]);

const usable = (keys: readonly string[]) => keys.filter((k) => !NEVER_SHOWN.has(k));
const fits = (key: string, slot: { w: number; h: number }) => pickFitting([key], slot) === key;

/** A chapter's PhotoSplit: the first photo that fills the large slot, then the next that fills the small one. */
export function splitPhotos(keys: readonly string[]): { large: string; small: string | undefined } | null {
  const candidates = usable(keys);
  const large = pickFitting(candidates, SPLIT_SLOTS.large);
  if (!large) return null;
  return {
    large,
    small:
      pickFitting(
        candidates.filter((k) => k !== large),
        SPLIT_SLOTS.small,
      ) ?? undefined,
  };
}

/**
 * The single PhotoGrid3 of a list-layout page: the first photo that fills the lead slot, then up to two that fill an
 * item slot. Photos that fit no slot are left out; null when nothing fills the lead.
 */
export function listPhotos(keys: readonly string[]): { lead: string; items: string[] } | null {
  const candidates = usable(keys);
  const lead = pickFitting(candidates, GRID3_SLOTS.lead);
  if (!lead) return null;
  return { lead, items: candidates.filter((k) => k !== lead && fits(k, GRID3_SLOTS.item)).slice(0, 2) };
}
