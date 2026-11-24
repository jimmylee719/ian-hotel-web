import { eq } from "drizzle-orm";
import { properties, ratePlans, unitTypes, type I18n } from "./schema";
import type { Db } from "./types";

/** zh-TW + en from the current site; ja/ko are machine translations (messages/_review.md). */
const t = (zh: string, en: string, ja = en, ko = en): I18n => ({ "zh-TW": zh, en, ja, ko });

const ROOMS: [slug: string, name: I18n, maxOccupancy: number][] = [
  ["mixed-cube", t("男.女混合雙人旅艙", "MIXED CUBE", "男女共用ダブルカプセル", "남녀 공용 2인 캡슐"), 2],
  ["female-cube", t("女性雙人旅艙", "FEMALE CUBE", "女性専用ダブルカプセル", "여성 전용 2인 캡슐"), 2],
  ["buddy-room", t("旅伴四人客房", "BUDDY ROOM", "バディルーム（4名）", "버디 룸 (4인)"), 4],
  ["buddy-room-six", t("六人行客房", "BUDDY ROOM FOR SIX", "バディルーム（6名）", "버디 룸 (6인)"), 6],
  ["mini-room", t("迷你雙人套房", "MINI ROOM", "ミニダブルルーム", "미니 더블룸"), 2],
  ["classic-room", t("經典雙人套房", "CLASSIC ROOM", "クラシックダブルルーム", "클래식 더블룸"), 2],
  ["deluxe-room", t("景緻雙人套房", "DELUXE ROOM", "デラックスダブルルーム", "디럭스 더블룸"), 2],
  ["connecting-room", t("行政四人套房（連通房）", "CONNECTING ROOM", "コネクティングルーム（4名）", "커넥팅 룸 (4인)"), 4],
];

export async function seedNk(db: Db): Promise<{ propertyId: string }> {
  const existing = await db.select({ id: properties.id }).from(properties).where(eq(properties.slug, "nk-hostel"));
  if (existing.length) return { propertyId: existing[0].id };

  const propertyId = crypto.randomUUID();
  await db.insert(properties).values({
    id: propertyId,
    slug: "nk-hostel",
    type: "hotel",
    name: t("小公館人文旅舍", "NK Hostel"), // brand: identical in ja/ko on purpose
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
    ROOMS.map(([slug, name, occ], i) => ({
      id: crypto.randomUUID(),
      propertyId,
      slug,
      name,
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
    name: t("官網專屬・彈性取消", "Direct Exclusive · Flexible", "公式サイト限定・フレキシブルプラン", "공식 홈페이지 전용 · 유연한 취소"),
    directOnly: true,
    paymentMode: "full",
    depositPct: 0,
    cancelPolicy: { rules: [{ daysBefore: 3, refundPct: 100 }, { daysBefore: 1, refundPct: 50 }] },
  });

  return { propertyId };
}
