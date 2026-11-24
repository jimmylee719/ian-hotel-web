import { describe, expect, test } from "vitest";
import { handleAvailability } from "@/lib/api/availability";
import { seedNk } from "@/lib/db/seed-nk";
import { createTestDb } from "@/tests/helpers/test-db";
import { fillAri } from "@/tests/helpers/ari";

async function setup() {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  await fillAri(db, propertyId, "2026-12-01", 3);
  return db;
}
const url = (qs: string) => new URL(`http://x/api/availability?${qs}`);

describe("GET /api/availability", () => {
  test("checkout equal to checkin is a 400", async () => {
    const res = await handleAvailability(await setup(), url("property=nk-hostel&checkIn=2026-12-01&checkOut=2026-12-01&adults=2"), "2026-11-24");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "CHECKOUT_NOT_AFTER_CHECKIN" });
  });
  test("unknown property is a 404", async () => {
    const res = await handleAvailability(await setup(), url("property=nope&checkIn=2026-12-01&checkOut=2026-12-02&adults=2"), "2026-11-24");
    expect(res.status).toBe(404);
  });
  test("adults outside 1–12 is a 400", async () => {
    const res = await handleAvailability(await setup(), url("property=nk-hostel&checkIn=2026-12-01&checkOut=2026-12-02&adults=0"), "2026-11-24");
    expect(res.status).toBe(400);
  });
  test("a valid search returns uncached offers", async () => {
    const res = await handleAvailability(await setup(), url("property=nk-hostel&checkIn=2026-12-01&checkOut=2026-12-02&adults=2"), "2026-11-24");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { offers: { unitType: { slug: string }; ratePlan: { slug: string }; roomSubtotal: number }[] };
    expect(body.offers.length).toBeGreaterThan(0);
    expect(body.offers[0]).toMatchObject({ unitType: { slug: "mixed-cube" }, ratePlan: { slug: "direct-flex" }, roomSubtotal: 2000 });
  });
});

describe("children and occupancy", () => {
  const slugs = async (qs: string) => {
    const res = await handleAvailability(await setup(), url(`property=nk-hostel&checkIn=2026-12-01&checkOut=2026-12-02&${qs}`), "2026-11-24");
    expect(res.status).toBe(200);
    return new Set(((await res.json()) as { offers: { unitType: { slug: string } }[] }).offers.map((o) => o.unitType.slug));
  };

  test("children default to 0", async () => {
    expect((await slugs("adults=2")).has("mixed-cube")).toBe(true);
  });

  test("adults + children per room must fit the room's max occupancy", async () => {
    const s = await slugs("adults=2&children=1");
    expect(s.has("mixed-cube")).toBe(false); // sleeps 2
    expect(s.has("buddy-room")).toBe(true); // sleeps 4
    expect((await slugs("adults=2&children=2&rooms=2")).has("mixed-cube")).toBe(true);
  });

  test("a negative children count is a 400", async () => {
    const res = await handleAvailability(await setup(), url("property=nk-hostel&checkIn=2026-12-01&checkOut=2026-12-02&adults=2&children=-1"), "2026-11-24");
    expect(res.status).toBe(400);
  });
});
