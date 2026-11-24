/**
 * One idempotency key per stay selection, kept in sessionStorage: going back from the payment page
 * and submitting again replays the same booking (and its inventory hold) instead of holding a second
 * one. Pure helpers, so they are testable without a browser.
 */

export type StaySelection = {
  propertySlug: string;
  unitTypeSlug: string;
  ratePlanSlug: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  rooms: number;
  addons: { slug: string; qty: number }[];
};

type KeyStore = Pick<Storage, "getItem" | "setItem">;

/** FNV-1a 32-bit, hex. Only needs to tell selections apart within one tab. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The sessionStorage slot for a selection; add-on order does not matter. */
export function selectionSlot(s: StaySelection): string {
  const addons = [...s.addons].sort((a, b) => a.slug.localeCompare(b.slug)).map((a) => `${a.slug}:${a.qty}`).join(",");
  const canonical = [s.propertySlug, s.unitTypeSlug, s.ratePlanSlug, s.checkIn, s.checkOut, s.adults, s.children, s.rooms, addons].join("|");
  return `nk-idem:${fnv1a(canonical)}`;
}

/** The key stored for this selection, or a new one (stored when storage works). */
export function idempotencyKeyFor(s: StaySelection, storage: KeyStore | null, generate: () => string): string {
  const slot = selectionSlot(s);
  try {
    const existing = storage?.getItem(slot);
    if (existing) return existing;
  } catch {
    /* storage blocked: fall through to a fresh key */
  }
  const key = generate();
  try {
    storage?.setItem(slot, key);
  } catch {
    /* private mode: the key still works for this page view */
  }
  return key;
}

/** sessionStorage, or null where reading it throws (blocked cookies / storage). */
export function sessionStore(): KeyStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
