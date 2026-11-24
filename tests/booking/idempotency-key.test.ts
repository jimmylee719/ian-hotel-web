import { expect, test } from "vitest";
import { clearKey, idempotencyKeyFor, KEY_TTL_MS, retryWithFreshKey, selectionSlot, type StaySelection } from "@/components/booking/idempotency";

const sel = (over: Partial<StaySelection> = {}): StaySelection => ({
  propertySlug: "nk-hostel", unitTypeSlug: "deluxe-room", ratePlanSlug: "direct-flex",
  checkIn: "2026-12-01", checkOut: "2026-12-03", adults: 2, children: 0, rooms: 1,
  addons: [{ slug: "breakfast", qty: 1 }],
  ...over,
});

test("the same stay selection maps to the same slot; any change maps to another", () => {
  expect(selectionSlot(sel())).toBe(selectionSlot(sel()));
  // Add-on order does not matter.
  const two = [{ slug: "breakfast", qty: 1 }, { slug: "parking", qty: 1 }];
  expect(selectionSlot(sel({ addons: two }))).toBe(selectionSlot(sel({ addons: [...two].reverse() })));
  const changes: Partial<StaySelection>[] = [
    { propertySlug: "other" }, { unitTypeSlug: "mini-room" }, { ratePlanSlug: "nonref" }, { checkIn: "2026-12-02" },
    { checkOut: "2026-12-04" }, { adults: 1 }, { children: 1 }, { rooms: 2 }, { addons: [] }, { addons: [{ slug: "breakfast", qty: 2 }] },
  ];
  for (const c of changes) expect(selectionSlot(sel(c)), JSON.stringify(c)).not.toBe(selectionSlot(sel()));
});

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

test("a key is reused while the selection is unchanged and replaced when it changes", () => {
  const storage = memoryStorage();
  let n = 0;
  const gen = () => `key-${++n}`;
  const a = idempotencyKeyFor(sel(), storage, gen);
  expect(idempotencyKeyFor(sel(), storage, gen)).toBe(a); // back from the pay page: same key
  const b = idempotencyKeyFor(sel({ addons: [] }), storage, gen);
  expect(b).not.toBe(a);
  expect(idempotencyKeyFor(sel(), storage, gen)).toBe(a); // switching back reuses the first
});

test("without usable storage a fresh key is still returned", () => {
  const deny = () => { throw new Error("denied"); };
  const broken = { getItem: deny, setItem: deny, removeItem: deny };
  expect(idempotencyKeyFor(sel(), broken, () => "fresh-key-1")).toBe("fresh-key-1");
  expect(idempotencyKeyFor(sel(), null, () => "fresh-key-2")).toBe("fresh-key-2");
});

test("a key older than the 20-minute hold is replaced", () => {
  const storage = memoryStorage();
  let n = 0;
  const gen = () => `key-${++n}`;
  const t0 = 1_800_000_000_000;
  expect(KEY_TTL_MS).toBe(20 * 60_000);
  const a = idempotencyKeyFor(sel(), storage, gen, t0);
  expect(idempotencyKeyFor(sel(), storage, gen, t0 + KEY_TTL_MS - 1)).toBe(a);
  const b = idempotencyKeyFor(sel(), storage, gen, t0 + KEY_TTL_MS);
  expect(b).not.toBe(a);
  expect(idempotencyKeyFor(sel(), storage, gen, t0 + KEY_TTL_MS + 1000)).toBe(b);
});

test("clearKey forces a new key for that selection only", () => {
  const storage = memoryStorage();
  let n = 0;
  const gen = () => `key-${++n}`;
  const a = idempotencyKeyFor(sel(), storage, gen);
  const other = idempotencyKeyFor(sel({ rooms: 2 }), storage, gen);
  clearKey(sel(), storage);
  const b = idempotencyKeyFor(sel(), storage, gen);
  expect(b).not.toBe(a);
  expect(idempotencyKeyFor(sel({ rooms: 2 }), storage, gen)).toBe(other);
  expect(() => clearKey(sel(), null)).not.toThrow();
});

test("a stored value that is not a {key, createdAt} record is treated as stale", () => {
  const storage = memoryStorage();
  storage.setItem(selectionSlot(sel()), "plain-old-key");
  expect(idempotencyKeyFor(sel(), storage, () => "fresh")).toBe("fresh");
});

test("retry with a fresh key exactly once, and only for ALREADY_PROCESSED", () => {
  const processed = { ok: false as const, status: 400, error: "INVALID_INPUT", detail: "ALREADY_PROCESSED" };
  expect(retryWithFreshKey(processed, 0)).toBe(true);
  expect(retryWithFreshKey(processed, 1)).toBe(false);
  for (const r of [
    { ok: false as const, status: 409, error: "SOLD_OUT" },
    { ok: false as const, status: 409, error: "NOT_AVAILABLE" },
    { ok: false as const, status: 400, error: "INVALID_INPUT", detail: "guest.email" },
    { ok: false as const, status: 400, error: "PROMO_INVALID" },
    { ok: false as const, status: 429 },
    { ok: false as const, status: 0 },
  ]) expect(retryWithFreshKey(r, 0), JSON.stringify(r)).toBe(false);
});
