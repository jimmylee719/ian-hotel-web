import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import type { StaffContext } from "@/lib/admin/auth";
import {
  createFaq, createNews, deleteFaq, deleteNews, deletePage, updateFaq, updateNews, updatePage, updateUnitType, type MediaHead,
} from "@/lib/admin/content";
import { getNews, getPage, getRoomType, getRoomTypes, listFaqs, listNews } from "@/lib/content-repo";
import { auditLog, contentPages, faqs, news, properties, staff, unitTypes, type I18n } from "@/lib/db/schema";
import { seedContent } from "@/lib/db/seed-content";
import { seedNk } from "@/lib/db/seed-nk";
import { oldSiteContent, roomImages } from "@/lib/content/old-site";
import { createTestDb } from "../helpers/test-db";

const NOW = new Date("2026-12-01T03:00:00Z");
const t = (s: string): I18n => ({ "zh-TW": `${s}-zh`, en: `${s}-en`, ja: `${s}-ja`, ko: `${s}-ko` });

/** A fake R2 bucket: `head` finds only the keys it was given. */
const bucket = (...keys: string[]): MediaHead & { heads: string[] } => {
  const heads: string[] = [];
  return { heads, head: async (k: string) => (heads.push(k), keys.includes(k) ? { key: k } : null) };
};

async function setup() {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  await seedContent(db, propertyId, oldSiteContent());
  const other = "other-property";
  await db.insert(properties).values({
    id: other, slug: "other", type: "hotel", name: t("o"), timezone: "Asia/Taipei", currency: "TWD", address: t("a"),
    phone: "1", email: "o@x.test", createdAt: 0,
  });
  const mk = async (role: "marketing" | "front_desk" | "owner", propertyIds = [propertyId]): Promise<StaffContext> => {
    const row = { id: `s-${role}-${propertyIds.join()}`, email: `${role}-${propertyIds.join()}@nk.test`, name: role, role, propertyIds, active: true };
    await db.insert(staff).values(row);
    return { staff: row, email: row.email };
  };
  const [deluxe] = await db.select().from(unitTypes).where(and(eq(unitTypes.propertyId, propertyId), eq(unitTypes.slug, "deluxe-room")));
  const audits = (entityId: string) => db.select().from(auditLog).where(eq(auditLog.entityId, entityId));
  return { db, propertyId, deluxe, audits, marketing: await mk("marketing"), frontDesk: await mk("front_desk"), outsider: await mk("owner", [other]) };
}

describe("updateUnitType", () => {
  test("an empty (or blank) ja value is rejected and nothing changes", async () => {
    const { db, deluxe, marketing, audits } = await setup();
    for (const ja of ["", "   "]) {
      const r = await updateUnitType(db, marketing, deluxe.id, { name: { ...deluxe.name, ja } }, bucket(), NOW);
      expect(r).toEqual({ ok: false, error: "I18N_INCOMPLETE", field: "name" });
    }
    const missing = { "zh-TW": "x", en: "x", ko: "x" } as unknown as I18n;
    expect(await updateUnitType(db, marketing, deluxe.id, { description: missing }, bucket(), NOW))
      .toEqual({ ok: false, error: "I18N_INCOMPLETE", field: "description" });
    const [after] = await db.select().from(unitTypes).where(eq(unitTypes.id, deluxe.id));
    expect(after.name).toEqual(deluxe.name);
    expect(await audits(deluxe.id)).toHaveLength(0);
  });

  test("a valid update writes the fields and an audit row with the before and after of what changed", async () => {
    const { db, deluxe, marketing, audits } = await setup();
    const name = { ...deluxe.name, ja: "デラックス（改）" };
    const r = await updateUnitType(db, marketing, deluxe.id, { name, sizeSqm: 31, amenities: ["wifi"] }, bucket(), NOW);
    expect(r).toEqual({ ok: true });
    const [after] = await db.select().from(unitTypes).where(eq(unitTypes.id, deluxe.id));
    expect(after).toMatchObject({ name, sizeSqm: 31, amenities: ["wifi"], description: deluxe.description });
    const logs = await audits(deluxe.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      staffEmail: marketing.email, action: "unit_type.update", entity: "unit_type", at: NOW.getTime(),
      before: { name: deluxe.name, sizeSqm: deluxe.sizeSqm, amenities: deluxe.amenities },
      after: { name, sizeSqm: 31, amenities: ["wifi"] },
    });
  });

  test("every image key must already exist in R2", async () => {
    const { db, deluxe, marketing, audits } = await setup();
    const media = bucket("rooms/deluxe-room/a.webp");
    expect(await updateUnitType(db, marketing, deluxe.id, { images: ["rooms/deluxe-room/a.webp", "rooms/deluxe-room/missing.jpg"] }, media, NOW))
      .toEqual({ ok: false, error: "IMAGE_NOT_FOUND", key: "rooms/deluxe-room/missing.jpg" });
    expect(await updateUnitType(db, marketing, deluxe.id, { images: ["../etc/passwd"] }, media, NOW))
      .toEqual({ ok: false, error: "INVALID_INPUT", field: "images" });
    expect(await updateUnitType(db, marketing, deluxe.id, { images: ["rooms/deluxe-room/a.webp", "rooms/deluxe-room/a.webp"] }, media, NOW))
      .toEqual({ ok: false, error: "INVALID_INPUT", field: "images" });
    expect(await audits(deluxe.id)).toHaveLength(0);

    expect(await updateUnitType(db, marketing, deluxe.id, { images: ["rooms/deluxe-room/a.webp"] }, media, NOW)).toEqual({ ok: true });
    const [after] = await db.select().from(unitTypes).where(eq(unitTypes.id, deluxe.id));
    expect(after.images).toEqual(["rooms/deluxe-room/a.webp"]);
  });

  test("numbers must be sane: occupancy at least the adults, size positive or null", async () => {
    const { db, deluxe, marketing } = await setup();
    expect(await updateUnitType(db, marketing, deluxe.id, { maxAdults: 3, maxOccupancy: 2 }, bucket(), NOW))
      .toEqual({ ok: false, error: "INVALID_INPUT", field: "maxOccupancy" });
    expect(await updateUnitType(db, marketing, deluxe.id, { maxAdults: 0 }, bucket(), NOW))
      .toEqual({ ok: false, error: "INVALID_INPUT", field: "maxAdults" });
    expect(await updateUnitType(db, marketing, deluxe.id, { sizeSqm: -1 }, bucket(), NOW))
      .toEqual({ ok: false, error: "INVALID_INPUT", field: "sizeSqm" });
    expect(await updateUnitType(db, marketing, deluxe.id, { sizeSqm: null }, bucket(), NOW)).toEqual({ ok: true });
  });

  test("needs content.edit at the room's property", async () => {
    const { db, deluxe, frontDesk, outsider } = await setup();
    expect(await updateUnitType(db, frontDesk, deluxe.id, { sortOrder: 1 }, bucket(), NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(await updateUnitType(db, outsider, deluxe.id, { sortOrder: 1 }, bucket(), NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(await updateUnitType(db, outsider, "nope", { sortOrder: 1 }, bucket(), NOW)).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  test("the public room page shows the edit at once: new name, new photos first", async () => {
    const { db, deluxe, marketing } = await setup();
    await updateUnitType(db, marketing, deluxe.id, { name: { ...deluxe.name, ja: "新しい名前" }, images: ["rooms/deluxe-room/new.png"] },
      bucket("rooms/deluxe-room/new.png"), NOW);
    const room = await getRoomType(db, "nk-hostel", "deluxe-room", "ja", NOW);
    expect(room?.name).toBe("新しい名前");
    expect(room?.images).toEqual(["rooms/deluxe-room/new.png"]);
    expect(room?.image).toBe("rooms/deluxe-room/new.png");
  });
});

describe("content-repo photos", () => {
  test("unitTypes.images comes first; an empty list falls back to the migrated old-site photos", async () => {
    const { db, deluxe } = await setup();
    await db.update(unitTypes).set({ images: [] }).where(eq(unitTypes.id, deluxe.id));
    expect((await getRoomType(db, "nk-hostel", "deluxe-room", "en", NOW))?.images).toEqual(roomImages("deluxe-room"));
    await db.update(unitTypes).set({ images: ["rooms/x.webp", "rooms/y.webp"] }).where(eq(unitTypes.id, deluxe.id));
    expect((await getRoomType(db, "nk-hostel", "deluxe-room", "en", NOW))?.images).toEqual(["rooms/x.webp", "rooms/y.webp"]);
    expect((await getRoomTypes(db, "nk-hostel", "en", NOW)).find((r) => r.slug === "deluxe-room")?.image).toBe("rooms/x.webp");
  });
});

describe("news", () => {
  test("create, update and delete (= unpublish, the row stays), each audited; only published news is public", async () => {
    const { db, propertyId, marketing, audits } = await setup();
    const created = await createNews(db, marketing, propertyId, { slug: "winter-2026", title: t("w"), body: t("wb"), publishedAt: NOW.getTime() }, NOW);
    expect(created).toEqual({ ok: true, id: expect.any(String) });
    if (!created.ok) return;
    expect((await getNews(db, "nk-hostel", "winter-2026", "ja"))?.title).toBe("w-ja");

    expect(await updateNews(db, marketing, created.id, { title: { ...t("w"), ko: "" } }, NOW)).toEqual({ ok: false, error: "I18N_INCOMPLETE", field: "title" });
    expect(await updateNews(db, marketing, created.id, { title: t("w2") }, NOW)).toEqual({ ok: true });
    expect((await getNews(db, "nk-hostel", "winter-2026", "en"))?.title).toBe("w2-en");

    expect(await deleteNews(db, marketing, created.id, NOW)).toEqual({ ok: true });
    const [row] = await db.select().from(news).where(eq(news.id, created.id));
    expect(row).toMatchObject({ slug: "winter-2026", publishedAt: null });
    expect(await getNews(db, "nk-hostel", "winter-2026", "en")).toBeNull();
    expect((await listNews(db, "nk-hostel", "en")).map((n) => n.slug)).not.toContain("winter-2026");

    const logs = await audits(created.id);
    expect(logs.map((l) => l.action).sort()).toEqual(["news.create", "news.delete", "news.update"]);
    expect(logs.find((l) => l.action === "news.delete")).toMatchObject({ before: { publishedAt: NOW.getTime() }, after: { publishedAt: null } });
  });

  test("slugs are unique per property and well-formed", async () => {
    const { db, propertyId, marketing } = await setup();
    const [existing] = await db.select().from(news).where(eq(news.propertyId, propertyId));
    expect(await createNews(db, marketing, propertyId, { slug: existing.slug, title: t("a"), body: t("b"), publishedAt: null }, NOW))
      .toEqual({ ok: false, error: "SLUG_TAKEN" });
    expect(await createNews(db, marketing, propertyId, { slug: "Bad Slug!", title: t("a"), body: t("b"), publishedAt: null }, NOW))
      .toEqual({ ok: false, error: "INVALID_INPUT", field: "slug" });
  });

  test("needs content.edit at the property", async () => {
    const { db, propertyId, frontDesk, outsider } = await setup();
    const input = { slug: "x", title: t("a"), body: t("b"), publishedAt: null };
    expect(await createNews(db, frontDesk, propertyId, input, NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(await createNews(db, outsider, propertyId, input, NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
    const [existing] = await db.select().from(news).where(eq(news.propertyId, propertyId));
    expect(await deleteNews(db, outsider, existing.id, NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
  });
});

describe("faqs and pages", () => {
  test("a FAQ edit shows publicly; delete unpublishes it", async () => {
    const { db, propertyId, marketing } = await setup();
    const [faq] = await db.select().from(faqs).where(eq(faqs.propertyId, propertyId));
    expect(await updateFaq(db, marketing, faq.id, { title: t("q"), body: t("a") }, NOW)).toEqual({ ok: true });
    expect((await listFaqs(db, "nk-hostel", "ko")).find((f) => f.slug === faq.slug)?.question).toBe("q-ko");
    expect(await deleteFaq(db, marketing, faq.id, NOW)).toEqual({ ok: true });
    expect((await listFaqs(db, "nk-hostel", "ko")).map((f) => f.slug)).not.toContain(faq.slug);
    expect(await db.select().from(faqs).where(eq(faqs.id, faq.id))).toHaveLength(1);
    const created = await createFaq(db, marketing, propertyId, { slug: "new-q", title: t("n"), body: t("nb"), publishedAt: NOW.getTime() }, NOW);
    expect(created.ok).toBe(true);
  });

  test("a page edit shows publicly; delete unpublishes it", async () => {
    const { db, propertyId, marketing, audits } = await setup();
    const [page] = await db.select().from(contentPages).where(and(eq(contentPages.propertyId, propertyId), eq(contentPages.slug, "facilities")));
    expect(await updatePage(db, marketing, page.id, { title: t("fac") }, NOW)).toEqual({ ok: true });
    expect((await getPage(db, "nk-hostel", "facilities", "ja"))?.title).toBe("fac-ja");
    expect(await deletePage(db, marketing, page.id, NOW)).toEqual({ ok: true });
    expect(await getPage(db, "nk-hostel", "facilities", "ja")).toBeNull();
    expect(await updatePage(db, marketing, page.id, { publishedAt: NOW.getTime() }, NOW)).toEqual({ ok: true });
    expect((await getPage(db, "nk-hostel", "facilities", "ja"))?.title).toBe("fac-ja");
    expect((await audits(page.id)).map((l) => l.action)).toEqual(["page.update", "page.delete", "page.update"]);
  });
});
