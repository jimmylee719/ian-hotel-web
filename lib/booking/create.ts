import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { searchAvailability } from "@/lib/db/ari-repo";
import { runAtomic } from "@/lib/db/atomic";
import { holdStatements, isCheckViolation, type HoldItem } from "@/lib/db/inventory-hold";
import {
  addons as addonsTable, guests, LOCALES, payments, promoCodes, properties, reservationRooms, reservations, type Locale,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { parseStay, todayInTaipei } from "@/lib/domain/dates";
import { quote, type AddonLine, type Promo } from "@/lib/domain/quote";
import type { ChargeStart, PaymentGateway } from "@/lib/payments/types";
import { newReservationCode } from "./code";

export const HOLD_MINUTES = 20;

export type CreateInput = {
  propertySlug: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  rooms: number;
  unitTypeSlug: string;
  ratePlanSlug: string;
  addons: { slug: string; qty: number }[];
  promoCode?: string;
  guest: { firstName: string; lastName: string; email: string; phone: string; country: string };
  locale: Locale;
  idempotencyKey: string;
  acceptTerms: true;
};

export type CreateError = "INVALID_INPUT" | "NOT_AVAILABLE" | "PRICE_CHANGED" | "PROMO_INVALID" | "SOLD_OUT";
export type CreateResult =
  | { ok: true; code: string; start: ChargeStart }
  | { ok: false; error: CreateError; detail?: string };

type Deps = { db: Db; gateway: PaymentGateway; baseUrl: string };

const str = (max: number) => z.string().trim().min(1).max(max);

const Input = z.object({
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
  guest: z.object({
    firstName: str(100),
    lastName: str(100),
    email: z.email().max(254),
    phone: str(40),
    country: str(64),
  }),
  locale: z.enum(LOCALES),
  idempotencyKey: z.string().min(8).max(128),
  acceptTerms: z.literal(true),
}).refine((i) => i.rooms <= i.adults, { message: "ROOMS_EXCEED_ADULTS", path: ["rooms"] });

const fail = (error: CreateError, detail?: string): CreateResult => ({ ok: false, error, ...(detail ? { detail } : {}) });

export async function createReservation(deps: Deps, raw: CreateInput, now: Date): Promise<CreateResult> {
  const { db } = deps;

  // 1. Validate.
  const parsed = Input.safeParse({ ...raw, guest: { ...raw?.guest, email: raw?.guest?.email?.trim() } });
  if (!parsed.success) return fail("INVALID_INPUT", parsed.error.issues.map((i) => i.path.join(".") || i.message).join(","));
  const input = parsed.data;
  const stay = parseStay(input.checkIn, input.checkOut);
  if (!stay.ok) return fail("INVALID_INPUT", stay.error);

  // 2. Idempotent replay.
  const replay = await replayExisting(deps, input.idempotencyKey, input.locale);
  if (replay) return replay;

  const [property] = await db.select({ id: properties.id }).from(properties).where(eq(properties.slug, input.propertySlug));
  if (!property) return fail("INVALID_INPUT", "PROPERTY_NOT_FOUND");

  // 3. Re-price from current availability.
  const search = await searchAvailability(db, {
    propertyId: property.id, checkIn: input.checkIn, checkOut: input.checkOut,
    adults: input.adults, rooms: input.rooms, today: todayInTaipei(now),
  });
  if (!search.ok) return fail("INVALID_INPUT", search.error);
  const offer = search.offers.find((o) => o.unitType.slug === input.unitTypeSlug && o.ratePlan.slug === input.ratePlanSlug);
  if (!offer) return replayOr(deps, input.idempotencyKey, input.locale, "NOT_AVAILABLE");

  // 4. Promo code (usage is counted on confirmation, not here).
  let promo: Promo | undefined;
  if (input.promoCode) {
    const [p] = await db.select().from(promoCodes)
      .where(and(eq(promoCodes.propertyId, property.id), eq(promoCodes.code, input.promoCode)));
    const valid = p && p.active
      && (!p.validFrom || p.validFrom <= input.checkIn)
      && (!p.validTo || input.checkIn <= p.validTo)
      && (p.maxUses == null || p.usedCount < p.maxUses);
    if (!valid) return fail("PROMO_INVALID");
    promo = { code: p.code, kind: p.kind, value: p.value };
  }

  // 5. Add-ons and quote.
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

  // 6 + 7. Hold inventory and persist everything in ONE batch, so nobody can see the hold without
  // the reservation (and its idempotency key) or vice versa.
  const hold: HoldItem[] = [{ unitTypeId: offer.unitTypeId, ratePlanId: offer.ratePlanId, nights: stay.nights, rooms: input.rooms }];
  const holdStmts = await holdStatements(db, hold);
  if (!holdStmts) return replayOr(deps, input.idempotencyKey, input.locale, "SOLD_OUT");
  const code = newReservationCode();
  const reservationId = crypto.randomUUID();
  const guestId = crypto.randomUUID();
  const at = now.getTime();
  const email = input.guest.email;
  try {
    await runAtomic(db, [
      ...holdStmts,
      db.insert(guests).values({ id: guestId, propertyId: property.id, ...input.guest, locale: input.locale, createdAt: at }),
      db.insert(reservations).values({
        id: reservationId, propertyId: property.id, code, guestId, status: "pending_payment", channel: "direct",
        checkIn: input.checkIn, checkOut: input.checkOut, adults: input.adults, children: input.children,
        locale: input.locale, quote: q, totalAmount: q.total, promoCode: promo?.code ?? null,
        syncState: "not_required", holdExpiresAt: at + HOLD_MINUTES * 60_000, idempotencyKey: input.idempotencyKey,
        guestEmailLower: email.toLowerCase(), createdAt: at, updatedAt: at,
      }),
      ...Array.from({ length: input.rooms }, () =>
        db.insert(reservationRooms).values({
          id: crypto.randomUUID(), reservationId, unitTypeId: offer.unitTypeId, ratePlanId: offer.ratePlanId,
          nightlyPrices: offer.nightlyPrices,
        })),
      db.insert(payments).values({
        id: crypto.randomUUID(), reservationId, kind: "charge", method: "sinopac_online",
        amount: q.payNow, status: "pending", createdAt: at,
      }),
    ]);
  } catch (e) {
    // Nothing was written. A concurrent twin with the same key may have committed first
    // (unique idempotency_key, or it took the last room): answer with its reservation.
    const winner = await replayExisting(deps, input.idempotencyKey, input.locale);
    if (winner) return winner;
    if (isCheckViolation(e)) return fail("SOLD_OUT");
    throw e;
  }

  // 8. Start the payment.
  const start = await startCharge(deps, code, q.payNow, input.locale);
  return { ok: true, code, start };
}

/** Before reporting a sold-out style error, check whether a same-key twin already succeeded. */
async function replayOr(deps: Deps, idempotencyKey: string, locale: Locale, error: CreateError): Promise<CreateResult> {
  return (await replayExisting(deps, idempotencyKey, locale)) ?? fail(error);
}

async function replayExisting(deps: Deps, idempotencyKey: string, locale: Locale): Promise<CreateResult | null> {
  const { db } = deps;
  const [existing] = await db.select().from(reservations).where(eq(reservations.idempotencyKey, idempotencyKey));
  if (!existing) return null;
  if (existing.status !== "pending_payment") return fail("INVALID_INPUT", "ALREADY_PROCESSED");
  const [charge] = await db.select().from(payments)
    .where(and(eq(payments.reservationId, existing.id), eq(payments.kind, "charge")));
  if (!charge) throw new Error(`Reservation ${existing.code} has no charge row`);
  const start = await startCharge(deps, existing.code, charge.amount, (existing.locale as Locale) ?? locale);
  return { ok: true, code: existing.code, start };
}

function startCharge(deps: Deps, code: string, amount: number, locale: Locale): Promise<ChargeStart> {
  const base = deps.baseUrl.replace(/\/+$/, "");
  return deps.gateway.startCharge({
    reservationCode: code,
    amount,
    locale,
    returnUrl: `${base}/${locale}/book/return/${code}`,
    notifyUrl: `${base}/api/payments/notify`,
    description: `Reservation ${code}`,
  });
}
