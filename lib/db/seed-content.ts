import { and, eq } from "drizzle-orm";
import type { OldSiteContent } from "@/lib/content/types";
import { contentPages, faqs, news, unitTypes, type I18n } from "./schema";
import type { Db } from "./types";

type ContentTable = typeof contentPages | typeof news | typeof faqs;
type Row = { slug: string; title: I18n; body: I18n; sortOrder: number; publishedAt?: number | null };

/**
 * Writes migrated site content: room details onto existing unit types (matched by slug), and
 * content pages, news and FAQs (upserted by slug). Safe to run repeatedly; ids and the original
 * publishedAt of existing rows are kept.
 */
export async function seedContent(db: Db, propertyId: string, data: OldSiteContent): Promise<void> {
  for (const r of data.rooms)
    await db
      .update(unitTypes)
      .set({ description: r.description, bedType: r.bedType, amenities: r.amenities, sizeSqm: r.sizeSqm })
      .where(and(eq(unitTypes.propertyId, propertyId), eq(unitTypes.slug, r.slug)));

  const now = Date.now();
  await upsertAll(db, contentPages, propertyId, data.pages, now);
  await upsertAll(db, faqs, propertyId, data.faqs, now);
  await upsertAll(
    db,
    news,
    propertyId,
    data.news.map((n, i) => ({ ...n, sortOrder: i })),
    now,
  );
}

async function upsertAll(db: Db, table: ContentTable, propertyId: string, rows: Row[], now: number) {
  for (const row of rows) {
    const [existing] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.propertyId, propertyId), eq(table.slug, row.slug)));
    const fields = { title: row.title, body: row.body, sortOrder: row.sortOrder };
    if (existing) {
      const publishedAt = row.publishedAt === undefined ? {} : { publishedAt: row.publishedAt };
      await db.update(table).set({ ...fields, ...publishedAt }).where(eq(table.id, existing.id));
    } else {
      await db.insert(table).values({
        id: crypto.randomUUID(),
        propertyId,
        slug: row.slug,
        ...fields,
        publishedAt: row.publishedAt === undefined ? now : row.publishedAt,
      });
    }
  }
}
