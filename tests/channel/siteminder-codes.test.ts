import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { fillMissingSmCodes, isSmCode, planSmCodes, SM_CODE_MAX, smCodeFromSlug, smCodeUpdatesSql, uniqueSmCode } from "@/lib/channel/siteminder/codes";
import { updateUnitType, type MediaHead } from "@/lib/admin/content";
import { properties, ratePlans, staff, unitTypes } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import { createTestDb } from "@/tests/helpers/test-db";

describe("code format", () => {
  test("slug upper-cased, hyphens dropped, at most 16 characters", () => {
    expect(smCodeFromSlug("mixed-cube")).toBe("MIXEDCUBE");
    expect(smCodeFromSlug("buddy-room-six")).toBe("BUDDYROOMSIX");
    expect(smCodeFromSlug("a-very-long-room-type-slug")).toBe("AVERYLONGROOMTYP");
    expect(smCodeFromSlug("a-very-long-room-type-slug")).toHaveLength(SM_CODE_MAX);
    for (const s of ["nk-hostel", "direct-flex", "x9-y"]) expect(isSmCode(smCodeFromSlug(s))).toBe(true);
    expect(isSmCode("MIXED-CUBE")).toBe(false);
    expect(isSmCode("mixedcube")).toBe(false);
  });

  test("a clash gets the smallest free numeric suffix, inside the length limit", () => {
    expect(uniqueSmCode("mixed-cube", new Set())).toBe("MIXEDCUBE");
    expect(uniqueSmCode("mixedcube", new Set(["MIXEDCUBE"]))).toBe("MIXEDCUBE2");
    expect(uniqueSmCode("mixedcube", new Set(["MIXEDCUBE", "MIXEDCUBE2"]))).toBe("MIXEDCUBE3");
    expect(uniqueSmCode("a-very-long-room-type-slug", new Set(["AVERYLONGROOMTYP"]))).toBe("AVERYLONGROOMTY2");
  });
});

describe("stored codes", () => {
  test("seeding gives NK Hostel, its 8 room types and its rate plan their codes", async () => {
    const db = createTestDb();
    await seedNk(db);
    expect((await db.select().from(properties))[0].smPropertyCode).toBe("NKHOSTEL");
    expect((await db.select().from(unitTypes).orderBy(unitTypes.sortOrder)).map((u) => u.smRoomCode)).toEqual([
      "MIXEDCUBE", "FEMALECUBE", "BUDDYROOM", "BUDDYROOMSIX", "MINIROOM", "CLASSICROOM", "DELUXEROOM", "CONNECTINGROOM",
    ]);
    expect((await db.select().from(ratePlans)).map((p) => p.smRatePlanCode)).toEqual(["DIRECTFLEX"]);
  });

  test("fillMissingSmCodes keeps existing codes and suffixes a clash; codes are unique per property", async () => {
    const db = createTestDb();
    const { propertyId } = await seedNk(db);
    const [room] = await db.select().from(unitTypes).where(eq(unitTypes.slug, "mini-room"));
    await db.update(unitTypes).set({ smRoomCode: "MINI" }).where(eq(unitTypes.id, room.id));
    await db.insert(unitTypes).values({ ...room, id: "twin", slug: "miniroom", smRoomCode: null });
    expect(await fillMissingSmCodes(db)).toBe(1);
    const codes = Object.fromEntries((await db.select().from(unitTypes)).map((u) => [u.slug, u.smRoomCode]));
    expect(codes).toMatchObject({ "mini-room": "MINI", miniroom: "MINIROOM" });
    expect(await fillMissingSmCodes(db)).toBe(0);
    // The unique index refuses a second room type with the same code in the property.
    await expect(db.update(unitTypes).set({ smRoomCode: "MINI" }).where(eq(unitTypes.id, "twin"))).rejects.toThrow(/UNIQUE/);
    expect(propertyId).toBeTruthy();
  });

  test("migration 0024 backfills empty codes with the same rule, skipping clashes (fillMissingSmCodes takes those)", async () => {
    const db = createTestDb();
    await seedNk(db);
    const [room] = await db.select().from(unitTypes).where(eq(unitTypes.slug, "mixed-cube"));
    await db.insert(unitTypes).values({ ...room, id: "clash", slug: "mixedcube", smRoomCode: null });
    await db.update(unitTypes).set({ smRoomCode: null });
    await db.update(unitTypes).set({ smRoomCode: "" }).where(eq(unitTypes.slug, "deluxe-room"));
    await db.update(unitTypes).set({ smRoomCode: "KEEP" }).where(eq(unitTypes.slug, "mini-room"));
    await db.update(ratePlans).set({ smRatePlanCode: null });
    await db.update(properties).set({ smPropertyCode: "" });

    const sql = readFileSync(path.resolve(__dirname, "../../drizzle/migrations/0024_siteminder_codes.sql"), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint").map((x) => x.trim()).filter((x) => x.includes("UPDATE"))) db.$client.exec(stmt);

    const rooms = await db.select().from(unitTypes);
    for (const u of rooms) {
      if (u.slug === "mini-room") expect(u.smRoomCode).toBe("KEEP");
      else if (u.slug === "mixed-cube" || u.slug === "mixedcube") expect(u.smRoomCode).toBeNull();
      else expect(u.smRoomCode).toBe(smCodeFromSlug(u.slug));
    }
    expect((await db.select().from(ratePlans))[0].smRatePlanCode).toBe("DIRECTFLEX");
    expect((await db.select().from(properties))[0].smPropertyCode).toBe("NKHOSTEL");

    await fillMissingSmCodes(db);
    const after = Object.fromEntries((await db.select().from(unitTypes)).map((u) => [u.slug, u.smRoomCode]));
    expect(after).toMatchObject({ "mixed-cube": "MIXEDCUBE", mixedcube: "MIXEDCUBE2" });
  });

  test("admin cannot change a room type's code", async () => {
    const db = createTestDb();
    const { propertyId } = await seedNk(db);
    const [room] = await db.select().from(unitTypes).where(eq(unitTypes.slug, "mixed-cube"));
    const row = { id: "s-marketing", email: "m@nk.test", name: "m", role: "marketing" as const, propertyIds: [propertyId], active: true };
    await db.insert(staff).values(row);
    const media: MediaHead = { head: async () => null };
    expect(await updateUnitType(db, { staff: row, email: row.email }, room.id, { smRoomCode: "HACK" } as never, media)).toEqual({ ok: false, error: "INVALID_INPUT", field: "smRoomCode" });
    expect((await db.select().from(unitTypes).where(eq(unitTypes.id, room.id)))[0].smRoomCode).toBe("MIXEDCUBE");
  });

  test("seedNk on an existing database gives rows without a code their code", async () => {
    const db = createTestDb();
    await seedNk(db);
    const [room] = await db.select().from(unitTypes).where(eq(unitTypes.slug, "mixed-cube"));
    await db.insert(unitTypes).values({ ...room, id: "clash", slug: "mixedcube", smRoomCode: null });
    await seedNk(db);
    expect((await db.select().from(unitTypes).where(eq(unitTypes.id, "clash")))[0].smRoomCode).toBe("MIXEDCUBE2");
    expect((await db.select().from(unitTypes).where(eq(unitTypes.id, room.id)))[0].smRoomCode).toBe("MIXEDCUBE");
  });

  test("planSmCodes and its SQL (scripts/fill-sm-codes.ts) never touch an existing code", () => {
    const plan = planSmCodes({
      properties: [{ id: "p1", slug: "nk-hostel", code: "NKHOSTEL" }, { id: "p2", slug: "nkhostel", code: null }],
      unitTypes: [
        { id: "u1", slug: "mixed-cube", code: null, propertyId: "p1" },
        { id: "u2", slug: "mixedcube", code: "", propertyId: "p1" },
        { id: "u3", slug: "mixed-cube", code: null, propertyId: "p2" },
      ],
      ratePlans: [{ id: "r1", slug: "direct-flex", code: "DIRECTFLEX", propertyId: "p1" }],
    });
    expect(plan).toEqual([
      { table: "properties", id: "p2", code: "NKHOSTEL2" },
      { table: "unit_types", id: "u1", code: "MIXEDCUBE" },
      { table: "unit_types", id: "u2", code: "MIXEDCUBE2" },
      { table: "unit_types", id: "u3", code: "MIXEDCUBE" },
    ]);
    expect(smCodeUpdatesSql(plan.slice(1, 2))).toEqual([
      "UPDATE unit_types SET sm_room_code = 'MIXEDCUBE' WHERE id = 'u1' AND (sm_room_code IS NULL OR sm_room_code = '');",
    ]);
  });
});
