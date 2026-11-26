import { addDaysISO } from "@/lib/domain/dates";
import type { ChannelReservation } from "../types";
import { isoTimestamp } from "./inbound/soap";
import { clipChars, el, otaRequest, txt, xmlSafe } from "./xml";

/**
 * ChannelReservation → OTA_HotelResNotifRQ, exactly per docs/integrations/siteminder.md §3 (table §3.3, element
 * order from [RES]'s "Maximum Content XML"). Everything marked inferred there is isolated in one function or
 * constant below with its SITEMINDER-OPEN-Qn tag.
 */

/** ResStatus per call ([RES]): a new reservation, a change, a cancellation. */
export const RES_STATUS = { push: "Commit", modify: "Modify", cancel: "Cancel" } as const;
export type ResStatus = (typeof RES_STATUS)[keyof typeof RES_STATUS];

/**
 * SITEMINDER-OPEN-Q4: UniqueID@ID must be alphanumeric only and never reused ([REQ][RES]); our codes are
 * `NK-XXXXXX`. We send the code with every non-alphanumeric character removed (NK-AB12CD → NKAB12CD), in every
 * message for that booking. If SiteMinder answers Q4 differently, change only this function.
 * (The implementation plan calls this question Q3; the doc's §7 numbers it Q4.)
 */
export function uniqueIdFor(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, "");
}

/**
 * SITEMINDER-OPEN-Q8: amounts are decimals in XML; ours are whole units (TWD), tax included, sent as
 * AmountAfterTax only, with no Taxes element. If SiteMinder wants two decimals or BeforeTax, change it here.
 */
export function amount(n: number): string {
  return String(n);
}

/**
 * SITEMINDER-OPEN-Q9: GuestCounts is per RoomStay, but a booking holds only its total adults and children. Split
 * evenly, the remainder to the first rooms. Every room needs an adult (OTA: the adult count is mandatory and
 * Count ≥ 1 [RES]): fewer adults than rooms is refused before sending (unsendableReason), never inflated.
 * Children are sent without @Age (we hold no ages; whether it is required is part of Q9).
 */
export function guestsPerRoom(adults: number, children: number, rooms: number): { adults: number; children: number }[] {
  const split = (n: number) => Array.from({ length: rooms }, (_, i) => Math.floor(n / rooms) + (i < n % rooms ? 1 : 0));
  const a = split(Math.max(0, adults));
  const c = split(Math.max(0, children));
  return a.map((x, i) => ({ adults: x, children: c[i] }));
}

/**
 * The nightly prices with the discount taken off ([RES]: there is no discount element; the discount shows in the
 * nightly rates, the RoomStay totals and the overall total, and is explained in a comment). Spread over every night
 * of every room in proportion to its price; the whole-unit remainder goes to the largest fractions (earliest first),
 * so the nights add up to exactly (rooms − discount).
 */
export function discountedNights(rooms: number[][], discount: number): number[][] {
  const flat = rooms.flat();
  const sum = flat.reduce((s, p) => s + p, 0);
  const d = Math.min(Math.max(0, discount), sum);
  if (d === 0 || sum === 0) return rooms.map((r) => [...r]);
  const shares = flat.map((p) => (p * d) / sum);
  const off = shares.map(Math.floor);
  let left = d - off.reduce((s, x) => s + x, 0);
  const order = shares.map((s, i) => ({ i, f: s - Math.floor(s) })).sort((x, y) => y.f - x.f || x.i - y.i);
  for (const { i } of order) {
    if (left <= 0) break;
    off[i]++;
    left--;
  }
  let k = 0;
  return rooms.map((r) => r.map((p) => p - off[k++]));
}

/** The comment explaining the discount (in the PMS language), or null when there is none. */
export function discountComment(r: ChannelReservation): string | null {
  if (r.discount <= 0) return null;
  return `優惠折扣 ${amount(r.discount)} ${r.currency}${r.promoCode ? `（優惠碼 ${r.promoCode}）` : ""}，已反映在每晚房價與總額`;
}

/**
 * SITEMINDER-OPEN-Q18: the amount already paid. [RES]'s "Deposit Only" sample has
 * DepositPayments/GuaranteePayment/AmountPercent@Amount with no card; placing DepositPayments under ResGlobalInfo is
 * inferred from the OTA structure. Left out when nothing was paid.
 */
export function depositPayments(r: ChannelReservation): string {
  if (r.paidAmount <= 0) return "";
  return el("DepositPayments", {}, el("GuaranteePayment", {}, el("AmountPercent", { Amount: amount(r.paidAmount), CurrencyCode: r.currency })));
}

/** Telephone@PhoneNumber is at most 32 characters [RES]. */
const PHONE_MAX = 32;

/** RPH linking every RoomStay to the one guest we hold. */
const GUEST_RPH = "1";

function customer(r: ChannelReservation): string {
  const g = r.guest;
  return el("Customer", {},
    el("PersonName", {}, el("GivenName", {}, txt(g.firstName)), el("Surname", {}, txt(g.lastName))),
    g.phone ? el("Telephone", { PhoneNumber: clipChars(xmlSafe(g.phone), PHONE_MAX) }) : "",
    g.email ? el("Email", {}, txt(g.email)) : "");
}

const profile = (r: ChannelReservation) =>
  el("Profiles", {}, el("ProfileInfo", {}, el("Profile", { ProfileType: "1" }, customer(r))));

const comments = (texts: string[]) =>
  texts.length ? el("Comments", {}, ...texts.map((t) => el("Comment", {}, el("Text", {}, txt(t))))) : "";

/**
 * One RoomStay per booked room ([RES]): RoomTypes, RatePlans, RoomRates (one Rate per night), GuestCounts,
 * TimeSpan, Total, BasicPropertyInfo, ResGuestRPHs, in that order. Room and rate names are sent for SiteMinder's
 * notification email (SITEMINDER-OPEN-Q15: whether they are needed when the hotel has a PMS connection).
 */
function roomStays(r: ChannelReservation): string {
  const nights = discountedNights(r.rooms.map((x) => x.nightlyPrices), r.discount);
  const guests = guestsPerRoom(r.adults, r.children, r.rooms.length);
  return el("RoomStays", {}, ...r.rooms.map((room, i) => {
    const prices = nights[i];
    const rates = prices.map((p, n) => {
      const day = addDaysISO(r.checkIn, n);
      return el("Rate", { UnitMultiplier: 1, RateTimeUnit: "Day", EffectiveDate: day, ExpireDate: addDaysISO(day, 1) },
        el("Base", { AmountAfterTax: amount(p), CurrencyCode: r.currency }));
    });
    const g = guests[i];
    return el("RoomStay", { PromotionCode: r.promoCode },
      el("RoomTypes", {}, el("RoomType", { RoomTypeCode: room.smRoomCode }, el("RoomDescription", { Name: room.roomName }))),
      el("RatePlans", {}, el("RatePlan", { RatePlanCode: room.smRatePlanCode }, el("RatePlanDescription", { Name: room.ratePlanName }))),
      el("RoomRates", {}, el("RoomRate", { RoomTypeCode: room.smRoomCode, RatePlanCode: room.smRatePlanCode, NumberOfUnits: 1 },
        el("Rates", {}, ...rates))),
      el("GuestCounts", {},
        el("GuestCount", { AgeQualifyingCode: 10, Count: g.adults }),
        g.children > 0 ? el("GuestCount", { AgeQualifyingCode: 8, Count: g.children }) : ""),
      el("TimeSpan", { Start: r.checkIn, End: r.checkOut }),
      el("Total", { AmountAfterTax: amount(prices.reduce((s, p) => s + p, 0)), CurrencyCode: r.currency }),
      el("BasicPropertyInfo", { HotelCode: r.smPropertyCode }),
      el("ResGuestRPHs", {}, el("ResGuestRPH", { RPH: GUEST_RPH })));
  }));
}

/**
 * Add-ons at booking level ([RES]): Inclusive="true", no ServiceRPH, so they count in ResGlobalInfo/Total only.
 * Quantity 1 with the line's whole amount (we hold line amounts, not unit prices).
 */
function services(r: ChannelReservation): string {
  if (!r.addons.length) return "";
  return el("Services", {}, ...r.addons.map((a, i) =>
    el("Service", { ServiceInventoryCode: a.code, Inclusive: "true", Quantity: 1, ID: i + 1 },
      el("Price", {},
        el("Total", { AmountAfterTax: amount(a.amount), CurrencyCode: r.currency }),
        el("RateDescription", {}, el("Text", {}, txt(a.name)))))));
}

export type RequestContext = {
  status: ResStatus;
  echoToken: string;
  now: Date;
  /** POS/Source/RequestorID@ID: our channel code, given by SiteMinder (case-sensitive) [REQ][RES]. */
  requestorId: string;
  /** BookingChannel/CompanyName text. */
  companyName: string;
};

/** The whole OTA_HotelResNotifRQ for one reservation (one per message [RES]). */
export function resNotifRQ(r: ChannelReservation, ctx: RequestContext): string {
  const pos = el("POS", {}, el("Source", {},
    el("RequestorID", { Type: 22, ID: ctx.requestorId }),
    el("BookingChannel", { Primary: "true" }, el("CompanyName", { Code: ctx.requestorId }, txt(ctx.companyName)))));
  const notes = [discountComment(r), r.specialRequests?.trim() || null].filter((x): x is string => !!x);
  const reservation = el("HotelReservation", {
    CreateDateTime: isoTimestamp(new Date(r.createdAt)),
    LastModifyDateTime: ctx.status === "Commit" ? undefined : isoTimestamp(new Date(r.lastModifiedAt)),
  },
  el("UniqueID", { Type: 14, ID: uniqueIdFor(r.code) }),
  roomStays(r),
  services(r),
  el("ResGuests", {}, el("ResGuest", { ResGuestRPH: GUEST_RPH, PrimaryIndicator: "1" }, profile(r))),
  el("ResGlobalInfo", {},
    comments(notes),
    el("Total", { AmountAfterTax: amount(r.total), CurrencyCode: r.currency }),
    depositPayments(r),
    profile(r)));
  return otaRequest("OTA_HotelResNotifRQ",
    { EchoToken: ctx.echoToken, TimeStamp: isoTimestamp(ctx.now), Version: "1.0", ResStatus: ctx.status },
    pos, el("HotelReservations", {}, reservation));
}

/**
 * Why `r` cannot be sent as it is (our data is incomplete), or null. Checked before sending: SiteMinder would
 * refuse it anyway, and a refusal we never sent leaves the booking marked not pushed.
 */
export function unsendableReason(r: ChannelReservation): string | null {
  if (!r.rooms.length) return "NO_ROOMS";
  if (r.rooms.some((x) => !x.smRoomCode || !x.smRatePlanCode)) return "MISSING_ROOM_OR_RATE_CODE";
  if (r.rooms.some((x) => x.nightlyPrices.length === 0)) return "NO_NIGHTS";
  if (!r.currency) return "MISSING_CURRENCY";
  if (r.adults < 1) return "NO_ADULTS";
  if (r.adults < r.rooms.length) return "ADULTS_FEWER_THAN_ROOMS";
  const nights = Math.round((Date.parse(`${r.checkOut}T00:00:00Z`) - Date.parse(`${r.checkIn}T00:00:00Z`)) / 86_400_000);
  if (!(nights >= 1) || r.rooms.some((x) => x.nightlyPrices.length !== nights)) return "NIGHTS_MISMATCH";
  const rooms = discountedNights(r.rooms.map((x) => x.nightlyPrices), r.discount).flat().reduce((s, p) => s + p, 0);
  if (rooms + r.addons.reduce((s, a) => s + a.amount, 0) !== r.total) return "TOTALS_DO_NOT_ADD_UP";
  if (!uniqueIdFor(r.code)) return "EMPTY_UNIQUE_ID";
  return null;
}
