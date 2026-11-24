import { eq, inArray } from "drizzle-orm";
import type { ChannelReservation } from "@/lib/channel/types";
import { addons, guests, properties, ratePlans, reservationRooms, reservations, unitTypes } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Quote } from "@/lib/domain/quote";
import { paidAmount } from "./notify";

/** Add-on names go to the PMS in Chinese, the front desk's language. */
const PMS_LOCALE = "zh-TW";

/**
 * The reservation as SiteMinder receives it. Add-ons, the promo code and the amount already paid
 * are included so the PMS sees them (spec 5.8). Missing channel codes are sent as "".
 */
export async function toChannelReservation(db: Db, reservationId: string): Promise<ChannelReservation> {
  const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  if (!res) throw new Error(`Reservation ${reservationId} not found`);
  const [property] = await db.select({ code: properties.smPropertyCode }).from(properties).where(eq(properties.id, res.propertyId));
  const [guest] = await db.select().from(guests).where(eq(guests.id, res.guestId));
  const rooms = await db.select({
    smRoomCode: unitTypes.smRoomCode, smRatePlanCode: ratePlans.smRatePlanCode, nightlyPrices: reservationRooms.nightlyPrices,
  })
    .from(reservationRooms)
    .innerJoin(unitTypes, eq(unitTypes.id, reservationRooms.unitTypeId))
    .innerJoin(ratePlans, eq(ratePlans.id, reservationRooms.ratePlanId))
    .where(eq(reservationRooms.reservationId, reservationId));

  const q = res.quote as Quote;
  const ids = q.addonLines.map((l) => l.addonId);
  const names = ids.length ? await db.select({ id: addons.id, name: addons.name }).from(addons).where(inArray(addons.id, ids)) : [];
  const promoCode = q.promoCode ?? res.promoCode ?? undefined;

  return {
    code: res.code,
    smPropertyCode: property?.code ?? "",
    checkIn: res.checkIn,
    checkOut: res.checkOut,
    rooms: rooms.map((r) => ({ smRoomCode: r.smRoomCode ?? "", smRatePlanCode: r.smRatePlanCode ?? "", nightlyPrices: r.nightlyPrices })),
    guest: { firstName: guest.firstName, lastName: guest.lastName, email: guest.email, phone: guest.phone },
    total: res.totalAmount,
    paidAmount: await paidAmount(db, reservationId),
    addons: q.addonLines.map((l) => ({ name: names.find((n) => n.id === l.addonId)?.name[PMS_LOCALE] ?? l.addonId, amount: l.amount })),
    ...(promoCode ? { promoCode } : {}),
  };
}
