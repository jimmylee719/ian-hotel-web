import { and, asc, desc, eq, gt, gte, isNotNull, lte, min } from "drizzle-orm";
import { newsImages, pageImages, roomImages } from "@/lib/content/old-site";
import { contentPages, faqs, inventoryDaily, ariDaily, news, properties, ratePlans, unitTypes, type Locale } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { addDaysIso } from "@/lib/booking-search";
import { todayInTaipei } from "@/lib/domain/dates";

/**
 * Read model for the public website. Every function returns null (or []) when nothing matches;
 * pages turn that into notFound(). Pages, news and FAQs with no publishedAt are unpublished (the admin's
 * "delete") and never shown. Every public route is force-dynamic and nothing here is cached, so an admin
 * edit shows on the next request.
 */

export type Property = typeof properties.$inferSelect;

export type RoomCard = {
  slug: string;
  name: string;
  /** The English name, shown as the secondary line under a CJK name. */
  nameEn: string;
  /** First paragraph of the description. */
  summary: string;
  maxOccupancy: number;
  bedType: string;
  sizeSqm: number | null;
  /** R2 key of the cover photo. */
  image: string | null;
  /** All the room's photos (R2 keys, cover first): the staff-managed list, or the old-site photos while it is empty. */
  photos: string[];
  /** Lowest nightly price with a room left over the next 7 days (today included); null = no data. */
  fromPrice: number | null;
};

export type RoomDetail = RoomCard & {
  description: string;
  amenities: string[];
  images: string[];
  maxAdults: number;
  currency: string;
};

export type Page = { slug: string; title: string; body: string; images: string[] };
export type NewsItem = { slug: string; title: string; body: string; publishedAt: number | null; images: string[] };
export type Faq = { slug: string; question: string; answer: string };

/** Days of ARI (today + 6) that the "from" price looks at. */
export const PRICE_WINDOW_DAYS = 7;

export async function getProperty(db: Db, propertySlug: string): Promise<Property | null> {
  const [p] = await db.select().from(properties).where(eq(properties.slug, propertySlug));
  return p ?? null;
}

async function propertyId(db: Db, propertySlug: string): Promise<string | null> {
  const [p] = await db.select({ id: properties.id }).from(properties).where(eq(properties.slug, propertySlug));
  return p?.id ?? null;
}

/** unitTypeId -> lowest sellable price over [today, today + 6]. */
async function lowestPrices(db: Db, propId: string, now: Date, unitTypeId?: string): Promise<Map<string, number>> {
  const from = todayInTaipei(now);
  const to = addDaysIso(from, PRICE_WINDOW_DAYS - 1);
  const rows = await db
    .select({ unitTypeId: ariDaily.unitTypeId, price: min(ariDaily.price) })
    .from(ariDaily)
    .innerJoin(inventoryDaily, and(eq(inventoryDaily.unitTypeId, ariDaily.unitTypeId), eq(inventoryDaily.date, ariDaily.date)))
    .innerJoin(ratePlans, eq(ratePlans.id, ariDaily.ratePlanId))
    .where(
      and(
        eq(ariDaily.propertyId, propId),
        gte(ariDaily.date, from),
        lte(ariDaily.date, to),
        eq(ariDaily.stopSell, false),
        gt(inventoryDaily.available, 0),
        eq(ratePlans.active, true),
        unitTypeId ? eq(ariDaily.unitTypeId, unitTypeId) : undefined,
      ),
    )
    .groupBy(ariDaily.unitTypeId);
  return new Map(rows.filter((r) => r.price !== null).map((r) => [r.unitTypeId, Number(r.price)]));
}

function firstParagraph(text: string): string {
  return text.split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !s.startsWith("【") && !s.startsWith("- ")) ?? "";
}

/** A room's photos (R2 keys, cover first): the staff-managed list, or the migrated old-site photos while it is empty. */
export function photosOf(u: { slug: string; images: string[] }): string[] {
  return u.images.length ? u.images : roomImages(u.slug);
}

function toCard(u: typeof unitTypes.$inferSelect, locale: Locale, prices: Map<string, number>): RoomCard {
  return {
    slug: u.slug,
    name: u.name[locale],
    nameEn: u.name.en,
    summary: firstParagraph(u.description[locale]),
    maxOccupancy: u.maxOccupancy,
    bedType: u.bedType[locale],
    sizeSqm: u.sizeSqm,
    image: photosOf(u)[0] ?? null,
    photos: photosOf(u),
    fromPrice: prices.get(u.id) ?? null,
  };
}

export async function getRoomTypes(db: Db, propertySlug: string, locale: Locale, now: Date = new Date()): Promise<RoomCard[]> {
  const id = await propertyId(db, propertySlug);
  if (!id) return [];
  const [types, prices] = await Promise.all([
    db.select().from(unitTypes).where(and(eq(unitTypes.propertyId, id), eq(unitTypes.active, true))).orderBy(asc(unitTypes.sortOrder)),
    lowestPrices(db, id, now),
  ]);
  return types.map((u) => toCard(u, locale, prices));
}

export async function getRoomType(db: Db, propertySlug: string, slug: string, locale: Locale, now: Date = new Date()): Promise<RoomDetail | null> {
  const [row] = await db
    .select({ u: unitTypes, currency: properties.currency })
    .from(unitTypes)
    .innerJoin(properties, eq(properties.id, unitTypes.propertyId))
    .where(and(eq(properties.slug, propertySlug), eq(unitTypes.slug, slug), eq(unitTypes.active, true)));
  if (!row) return null;
  const prices = await lowestPrices(db, row.u.propertyId, now, row.u.id);
  return {
    ...toCard(row.u, locale, prices),
    description: row.u.description[locale],
    amenities: row.u.amenities,
    images: photosOf(row.u),
    maxAdults: row.u.maxAdults,
    currency: row.currency,
  };
}

export async function getPage(db: Db, propertySlug: string, slug: string, locale: Locale): Promise<Page | null> {
  const id = await propertyId(db, propertySlug);
  if (!id) return null;
  const [p] = await db
    .select()
    .from(contentPages)
    .where(and(eq(contentPages.propertyId, id), eq(contentPages.slug, slug), isNotNull(contentPages.publishedAt)));
  return p ? { slug, title: p.title[locale], body: p.body[locale], images: pageImages(slug) } : null;
}

export async function listNews(db: Db, propertySlug: string, locale: Locale): Promise<NewsItem[]> {
  const id = await propertyId(db, propertySlug);
  if (!id) return [];
  const rows = await db
    .select()
    .from(news)
    .where(and(eq(news.propertyId, id), isNotNull(news.publishedAt)))
    .orderBy(desc(news.publishedAt), asc(news.sortOrder));
  return rows.map((n) => ({ slug: n.slug, title: n.title[locale], body: n.body[locale], publishedAt: n.publishedAt, images: newsImages(n.slug) }));
}

export async function getNews(db: Db, propertySlug: string, slug: string, locale: Locale): Promise<NewsItem | null> {
  const id = await propertyId(db, propertySlug);
  if (!id) return null;
  const [n] = await db.select().from(news).where(and(eq(news.propertyId, id), eq(news.slug, slug), isNotNull(news.publishedAt)));
  return n ? { slug, title: n.title[locale], body: n.body[locale], publishedAt: n.publishedAt, images: newsImages(slug) } : null;
}

export async function listFaqs(db: Db, propertySlug: string, locale: Locale): Promise<Faq[]> {
  const id = await propertyId(db, propertySlug);
  if (!id) return [];
  const rows = await db
    .select()
    .from(faqs)
    .where(and(eq(faqs.propertyId, id), isNotNull(faqs.publishedAt)))
    .orderBy(asc(faqs.sortOrder));
  return rows.map((f) => ({ slug: f.slug, question: f.title[locale], answer: f.body[locale] }));
}
