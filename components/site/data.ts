import { cache } from "react";
import { getNews, getPage, getProperty, getRoomType, getRoomTypes, listFaqs, listNews } from "@/lib/content-repo";
import { getDb } from "@/lib/db/client";
import type { Locale } from "@/lib/db/schema";

/** Request-scoped loaders for the public pages (React cache dedupes generateMetadata + page). */

export const PROPERTY_SLUG = "nk-hostel";

export const loadProperty = cache(async () => getProperty(await getDb(), PROPERTY_SLUG));
export const loadRooms = cache(async (locale: Locale) => getRoomTypes(await getDb(), PROPERTY_SLUG, locale));
export const loadRoom = cache(async (slug: string, locale: Locale) => getRoomType(await getDb(), PROPERTY_SLUG, slug, locale));
export const loadPage = cache(async (slug: string, locale: Locale) => getPage(await getDb(), PROPERTY_SLUG, slug, locale));
export const loadNewsList = cache(async (locale: Locale) => listNews(await getDb(), PROPERTY_SLUG, locale));
export const loadNews = cache(async (slug: string, locale: Locale) => getNews(await getDb(), PROPERTY_SLUG, slug, locale));
export const loadFaqs = cache(async (locale: Locale) => listFaqs(await getDb(), PROPERTY_SLUG, locale));
