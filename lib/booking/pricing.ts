import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { searchAvailability, type RichOffer } from "@/lib/db/ari-repo";
import { addons as addonsTable, promoCodes, properties } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { parseStay, todayInTaipei, type ISODate } from "@/lib/domain/dates";
import { quote, type AddonLine, type Promo, type Quote } from "@/lib/domain/quote";

const str = (max: number) => z.string().trim().min(1).max(max);

/** What a stay is priced from: shared by the quote API and createReservation. */
export const PriceInput = z.object({
  propertySlug: str(64),
  checkIn: z.string(),
  checkOut: z.string(),
  adults: z.number().int().min(1).max(12),
  children: z.number().int().min(0).max(6),
  rooms: z.number().int().min(1).max(6),
  unitTypeSlug: str(64),
  ratePlanSlug: str(64),
  addons: z.array(z.object({ slug: str(64), qty: z.number().int().min(1).max(20) })).max(20),
  promoCode: z.string().trim().max(32).optional(),
});
export type PriceInput = z.infer<typeof PriceInput>;

export type PriceError = "INVALID_INPUT" | "NOT_AVAILABLE" | "PROMO_INVALID";

export type Priced = {
  propertyId: string;
  nights: ISODate[];
  offer: RichOffer;
  promo?: Promo;
  quote: Quote;
};

export type PriceResult = { ok: true; priced: Priced } | { ok: false; error: PriceError; detail?: string };

const fail = (error: PriceError, detail?: string): PriceResult => ({ ok: false, error, ...(detail ? { detail } : {}) });

/** Promo codes are matched case-insensitively; this is the canonical form. */
export const normalisePromo = (code: string | undefined) => code?.trim().toUpperCase() || undefined;

/**
 * Price a stay from current availability, add-ons and promo code — the ONLY path from a booking
 * request to a Quote. `input` must already be validated with PriceInput.
 */
export async function priceStay(db: Db, input: PriceInput, now: Date): Promise<PriceResult> {
  const stay = parseStay(input.checkIn, input.checkOut);
  if (!stay.ok) return fail("INVALID_INPUT", stay.error);

  const [property] = await db.select({ id: properties.id }).from(properties).where(eq(properties.slug, input.propertySlug));
  if (!property) return fail("INVALID_INPUT", "PROPERTY_NOT_FOUND");

  // Re-price from current availability.
  const search = await searchAvailability(db, {
    propertyId: property.id, checkIn: input.checkIn, checkOut: input.checkOut,
    adults: input.adults, children: input.children, rooms: input.rooms, today: todayInTaipei(now),
  });
  if (!search.ok) return fail("INVALID_INPUT", search.error);
  const offer = search.offers.find((o) => o.unitType.slug === input.unitTypeSlug && o.ratePlan.slug === input.ratePlanSlug);
  if (!offer) return fail("NOT_AVAILABLE");

  // Promo code (usage is counted on confirmation, not here).
  let promo: Promo | undefined;
  const promoCode = normalisePromo(input.promoCode);
  if (promoCode) {
    const [p] = await db.select().from(promoCodes)
      .where(and(eq(promoCodes.propertyId, property.id), eq(sql`upper(${promoCodes.code})`, promoCode)));
    const valid = p && p.active
      && (!p.validFrom || p.validFrom <= input.checkIn)
      && (!p.validTo || input.checkIn <= p.validTo)
      && (p.maxUses == null || p.usedCount < p.maxUses);
    if (!valid) return fail("PROMO_INVALID");
    promo = { code: p.code, kind: p.kind, value: p.value };
  }

  // Add-ons and quote.
  const slugs = input.addons.map((a) => a.slug);
  const addonRows = slugs.length
    ? await db.select().from(addonsTable)
      .where(and(eq(addonsTable.propertyId, property.id), eq(addonsTable.active, true), inArray(addonsTable.slug, slugs)))
    : [];
  const addonLines: AddonLine[] = [];
  for (const a of input.addons) {
    const row = addonRows.find((r) => r.slug === a.slug);
    if (!row) return fail("INVALID_INPUT", `ADDON_NOT_FOUND:${a.slug}`);
    addonLines.push({ addonId: row.id, unit: row.unit, unitPrice: row.price, qty: a.qty });
  }
  const q = quote({
    offer, nights: stay.nights.length, adults: input.adults, rooms: input.rooms, addons: addonLines, promo,
    paymentMode: offer.ratePlan.paymentMode, depositPct: offer.ratePlan.depositPct,
  });
  return { ok: true, priced: { propertyId: property.id, nights: stay.nights, offer, promo, quote: q } };
}
