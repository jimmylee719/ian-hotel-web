import type { MetadataRoute } from "next";
import { getRoomTypes, listNews } from "@/lib/content-repo";
import { getDb } from "@/lib/db/client";
import { sitemapEntries } from "@/lib/sitemap";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const db = await getDb();
  const [rooms, news] = await Promise.all([getRoomTypes(db, "nk-hostel", "en"), listNews(db, "nk-hostel", "en")]);
  return sitemapEntries(
    rooms.map((r) => r.slug),
    news.map((n) => n.slug),
  );
}
