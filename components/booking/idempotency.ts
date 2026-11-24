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

type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** A stored key is reused for at most the inventory hold (HOLD_MINUTES); after that the booking it made has lapsed. */
export const KEY_TTL_MS = 20 * 60_000;

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

function readKey(storage: KeyStore | null, slot: string, now: number): string | null {
  try {
    const raw = storage?.getItem(slot);
    if (!raw) return null;
    const v = JSON.parse(raw) as { key?: unknown; createdAt?: unknown };
    if (typeof v?.key !== "string" || typeof v.createdAt !== "number") return null;
    return now - v.createdAt < KEY_TTL_MS ? v.key : null;
  } catch {
    return null; // storage blocked, or not our record
  }
}

/** The key stored for this selection if it is younger than KEY_TTL_MS, or a new one (stored when storage works). */
export function idempotencyKeyFor(s: StaySelection, storage: KeyStore | null, generate: () => string, now = Date.now()): string {
  const slot = selectionSlot(s);
  const existing = readKey(storage, slot, now);
  if (existing) return existing;
  const key = generate();
  try {
    storage?.setItem(slot, JSON.stringify({ key, createdAt: now }));
  } catch {
    /* private mode: the key still works for this page view */
  }
  return key;
}

/** Forget the key for this selection, so the next idempotencyKeyFor mints a new one. */
export function clearKey(s: StaySelection, storage: KeyStore | null): void {
  try {
    storage?.removeItem(selectionSlot(s));
  } catch {
    /* nothing to clear */
  }
}

type SubmitOutcome = { ok: true } | { ok: false; status: number; error?: string; detail?: string; code?: string };

/**
 * After a failed submit: should the client drop its key and submit again with a fresh one?
 * Only when the key's booking lapsed unpaid (EXPIRED), and only on the first attempt, so it can
 * never loop. A paid booking (ALREADY_PAID) is never retried: see paidBookingReturnPath.
 */
export function retryWithFreshKey(r: SubmitOutcome, attempt: number): boolean {
  return attempt === 0 && !r.ok && r.error === "INVALID_INPUT" && r.detail === "EXPIRED";
}

const CODE_RE = /^[A-Z0-9-]{1,32}$/;

/** The key's booking was already paid: the return page of that booking, or null for any other outcome. */
export function paidBookingReturnPath(r: SubmitOutcome, locale: string): string | null {
  if (r.ok || r.detail !== "ALREADY_PAID" || !r.code || !CODE_RE.test(r.code)) return null;
  return `/${locale}/book/return/${r.code}`;
}

/** sessionStorage, or null where reading it throws (blocked cookies / storage). */
export function sessionStore(): KeyStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
