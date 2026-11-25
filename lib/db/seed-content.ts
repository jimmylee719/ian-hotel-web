import { and, eq } from "drizzle-orm";
import type { OldSiteContent } from "@/lib/content/types";
import { contentPages, faqs, LOCALES, news, unitTypes, type I18n } from "./schema";
import type { Db } from "./types";

type ContentTable = typeof contentPages | typeof news | typeof faqs;
type Row = { slug: string; title: I18n; body: I18n; sortOrder: number; publishedAt?: number | null };

const blank = (v: I18n) => LOCALES.every((l) => !v[l]?.trim());

/**
 * Writes migrated site content, adding only what is missing so staff edits made in the admin are never
 * overwritten: room details and photos fill only the fields of an existing unit type (matched by slug) that
 * are still blank, and content pages, news and FAQs are inserted only when no row has that slug at the
 * property. Safe to run repeatedly.
 */
export async function seedContent(db: Db, propertyId: string, data: OldSiteContent): Promise<void> {
  for (const r of data.rooms) {
    const where = and(eq(unitTypes.propertyId, propertyId), eq(unitTypes.slug, r.slug));
    const [u] = await db.select().from(unitTypes).where(where);
    if (!u) continue;
    const fill = {
      ...(blank(u.description) ? { description: r.description } : {}),
      ...(blank(u.bedType) ? { bedType: r.bedType } : {}),
      ...(u.amenities.length === 0 ? { amenities: r.amenities } : {}),
      ...(u.sizeSqm === null ? { sizeSqm: r.sizeSqm } : {}),
      ...(u.images.length === 0 ? { images: r.images } : {}),
    };
    if (Object.keys(fill).length) await db.update(unitTypes).set(fill).where(where);
  }

  const now = Date.now();
  await insertMissing(db, contentPages, propertyId, data.pages, now);
  await insertMissing(db, faqs, propertyId, data.faqs, now);
  await insertMissing(
    db,
    news,
    propertyId,
    data.news.map((n, i) => ({ ...n, sortOrder: i })),
    now,
  );
}

async function insertMissing(db: Db, table: ContentTable, propertyId: string, rows: Row[], now: number) {
  for (const row of rows) {
    const [existing] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.propertyId, propertyId), eq(table.slug, row.slug)));
    if (existing) continue;
    await db.insert(table).values({
      id: crypto.randomUUID(),
      propertyId,
      slug: row.slug,
      title: row.title,
      body: row.body,
      sortOrder: row.sortOrder,
      publishedAt: row.publishedAt === undefined ? now : row.publishedAt,
    });
  }
}
