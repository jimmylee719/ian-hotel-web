import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { runAtomic } from "@/lib/db/atomic";
import { holdStatements, isCheckViolation, type HoldItem } from "@/lib/db/inventory-hold";
import { guests, LOCALES, payments, reservationRooms, reservations, type Locale } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { parseStay } from "@/lib/domain/dates";
import type { ChargeStart, PaymentGateway } from "@/lib/payments/types";
import { newReservationCode } from "./code";
import { PriceInput, priceStay } from "./pricing";

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
  | { ok: false; error: CreateError; detail?: string; code?: string };

type Deps = { db: Db; gateway: PaymentGateway; baseUrl: string };

const Input = PriceInput.extend({
  guest: z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: z.email().max(254),
    phone: z.string().trim().min(1).max(40),
    country: z.string().trim().min(1).max(64),
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
  const replay = await replayExisting(deps, input.idempotencyKey, input.locale, now);
  if (replay) return replay;

  // 3–5. Re-price from current availability, promo code and add-ons (shared with the quote API).
  const price = await priceStay(db, input, now);
  if (!price.ok) return price.error === "NOT_AVAILABLE" ? replayOr(deps, input.idempotencyKey, input.locale, now, "NOT_AVAILABLE") : price;
  const { propertyId, nights, offer, promo, quote: q } = price.priced;

  // 6 + 7. Hold inventory and persist everything in ONE batch, so nobody can see the hold without
  // the reservation (and its idempotency key) or vice versa.
  const hold: HoldItem[] = [{ unitTypeId: offer.unitTypeId, ratePlanId: offer.ratePlanId, nights, rooms: input.rooms }];
  const holdStmts = await holdStatements(db, hold);
  if (!holdStmts) return replayOr(deps, input.idempotencyKey, input.locale, now, "SOLD_OUT");
  const code = newReservationCode();
  const reservationId = crypto.randomUUID();
  const guestId = crypto.randomUUID();
  const at = now.getTime();
  const email = input.guest.email;
  try {
    await runAtomic(db, [
      ...holdStmts,
      db.insert(guests).values({ id: guestId, propertyId, ...input.guest, locale: input.locale, createdAt: at }),
      db.insert(reservations).values({
        id: reservationId, propertyId, code, guestId, status: "pending_payment", channel: "direct",
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
    const winner = await replayExisting(deps, input.idempotencyKey, input.locale, now);
    if (winner) return winner;
    if (isCheckViolation(e)) return fail("SOLD_OUT");
    throw e;
  }

  // 8. Start the payment.
  const start = await startCharge(deps, code, q.payNow, input.locale, now);
  return { ok: true, code, start };
}

/** Before reporting a sold-out style error, check whether a same-key twin already succeeded. */
async function replayOr(deps: Deps, idempotencyKey: string, locale: Locale, now: Date, error: CreateError): Promise<CreateResult> {
  return (await replayExisting(deps, idempotencyKey, locale, now)) ?? fail(error);
}

async function replayExisting(deps: Deps, idempotencyKey: string, locale: Locale, now: Date): Promise<CreateResult | null> {
  const { db } = deps;
  const [existing] = await db.select().from(reservations).where(eq(reservations.idempotencyKey, idempotencyKey));
  if (!existing) return null;
  const charges = await db.select().from(payments)
    .where(and(eq(payments.reservationId, existing.id), eq(payments.kind, "charge")));
  if (existing.status !== "pending_payment") {
    // EXPIRED: the hold lapsed unpaid, so the client may start over with a fresh key. Anything else
    // was paid (pending confirmation, confirmed, refunded or cancelled): send the guest to that
    // booking instead of letting a second submit create (and charge) another one.
    const paid = existing.status !== "expired" || charges.some((c) => c.status === "succeeded");
    return paid
      ? { ok: false, error: "INVALID_INPUT", detail: "ALREADY_PAID", code: existing.code }
      : fail("INVALID_INPUT", "EXPIRED");
  }
  const [charge] = charges;
  if (!charge) throw new Error(`Reservation ${existing.code} has no charge row`);
  const start = await startCharge(deps, existing.code, charge.amount, (existing.locale as Locale) ?? locale, now);
  return { ok: true, code: existing.code, start };
}

/**
 * Start (or restart) the payment. The start time is recorded first, so a payment failure from an
 * earlier attempt is not mistaken for this attempt's result (see the status API's paymentState).
 */
async function startCharge(deps: Deps, code: string, amount: number, locale: Locale, now: Date): Promise<ChargeStart> {
  await deps.db.update(reservations).set({ lastChargeStartedAt: now.getTime() }).where(eq(reservations.code, code));
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
