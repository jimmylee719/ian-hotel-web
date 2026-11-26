import { eq, inArray } from "drizzle-orm";
import { smCodeFromSlug } from "@/lib/channel/siteminder/codes";
import type { ChannelReservation } from "@/lib/channel/types";
import { addons, guests, properties, ratePlans, reservationRooms, reservations, unitTypes } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Quote } from "@/lib/domain/quote";
import { receivedAmount } from "./notify";

/** Add-on, room type and rate plan names go to the PMS in Chinese, the front desk's language. */
const PMS_LOCALE = "zh-TW";

/**
 * The reservation as SiteMinder receives it. Add-ons, the promo code, the discount and the amount already paid
 * are included so the PMS sees them (spec 5.8). Missing channel codes are sent as "".
 * Only data the booking holds: no children's ages, no special requests (the booking form collects none, and staff
 * notes are internal), one person (the guest who booked is also the booker).
 */
export async function toChannelReservation(db: Db, reservationId: string): Promise<ChannelReservation> {
  const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  if (!res) throw new Error(`Reservation ${reservationId} not found`);
  const [property] = await db.select({ code: properties.smPropertyCode, currency: properties.currency })
    .from(properties).where(eq(properties.id, res.propertyId));
  const [guest] = await db.select().from(guests).where(eq(guests.id, res.guestId));
  const rooms = await db.select({
    smRoomCode: unitTypes.smRoomCode, smRatePlanCode: ratePlans.smRatePlanCode, nightlyPrices: reservationRooms.nightlyPrices,
    roomName: unitTypes.name, ratePlanName: ratePlans.name,
  })
    .from(reservationRooms)
    .innerJoin(unitTypes, eq(unitTypes.id, reservationRooms.unitTypeId))
    .innerJoin(ratePlans, eq(ratePlans.id, reservationRooms.ratePlanId))
    .where(eq(reservationRooms.reservationId, reservationId))
    .orderBy(reservationRooms.id);

  const q = res.quote as Quote;
  const ids = q.addonLines.map((l) => l.addonId);
  const names = ids.length
    ? await db.select({ id: addons.id, slug: addons.slug, name: addons.name }).from(addons).where(inArray(addons.id, ids))
    : [];
  const promoCode = q.promoCode ?? res.promoCode ?? undefined;

  return {
    code: res.code,
    smPropertyCode: property?.code ?? "",
    checkIn: res.checkIn,
    checkOut: res.checkOut,
    rooms: rooms.map((r) => ({
      smRoomCode: r.smRoomCode ?? "", smRatePlanCode: r.smRatePlanCode ?? "", nightlyPrices: r.nightlyPrices,
      roomName: r.roomName[PMS_LOCALE], ratePlanName: r.ratePlanName[PMS_LOCALE],
    })),
    guest: { firstName: guest.firstName, lastName: guest.lastName, email: guest.email, phone: guest.phone },
    adults: res.adults,
    children: res.children,
    currency: property?.currency ?? "",
    createdAt: res.createdAt,
    lastModifiedAt: res.status === "cancelled" ? (res.cancelledAt ?? res.updatedAt) : res.updatedAt,
    total: res.totalAmount,
    paidAmount: await receivedAmount(db, reservationId), // total received, so the PMS sees front-desk money too
    discount: q.discount,
    addons: q.addonLines.map((l) => {
      const a = names.find((n) => n.id === l.addonId);
      return { code: a ? smCodeFromSlug(a.slug) : l.addonId, name: a?.name[PMS_LOCALE] ?? l.addonId, amount: l.amount };
    }),
    ...(promoCode ? { promoCode } : {}),
  };
}
