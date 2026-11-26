import { and, asc, eq } from "drizzle-orm";
import { properties, ratePlans, unitTypes } from "@/lib/db/schema";
import { log } from "@/lib/runtime/log";
import { errorsXml, OTA_ERRORS } from "./errors";
import type { InboundHandler } from "./dispatch";
import { attr, escapeXml, isoTimestamp, otaResponse, path } from "./soap";

/**
 * Rooms and Rates ([RR], docs/integrations/siteminder.md §4.5): SiteMinder pulls the hotel's room types and rate
 * plans so the hotel can map them. Request: OTA_HotelAvailRQ AvailRatesOnly="true" with
 * AvailRequestSegments/AvailRequestSegment/HotelSearchCriteria/Criterion/HotelRef@HotelCode. Response:
 * OTA_HotelAvailRS with <Success/> and one RoomStay per (active room type × active rate plan), or <Errors>.
 *
 * - EchoToken is echoed; TimeStamp is when this response was generated ([RR]: "@TimeStamp" of the RS).
 * - Only active rows with a code are listed (inactive ones must be left out [RR]; a row without a code cannot be
 *   mapped, and is logged). Direct-only plans are listed: our site is the channel they are sold on.
 * - Names: RoomDescription@Name / RatePlanDescription@Name is the zh-TW name (the hotel's staff map in
 *   SiteMinder); Text is the English name (for SiteMinder support [RR]). Names must be unique [RR]: a repeated
 *   name gets " (CODE)" appended.
 * - Pricing model PDP (doc §8.13, inferred): no Occupancy element, which [RR] requires for OBP only.
 */
export const handleRoomsAndRates: InboundHandler = async ({ db, root, now }) => {
  const echo = { echoToken: attr(root, "EchoToken"), timeStamp: isoTimestamp(now) };
  const rs = (content: string) => otaResponse("OTA_HotelAvailRS", echo, content);

  const hotelRef = path(root, "AvailRequestSegments", "AvailRequestSegment", "HotelSearchCriteria", "Criterion", "HotelRef");
  const hotelCode = attr(hotelRef, "HotelCode");
  if (!hotelCode) return rs(errorsXml([OTA_ERRORS.REQUIRED_FIELD_MISSING("HotelRef/@HotelCode")]));

  const [property] = await db.select({ id: properties.id }).from(properties).where(eq(properties.smPropertyCode, hotelCode));
  if (!property) return rs(errorsXml([OTA_ERRORS.HOTEL_NOT_FOUND(hotelCode)]));

  const [allRooms, allPlans] = await Promise.all([
    db.select({ code: unitTypes.smRoomCode, name: unitTypes.name }).from(unitTypes)
      .where(and(eq(unitTypes.propertyId, property.id), eq(unitTypes.active, true)))
      .orderBy(asc(unitTypes.sortOrder), asc(unitTypes.slug)),
    db.select({ code: ratePlans.smRatePlanCode, name: ratePlans.name }).from(ratePlans)
      .where(and(eq(ratePlans.propertyId, property.id), eq(ratePlans.active, true)))
      .orderBy(asc(ratePlans.slug)),
  ]);
  const coded = <T extends { code: string | null }>(xs: T[]) => xs.filter((x): x is T & { code: string } => !!x.code);
  const rooms = coded(allRooms);
  const plans = coded(allPlans);
  const uncoded = allRooms.length - rooms.length + allPlans.length - plans.length;
  if (uncoded > 0) log.warn(`siteminder rooms-and-rates: ${uncoded} active room type(s) / rate plan(s) have no code and are not listed`);

  const roomNames = uniqueNames(rooms.map((r) => ({ code: r.code, name: r.name["zh-TW"] })));
  const planNames = uniqueNames(plans.map((p) => ({ code: p.code, name: p.name["zh-TW"] })));
  const stays = rooms.flatMap((r, i) => plans.map((p, j) =>
    `<RoomStay><RoomTypes><RoomType RoomTypeCode="${escapeXml(r.code)}"><RoomDescription Name="${escapeXml(roomNames[i])}"><Text>${escapeXml(r.name.en)}</Text></RoomDescription></RoomType></RoomTypes>`
    + `<RatePlans><RatePlan RatePlanCode="${escapeXml(p.code)}"><RatePlanDescription Name="${escapeXml(planNames[j])}"><Text>${escapeXml(p.name.en)}</Text></RatePlanDescription></RatePlan></RatePlans></RoomStay>`));
  return rs(`<Success/>${stays.length ? `<RoomStays>${stays.join("")}</RoomStays>` : ""}`);
};

/** The display names, with " (CODE)" added to any name that occurs more than once (codes are unique). */
export function uniqueNames(rows: { code: string; name: string }[]): string[] {
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.name, (count.get(r.name) ?? 0) + 1);
  return rows.map((r) => (!r.name.trim() ? r.code : count.get(r.name)! > 1 ? `${r.name} (${r.code})` : r.name));
}
