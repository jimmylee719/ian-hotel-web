import { expect, test } from "vitest";
import { idempotencyKeyFor, selectionSlot, type StaySelection } from "@/components/booking/idempotency";

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

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
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
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  expect(idempotencyKeyFor(sel(), broken, () => "fresh-key-1")).toBe("fresh-key-1");
  expect(idempotencyKeyFor(sel(), null, () => "fresh-key-2")).toBe("fresh-key-2");
});
