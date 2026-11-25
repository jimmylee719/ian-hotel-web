import { describe, expect, test } from "vitest";
import { AUDIT_PROPERTY_ENTITIES, auditDiff, listAudit } from "@/lib/admin/audit-view";
import { addons, auditLog, properties, type I18n } from "@/lib/db/schema";
import { bookingSetup, NOW } from "../helpers/booking";

const t = (s: string): I18n => ({ "zh-TW": s, en: s, ja: s, ko: s });
const H = 3_600_000;

async function setup() {
  const s = await bookingSetup();
  const { db, propertyId } = s;
  const other = "other-property";
  await db.insert(properties).values({
    id: other, slug: "other", type: "hotel", name: t("o"), timezone: "Asia/Taipei", currency: "TWD", address: t("a"),
    phone: "1", email: "o@x.test", createdAt: 0,
  });
  await db.insert(addons).values([
    { id: "addon-here", propertyId, slug: "a", name: t("a"), price: 1, unit: "per_stay" },
    { id: "addon-there", propertyId: other, slug: "b", name: t("b"), price: 1, unit: "per_stay" },
  ]);
  const code = await s.book();
  const res = await s.reservation(code);
  let n = 0;
  const log = (entity: string, entityId: string, over: Partial<typeof auditLog.$inferInsert> = {}) =>
    db.insert(auditLog).values({
      id: `a${++n}`, staffEmail: "owner@nk.test", action: `${entity}.update`, entity, entityId,
      before: { x: 1 }, after: { x: 2 }, at: NOW.getTime() + n * H, ...over,
    });
  await log("reservation", res.id);
  await log("addon", "addon-here");
  await log("addon", "addon-there");
  await log("property", other);
  await log("staff", "some-staff");
  await log("mystery", "?");
  await log("property", propertyId, { staffEmail: "manager@nk.test", action: "property.update" });
  await log("media", "rooms/mixed-cube/1.png", { action: "media.upload", after: { propertyId } });
  return { ...s, other, res };
}

const ids = (p: { rows: { id: string }[] }) => p.rows.map((r) => r.id);

describe("listAudit", () => {
  test("a non-owner sees only rows tied to their properties, newest first", async () => {
    const { db, propertyId } = await setup();
    const p = await listAudit(db, [propertyId], { page: 1 });
    expect(ids(p)).toEqual(["a7", "a2", "a1"]); // not a8: uploads are owner-only
    expect(p.rows[0].propertyId).toBe(propertyId);
  });

  test("an owner also sees staff rows and rows tied to no property, but still not other properties", async () => {
    const { db, propertyId } = await setup();
    expect(ids(await listAudit(db, [propertyId], { page: 1, includeUnscoped: true }))).toEqual(["a8", "a7", "a6", "a5", "a2", "a1"]);
  });

  test("the other property's viewer sees its own rows only", async () => {
    const { db, other } = await setup();
    expect(ids(await listAudit(db, [other], { page: 1 }))).toEqual(["a4", "a3"]);
  });

  test("filters by staff email, entity, free text and Taipei date range", async () => {
    const { db, propertyId, res } = await setup();
    expect(ids(await listAudit(db, [propertyId], { page: 1, staffEmail: "MANAGER@nk.test" }))).toEqual(["a7"]);
    expect(ids(await listAudit(db, [propertyId], { page: 1, entity: "addon" }))).toEqual(["a2"]);
    expect(ids(await listAudit(db, [propertyId], { page: 1, q: res.id.slice(0, 8) }))).toEqual(["a1"]);
    // NOW is 2026-11-24 10:00 Taipei; a1 is 11:00, a7 is 17:00 the same day.
    expect(ids(await listAudit(db, [propertyId], { page: 1, from: "2026-11-25" }))).toEqual([]);
    expect(ids(await listAudit(db, [propertyId], { page: 1, from: "2026-11-24", to: "2026-11-24" }))).toEqual(["a7", "a2", "a1"]);
    // A date that does not exist is ignored rather than throwing.
    expect(ids(await listAudit(db, [propertyId], { page: 1, from: "2026-02-31", to: "2026-13-01" }))).toEqual(["a7", "a2", "a1"]);
  });

  test("paginates", async () => {
    const { db, propertyId } = await setup();
    const p = await listAudit(db, [propertyId], { page: 2, pageSize: 2 });
    expect(p).toMatchObject({ total: 3, page: 2, pageCount: 2 });
    expect(ids(p)).toEqual(["a1"]);
  });

  test("an empty scope sees nothing", async () => {
    const { db } = await setup();
    expect((await listAudit(db, [], { page: 1 })).total).toBe(0);
  });

  test("every entity the admin writes is either property-scoped or deliberately owner-only", () => {
    expect([...AUDIT_PROPERTY_ENTITIES].sort()).toEqual(
      ["addon", "faq", "news", "notification", "page", "payment", "promo_code", "property", "rate_plan", "reservation", "reservation_note", "unit_type"],
    );
  });
});

describe("auditDiff", () => {
  test("lines up before and after by key and marks what changed", () => {
    expect(auditDiff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, d: "x" })).toEqual([
      { key: "a", before: "1", after: "1", changed: false },
      { key: "b", before: '{"c":2}', after: '{"c":3}', changed: true },
      { key: "d", before: "", after: '"x"', changed: true },
    ]);
    expect(auditDiff(null, { a: 1 })).toEqual([{ key: "a", before: "", after: "1", changed: true }]);
    expect(auditDiff(null, "plain")).toEqual([{ key: "", before: "", after: '"plain"', changed: true }]);
  });
});
