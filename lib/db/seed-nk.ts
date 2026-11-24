import { eq } from "drizzle-orm";
import { properties, ratePlans, unitTypes, type I18n } from "./schema";
import type { Db } from "./types";

/** zh-TW + en from the current site; ja/ko fall back to English until translated (Plan 2). */
const t = (zh: string, en: string): I18n => ({ "zh-TW": zh, en, ja: en, ko: en });

const ROOMS: [slug: string, zh: string, en: string, maxOccupancy: number][] = [
  ["mixed-cube", "男.女混合雙人旅艙", "MIXED CUBE", 2],
  ["female-cube", "女性雙人旅艙", "FEMALE CUBE", 2],
  ["buddy-room", "旅伴四人客房", "BUDDY ROOM", 4],
  ["buddy-room-six", "六人行客房", "BUDDY ROOM FOR SIX", 6],
  ["mini-room", "迷你雙人套房", "MINI ROOM", 2],
  ["classic-room", "經典雙人套房", "CLASSIC ROOM", 2],
  ["deluxe-room", "景緻雙人套房", "DELUXE ROOM", 2],
  ["connecting-room", "行政四人套房（連通房）", "CONNECTING ROOM", 4],
];

export async function seedNk(db: Db): Promise<{ propertyId: string }> {
  const existing = await db.select({ id: properties.id }).from(properties).where(eq(properties.slug, "nk-hostel"));
  if (existing.length) return { propertyId: existing[0].id };

  const propertyId = crypto.randomUUID();
  await db.insert(properties).values({
    id: propertyId,
    slug: "nk-hostel",
    type: "hotel",
    name: t("小公館人文旅舍", "NK Hostel"),
    timezone: "Asia/Taipei",
    currency: "TWD",
    address: t(
      "105 台北市松山區南京東路五段399號5樓",
      "5F, No.399, Sec. 5, Nanjing E. Rd, Songshan Dist., Taipei City 105, Taiwan",
    ),
    phone: "+886 2 2769 0200",
    email: "info@nkhostel.com",
    createdAt: Date.now(),
  });

  await db.insert(unitTypes).values(
    ROOMS.map(([slug, zh, en, occ], i) => ({
      id: crypto.randomUUID(),
      propertyId,
      slug,
      name: t(zh, en),
      description: t("", ""),
      maxAdults: occ,
      maxOccupancy: occ,
      bedType: t("", ""),
      amenities: [],
      sortOrder: i,
    })),
  );

  await db.insert(ratePlans).values({
    id: crypto.randomUUID(),
    propertyId,
    slug: "direct-flex",
    name: t("官網專屬・彈性取消", "Direct Exclusive · Flexible"),
    directOnly: true,
    paymentMode: "full",
    depositPct: 0,
    cancelPolicy: { rules: [{ daysBefore: 3, refundPct: 100 }, { daysBefore: 1, refundPct: 50 }] },
  });

  return { propertyId };
}
