import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { AriUpdate } from "@/lib/channel/types";
import { runAtomic, type Runnable } from "@/lib/db/atomic";
import { applyAriUpdates } from "@/lib/db/ari-sync";
import { channelAriMessages, properties, ratePlans, unitTypes } from "@/lib/db/schema";
import { notifyOps } from "@/lib/ops/alerts";
import { log } from "@/lib/runtime/log";
import type { InboundContext, InboundHandler } from "./dispatch";
import { errorsXml, OTA_ERRORS, type OtaError } from "./errors";
import { attr, child, children, otaResponse, rsEcho, type XmlNode } from "./soap";

/**
 * Inbound ARI (docs/integrations/siteminder.md §4.1–4.4): OTA_HotelAvailNotifRQ (availability, stop sell, CTA, CTD,
 * min / max stay on arrival and Stay Through) and OTA_HotelRateAmountNotifRQ (PDP prices).
 *
 * - Validation is whole-message: an error answers <Errors> and applies nothing (one transaction otherwise).
 *   Unknown InvTypeCode → 402, unknown RatePlanCode → 249, with the docs' exact texts (auto-disable [ERR-G]);
 *   137 (wrong included occupancy) also sets those days' price to 0. Only structural problems are refused; a value
 *   we cannot use is stored in its safe form with a warning (see Parsed), since a refusal blocks the hotel's queue.
 * - BookingLimit is stored minus our rooms SiteMinder has not counted yet (lib/db/ari-sync.ts outstandingRooms).
 * - Dates: StatusApplicationControl @Start..@End inclusive, the hotel's local dates [AR]; expanded to one row a day.
 * - Availability (BookingLimit) is room-type level: RatePlanCode is ignored for it (SITEMINDER-OPEN-Q20).
 * - Unsupported restriction types (an unknown RestrictionStatus@Restriction or MinMaxMessageType) are ignored and the
 *   rest is applied, with Success [AR].
 * - Ordering: see orderingTs (SITEMINDER-OPEN-Q5).
 * - Success: the RS with <Success/>, the request's EchoToken and TimeStamp (soap.ts RS_TIMESTAMP).
 * Every message (after authentication) is recorded in channel_ari_messages for /admin/system, and repeated
 * rejections alert ops (after the answer, via ctx.defer).
 */

/** Longest single StatusApplicationControl range: SiteMinder updates at most 750 days ahead [AR][FAQ] (SITEMINDER-OPEN-Q11). */
export const ARI_MAX_SPAN_DAYS = 750;
/**
 * Most day rows one message may expand to (ours: the docs' default batch is 210 days of one room type [AR], which
 * SiteMinder can raise). Keeps one message to one D1 batch (lib/db/ari-sync.ts) and bounds the work per request.
 */
export const ARI_MAX_ROWS = 20_000;
/** A message TimeStamp this far ahead of our clock is clamped (SITEMINDER-OPEN-Q5). */
export const ARI_MAX_FUTURE_SKEW_MS = 10 * 60_000;
/** Ops are alerted when this many ARI messages were rejected within ARI_REJECTION_WINDOW_MS. */
export const ARI_REJECTION_ALERT_COUNT = 3;
export const ARI_REJECTION_WINDOW_MS = 3_600_000;
/** channel_ari_messages rows are kept this long. */
export const ARI_LOG_KEEP_MS = 30 * 86_400_000;

/**
 * SITEMINDER-OPEN-Q5: the time a message is ordered by (epoch ms). The docs have no sequence number; [FAQ] says
 * updates per hotel are sent one at a time, newest values only, and TimeStamp is "when the message was generated"
 * [AR]. We trust the request TimeStamp: a day's value is written only when this is ≥ the one stored with it.
 * A missing or unreadable TimeStamp (mandatory per [AR]) is read as `now`; one without a UTC offset as UTC
 * ([REQ] recommends UTC + Z); one more than ARI_MAX_FUTURE_SKEW_MS ahead of our clock is clamped there, so a wrong
 * clock cannot lock days against every later update.
 */
export function orderingTs(timeStamp: string | undefined, now: Date, onClamp?: () => void): number {
  const m = timeStamp?.trim().match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?$/);
  const t = m ? Date.parse(`${m[1].replace(/(\.\d{3})\d+$/, "$1")}${m[2] ? m[2].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") : "Z"}`) : NaN;
  if (!Number.isFinite(t)) return now.getTime();
  const limit = now.getTime() + ARI_MAX_FUTURE_SKEW_MS;
  if (t > limit) onClamp?.();
  return Math.min(t, limit);
}

/**
 * SITEMINDER-OPEN-Q6: one unknown RatePlanCode among known ones. [AR] calls the message atomic but does not cover
 * this case; until SiteMinder answers, the whole message is rejected with 249 and nothing is applied. Changing this
 * to "apply the known codes and still answer 249" is this one constant (handled in validateCodes).
 */
export const PARTIAL_APPLY_ON_UNKNOWN_RATE: boolean = false;

/** SITEMINDER-OPEN-Q7: a value we cannot use (bad date, range, number, currency): the docs define no error for it. */
const invalid = (what: string): OtaError => ({ type: 3, code: 450, text: `Unable to process: ${what}` });

const DAY_MS = 86_400_000;
const isoDay = (s: string | undefined): number | null => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? t : null;
};
const dayString = (t: number) => new Date(t).toISOString().slice(0, 10);

type Range = { start: number; days: number; room: string; rate?: string };

/** StatusApplicationControl → its inclusive range, or an error. `needRate`: the element carries per-rate data. */
function readRange(sac: XmlNode | string | undefined, needRate: boolean, at: string, errors: OtaError[]): Range | null {
  const startS = attr(sac, "Start");
  const endS = attr(sac, "End");
  const room = attr(sac, "InvTypeCode");
  const rate = attr(sac, "RatePlanCode");
  const missing = [!startS && "Start", !endS && "End", !room && "InvTypeCode", needRate && !rate && "RatePlanCode"].filter(Boolean);
  if (missing.length) {
    errors.push(OTA_ERRORS.REQUIRED_FIELD_MISSING(`${at}/StatusApplicationControl/@${missing.join(", @")}`));
    return null;
  }
  const start = isoDay(startS);
  const end = isoDay(endS);
  if (start === null || end === null) {
    errors.push(invalid(`${at} date ${start === null ? startS : endS}`));
    return null;
  }
  if (end < start) {
    errors.push(invalid(`${at} End ${endS} is before Start ${startS}`));
    return null;
  }
  const days = (end - start) / DAY_MS + 1;
  if (days > ARI_MAX_SPAN_DAYS) {
    errors.push(invalid(`${at} spans ${days} days (at most ${ARI_MAX_SPAN_DAYS})`));
    return null;
  }
  return { start, days, room: room!, rate: rate || undefined };
}

const intAttr = (v: string | undefined) => (v !== undefined && /^\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : null);

/**
 * A parsed message: its day rows, the codes it uses, the errors found (any error = nothing is applied, except
 * `onReject`), and the value problems we degraded instead of refusing (`warnings`, `degraded` day rows).
 * Refusing a message stops the hotel's whole ARI queue (SiteMinder retries it every 2 minutes and queues every
 * later update behind it [FAQ]), so a value we cannot use is stored in its safe form (price 0 = not sold,
 * availability 0, stop sell) with a warning; only structural nonsense and the docs' mapping errors are refused.
 */
type Parsed = {
  hotelCode?: string; updates: AriUpdate[]; rooms: Set<string>; rates: Set<string>; errors: OtaError[]; rows: number;
  warnings: string[]; degraded: number;
  /** Written even though the message is refused: price 0 for the days of a 137 (stale prices must stop selling). */
  onReject: AriUpdate[];
  /** Ops must hear about these at once (deduped hourly): a CurrencyCode other than the property's. */
  currencyMismatch: boolean;
};
const emptyParsed = (hotelCode: string | undefined): Parsed => ({
  hotelCode, updates: [], rooms: new Set(), rates: new Set(), errors: [], rows: 0, warnings: [], degraded: 0, onReject: [], currencyMismatch: false,
});

function expand(r: Range, fields: Omit<AriUpdate, "smRoomCode" | "smRatePlanCode" | "date">, withRate: boolean, out: Parsed, into = out.updates) {
  out.rows += r.days;
  if (out.rows > ARI_MAX_ROWS) return;
  for (let i = 0; i < r.days; i++)
    into.push({ smRoomCode: r.room, ...(withRate ? { smRatePlanCode: r.rate } : {}), date: dayString(r.start + i * DAY_MS), ...fields });
}

const LOS_FIELD = { SetMinLOS: "minStay", SetMaxLOS: "maxStay", SetForwardMinStay: "minStayThrough", SetForwardMaxStay: "maxStayThrough" } as const;

/** OTA_HotelAvailNotifRQ → day rows (availability per room type; restrictions per room type × rate plan). */
export function parseAvailNotif(root: XmlNode): Parsed {
  const msgs = child(root, "AvailStatusMessages");
  const out = emptyParsed(attr(msgs, "HotelCode"));
  children(msgs, "AvailStatusMessage").forEach((m, i) => {
    const at = `AvailStatusMessage[${i + 1}]`;
    const restrictions: Partial<AriUpdate> = {};
    let degraded = false;
    for (const rs of children(m, "RestrictionStatus")) {
      const status = attr(rs, "Status");
      const kind = attr(rs, "Restriction");
      const field = kind === undefined ? "stopSell" : kind === "Arrival" ? "closedToArrival" : kind === "Departure" ? "closedToDeparture" : null;
      if (!field) continue; // an unsupported restriction type: ignored [AR]
      if (status === undefined) {
        out.errors.push(OTA_ERRORS.REQUIRED_FIELD_MISSING(`${at}/RestrictionStatus/@Status`));
        continue;
      }
      if (status !== "Open" && status !== "Close") {
        // Unusable value: closed (the safe side), and a warning.
        out.warnings.push(`${at} RestrictionStatus Status ${status.slice(0, 16)} read as Close`);
        degraded = true;
      }
      restrictions[field] = status !== "Open";
    }
    for (const los of children(child(m, "LengthsOfStay"), "LengthOfStay")) {
      const type = attr(los, "MinMaxMessageType");
      const field = type && Object.hasOwn(LOS_FIELD, type) ? LOS_FIELD[type as keyof typeof LOS_FIELD] : null;
      if (!field) continue; // unsupported: ignored [AR]
      const raw = attr(los, "Time");
      const isMax = field === "maxStay" || field === "maxStayThrough";
      if (raw === undefined) {
        // A max without Time clears the limit; a min always carries one [AR].
        if (isMax) restrictions[field] = null;
        else out.errors.push(OTA_ERRORS.REQUIRED_FIELD_MISSING(`${at}/LengthOfStay/@Time`));
        continue;
      }
      const t = intAttr(raw);
      if (t === null || t < 1) {
        // Unusable: this limit is left as it was, with a warning.
        out.warnings.push(`${at} LengthOfStay ${type} Time ${raw.slice(0, 16)} ignored`);
        degraded = true;
        continue;
      }
      restrictions[field] = Math.min(t, 9999);
    }
    const limitRaw = attr(m, "BookingLimit");
    let limit = limitRaw === undefined ? undefined : intAttr(limitRaw);
    if (limit === null) {
      // Negative or not a whole number: nothing to sell (0), with a warning.
      out.warnings.push(`${at} BookingLimit ${limitRaw!.slice(0, 16)} read as 0`);
      limit = 0;
      degraded = true;
    }

    // SITEMINDER-OPEN-Q20: BookingLimit is room-type level (the docs' default [AR]); its RatePlanCode is not checked.
    const perRate = Object.keys(restrictions).length > 0;
    if (!perRate && limit == null) return; // nothing we store (or already an error)
    const range = readRange(child(m, "StatusApplicationControl"), perRate, at, out.errors);
    if (!range) return;
    if (degraded) out.degraded += range.days;
    out.rooms.add(range.room);
    if (perRate) out.rates.add(range.rate!);
    if (limit != null) expand(range, { available: limit }, false, out);
    if (perRate) expand(range, restrictions, true, out);
  });
  return out;
}

/**
 * SITEMINDER-OPEN-Q8 (and doc §8.13, inferred: we chose PDP): the one price a night we store, from a Rate's
 * BaseByGuestAmt list. Our price is per room a night whoever stays, so the room type's included occupancy is its
 * maxOccupancy: an amount without NumberOfGuests, or with NumberOfGuests = maxOccupancy, is the price (several such
 * amounts: the first, with a warning); another NumberOfGuests ≥ 2 is a wrong included occupancy (the docs' required
 * 137 error, the only refusal here); NumberOfGuests = 1 below maxOccupancy is a single-guest discount, which we do
 * not sell (ignored, as are AdditionalGuestAmounts). Amounts are decimals [RATES]; we store whole currency units
 * and round. Degraded to price 0 (never sold) with a warning: an amount that is missing, not a number, ≤ 0 or
 * rounds to 0, and a CurrencyCode other than the property's (the amount is never stored; ops are alerted).
 */
export function pdpPrice(
  amounts: XmlNode[], maxOccupancy: number, currency: string, at: string,
): { price: number; warning?: string; currencyMismatch?: boolean } | { error: OtaError } | null {
  let found: { price: number; warning?: string; currencyMismatch?: boolean } | null = null;
  let extra = 0;
  for (const a of amounts) {
    const age = attr(a, "AgeQualifyingCode");
    if (age !== undefined && age !== "10") continue;
    const guestsRaw = attr(a, "NumberOfGuests");
    const guests = guestsRaw === undefined ? undefined : intAttr(guestsRaw);
    if (guests === null || guests === 0) continue; // not a guest count: ignored
    if (guests !== undefined && guests !== maxOccupancy) {
      if (guests === 1) continue;
      return { error: OTA_ERRORS.INVALID_INCLUDED_OCCUPANCY(maxOccupancy) };
    }
    if (found) {
      extra++;
      continue;
    }
    const cur = attr(a, "CurrencyCode");
    if (cur !== undefined && cur !== currency) {
      found = { price: 0, currencyMismatch: true, warning: `${at} CurrencyCode ${cur.slice(0, 8)} (expecting ${currency}): price 0` };
      continue;
    }
    const raw = attr(a, "AmountAfterTax");
    const v = raw !== undefined && /^\d{1,12}(\.\d{1,6})?$/.test(raw.trim()) ? Math.round(Number(raw.trim())) : NaN;
    found = v > 0 ? { price: v } : { price: 0, warning: `${at} AmountAfterTax ${raw === undefined ? "missing" : raw.slice(0, 24)}: price 0` };
  }
  if (found && extra) found.warning = [found.warning, `${at} ${extra + 1} amounts for the included occupancy: the first is used`].filter(Boolean).join("; ");
  return found;
}

type RoomInfo = { code: string; maxOccupancy: number };

/** OTA_HotelRateAmountNotifRQ → day rows (a price per room type × rate plan). */
export function parseRateAmountNotif(root: XmlNode, rooms: Map<string, RoomInfo>, currency: string): Parsed {
  const msgs = child(root, "RateAmountMessages");
  const out = emptyParsed(attr(msgs, "HotelCode"));
  children(msgs, "RateAmountMessage").forEach((m, i) => {
    const at = `RateAmountMessage[${i + 1}]`;
    // SITEMINDER-OPEN-Q8: [RATES] lists RatePlanCode as 0..1, but a price is always for one of our rate plans.
    const range = readRange(child(m, "StatusApplicationControl"), true, at, out.errors);
    if (!range) return;
    out.rooms.add(range.room);
    out.rates.add(range.rate!);
    const room = rooms.get(range.room);
    if (!room) return; // 402, below
    const amounts = children(child(child(child(m, "Rates"), "Rate"), "BaseByGuestAmts"), "BaseByGuestAmt");
    const r = pdpPrice(amounts, room.maxOccupancy, currency, at);
    if (r === null) {
      out.errors.push(OTA_ERRORS.REQUIRED_FIELD_MISSING(`${at}/Rates/Rate/BaseByGuestAmts/BaseByGuestAmt`));
      return;
    }
    if ("error" in r) {
      out.errors.push(r.error);
      // A wrong included occupancy: this room + rate's old prices must stop selling even though we refuse (137).
      expand(range, { price: 0 }, true, out, out.onReject);
      return;
    }
    if (r.warning) {
      out.warnings.push(r.warning);
      if (r.price === 0) out.degraded += range.days;
    }
    if (r.currencyMismatch) out.currencyMismatch = true;
    expand(range, { price: r.price }, true, out);
  });
  return out;
}

/** The 402 / 249 errors for codes the property does not have (one error each kind: the texts carry no code). */
function validateCodes(p: Parsed, rooms: Map<string, RoomInfo>, rates: Set<string>) {
  const unknownRooms = [...p.rooms].filter((c) => !rooms.has(c));
  const unknownRates = [...p.rates].filter((c) => !rates.has(c));
  const errors: OtaError[] = [];
  if (unknownRooms.length) errors.push(OTA_ERRORS.ROOM_NOT_FOUND);
  if (unknownRates.length) errors.push(OTA_ERRORS.RATE_NOT_FOUND);
  const rejectedCodes = [
    ...unknownRooms.map((code) => ({ kind: "room" as const, code })),
    ...unknownRates.map((code) => ({ kind: "rate" as const, code })),
  ];
  // SITEMINDER-OPEN-Q6: drop the unknown rate plans' rows and apply the rest (only when PARTIAL_APPLY_ON_UNKNOWN_RATE).
  const partial = PARTIAL_APPLY_ON_UNKNOWN_RATE && !unknownRooms.length && unknownRates.length > 0 && p.errors.length === 0;
  if (partial) p.updates = p.updates.filter((u) => u.smRatePlanCode === undefined || rates.has(u.smRatePlanCode));
  return { errors, rejectedCodes, partial };
}

const dedupe = (errors: OtaError[]) => {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const k = `${e.type}|${e.code}|${e.text}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
};

/** Errors in an RS: at most this many (each is one line of SiteMinder's log). */
const MAX_ERRORS = 10;

function ariHandler(messageType: "OTA_HotelAvailNotifRQ" | "OTA_HotelRateAmountNotifRQ"): InboundHandler {
  const rsName = messageType === "OTA_HotelAvailNotifRQ" ? "OTA_HotelAvailNotifRS" : "OTA_HotelRateAmountNotifRS";
  return async (ctx) => {
    const started = Date.now();
    const { db, root, now } = ctx;
    const rs = (content: string) => otaResponse(rsName, rsEcho(rsName, root, now), content);
    const echoToken = attr(root, "EchoToken")?.slice(0, 64);
    const record = (o: Omit<typeof channelAriMessages.$inferInsert, "id" | "at" | "messageType" | "echoToken" | "durationMs">): Runnable[] => [
      db.insert(channelAriMessages).values({
        id: crypto.randomUUID(), at: now.getTime(), messageType, echoToken, durationMs: Date.now() - started, ...o,
      }),
      db.delete(channelAriMessages).where(lt(channelAriMessages.at, now.getTime() - ARI_LOG_KEEP_MS)),
    ];

    const reject = async (errors: OtaError[], o: { propertyId?: string; days: number; rejectedCodes?: { kind: "room" | "rate"; code: string }[]; zeroPrices?: AriUpdate[] }) => {
      const shown = dedupe(errors).slice(0, MAX_ERRORS);
      const first = shown[0];
      const codes = o.rejectedCodes ?? [];
      const row = record({ propertyId: o.propertyId, days: o.days, outcome: "rejected", errorCode: first.code, errorText: first.text.slice(0, 200), rejectedCodes: codes });
      // 137 for a known room + rate: price 0 for its days, in the same transaction as the log row (ordered like any write).
      if (o.propertyId && o.zeroPrices?.length)
        await applyAriUpdates(db, o.propertyId, o.zeroPrices, now, { sourceTs: orderingTs(attr(root, "TimeStamp"), now), extra: row });
      else await runAtomic(db, row);
      log.warn(`siteminder ari: ${messageType} echo=${echoToken ?? "-"} rejected (${shown.map((e) => `${e.type}/${e.code ?? "-"}`).join(", ")})`
        + `${codes.length ? ` codes=${codes.map((c) => `${c.kind}:${c.code.slice(0, 32)}`).join(",")}` : ""} days=${o.days}`
        + `${o.zeroPrices?.length ? ` priced0=${o.zeroPrices.length}` : ""}`);
      const mapping = shown.filter((e) => e.code !== undefined && MAPPING_CODES.has(e.code));
      later(ctx, async () => {
        if (mapping.length) await alertMapping(ctx, now, messageType, mapping, codes);
        await alertOnRepeatedRejections(ctx, now);
      });
      return rs(errorsXml(shown));
    };

    const hotelCode = attr(child(root, messageType === "OTA_HotelAvailNotifRQ" ? "AvailStatusMessages" : "RateAmountMessages"), "HotelCode");
    if (!hotelCode) return reject([OTA_ERRORS.REQUIRED_FIELD_MISSING("@HotelCode")], { days: 0 });
    const [property] = await db.select({ id: properties.id, currency: properties.currency }).from(properties).where(eq(properties.smPropertyCode, hotelCode));
    if (!property) return reject([OTA_ERRORS.HOTEL_NOT_FOUND(hotelCode)], { days: 0 });

    const [roomRows, planRows] = await Promise.all([
      db.select({ code: unitTypes.smRoomCode, maxOccupancy: unitTypes.maxOccupancy }).from(unitTypes).where(eq(unitTypes.propertyId, property.id)),
      db.select({ code: ratePlans.smRatePlanCode }).from(ratePlans).where(eq(ratePlans.propertyId, property.id)),
    ]);
    const rooms = new Map(roomRows.filter((r) => r.code).map((r) => [r.code!, { code: r.code!, maxOccupancy: r.maxOccupancy }]));
    const rates = new Set(planRows.map((p) => p.code).filter((c): c is string => !!c));

    const parsed = messageType === "OTA_HotelAvailNotifRQ" ? parseAvailNotif(root) : parseRateAmountNotif(root, rooms, property.currency);
    if (parsed.rows > ARI_MAX_ROWS) parsed.errors.push(invalid(`the message expands to ${parsed.rows} day rows (at most ${ARI_MAX_ROWS})`));
    const codes = validateCodes(parsed, rooms, rates);
    const errors = [...parsed.errors, ...codes.errors];
    if (errors.length && !codes.partial) {
      // Only rows of known room + rate codes, and only when the message is not oversized.
      const zeroPrices = parsed.rows > ARI_MAX_ROWS ? [] : parsed.onReject.filter((u) => rooms.has(u.smRoomCode) && rates.has(u.smRatePlanCode!));
      return reject(errors, { propertyId: property.id, days: parsed.rows, rejectedCodes: codes.rejectedCodes, zeroPrices });
    }

    const ts = orderingTs(attr(root, "TimeStamp"), now, () =>
      log.warn(`siteminder ari: ${messageType} echo=${echoToken ?? "-"} TimeStamp ${attr(root, "TimeStamp")!.slice(0, 40)} is more than ${ARI_MAX_FUTURE_SKEW_MS / 60_000} min ahead of our clock: clamped`));
    for (const w of parsed.warnings.slice(0, 20)) log.warn(`siteminder ari: ${messageType} echo=${echoToken ?? "-"} ${w}`);
    const r = await applyAriUpdates(db, property.id, parsed.updates, now, {
      sourceTs: ts,
      extra: ({ stale }) => record({
        propertyId: property.id, days: parsed.updates.length, outcome: codes.partial ? "rejected" : "applied",
        ...(codes.partial ? { errorCode: codes.errors[0].code, errorText: codes.errors[0].text } : {}), rejectedCodes: codes.rejectedCodes,
        staleRows: stale, degradedRows: parsed.degraded,
      }),
    });
    if (r.unknownCodes.length || r.rejected.length)
      log.error(`siteminder ari: ${messageType} echo=${echoToken ?? "-"} rows skipped after validation (${r.unknownCodes.length} codes, ${r.rejected.length} rows)`);
    log.info(`siteminder ari: ${messageType} echo=${echoToken ?? "-"} applied days=${parsed.updates.length} stale=${r.stale} degraded=${parsed.degraded} in ${Date.now() - started} ms`);
    if (parsed.degraded > 0 && !parsed.currencyMismatch)
      later(ctx, async () => {
        if (!ctx.ops) return;
        // Degrading keeps SiteMinder's queue moving, but must never go unnoticed (e.g. Status="open" read as Close).
        await notifyOps(ctx.ops, {
          kind: "ari_rejected", scope: "degraded",
          detail: `SiteMinder ARI ${messageType} (echo ${echoToken ?? "-"}): ${parsed.degraded} day rows had values we could not use; they were stored in a safe form (price 0, 0 rooms, closed, or the limit left as it was).`
            + `\n${parsed.warnings.slice(0, 10).join("\n")}`,
        }, now);
      });
    if (parsed.currencyMismatch)
      later(ctx, async () => {
        if (!ctx.ops) return;
        await notifyOps(ctx.ops, {
          kind: "ari_rejected", scope: "currency",
          detail: `SiteMinder ARI ${messageType} (echo ${echoToken ?? "-"}) sent a CurrencyCode other than ${property.currency}. Those days were stored with price 0 (not sold). Check the hotel's currency in SiteMinder.`,
        }, now);
      });
    if (codes.partial) {
      later(ctx, () => alertOnRepeatedRejections(ctx, now));
      return rs(errorsXml(codes.errors));
    }
    return rs("<Success/>");
  };
}

/** The docs' mapping errors: SiteMinder disables the room / rate on them [ERR-G], so ops hear at once. */
const MAPPING_CODES = new Set([402, 249, 137]);

/** A 402 / 249 / 137 answer: alert ops now (kind ari_rejected, scope mapping: at most hourly). */
async function alertMapping(ctx: Pick<InboundContext, "ops">, now: Date, messageType: string, errors: OtaError[], codes: { kind: "room" | "rate"; code: string }[]) {
  if (!ctx.ops) return;
  const list = codes.map((c) => `${c.kind === "room" ? "房型" : "方案"} ${c.code}`).join(", ");
  await notifyOps(ctx.ops, {
    kind: "ari_rejected", scope: "mapping",
    detail: `SiteMinder ARI ${messageType} answered ${errors.map((e) => `${e.code} ${e.text}`).join("; ")}. SiteMinder disables the room type / rate plan on these errors.`
      + `${list ? `\nCodes: ${list}` : ""}\nCheck the room type / rate plan mapping in SiteMinder (codes on /admin) and the included occupancy (maxOccupancy) of each room type.`,
  }, now);
}

/** Run `work` after the answer when the endpoint can (ctx.waitUntil), else inline; it never throws. */
function later(ctx: InboundContext, work: () => Promise<void>) {
  const p = work().catch((e: unknown) => log.error("siteminder ari: after-response work failed", e));
  if (ctx.defer) ctx.defer(p);
  else ctx.pending?.push(p);
}

/**
 * After a rejection: when ARI_REJECTION_ALERT_COUNT messages were rejected within the window, alert ops (kind
 * ari_rejected; notifyOps sends each key at most hourly). SiteMinder retries a rejected message every 2 minutes and
 * queues the hotel's later updates behind it [FAQ], so a repeated rejection stops all ARI for that hotel.
 */
export async function alertOnRepeatedRejections(ctx: Pick<InboundContext, "db" | "ops">, now: Date): Promise<void> {
  if (!ctx.ops) return;
  const recent = await ctx.db.select().from(channelAriMessages)
    .where(and(eq(channelAriMessages.outcome, "rejected"), gte(channelAriMessages.at, now.getTime() - ARI_REJECTION_WINDOW_MS)))
    .orderBy(sql`${channelAriMessages.at} desc`).limit(50);
  if (recent.length < ARI_REJECTION_ALERT_COUNT) return;
  const codes = [...new Set(recent.flatMap((r) => r.rejectedCodes.map((c) => `${c.kind === "room" ? "房型" : "方案"} ${c.code}`)))];
  const lines = recent.slice(0, 10).map((r) => `- ${new Date(r.at).toISOString()} ${r.messageType} ${r.errorCode ?? "-"} ${r.errorText ?? ""}`);
  await notifyOps(ctx.ops, {
    kind: "ari_rejected",
    detail: `SiteMinder ARI: ${recent.length} messages rejected in the last hour.`
      + `${codes.length ? `\nUnknown codes: ${codes.join(", ")}` : ""}\nLatest first:\n${lines.join("\n")}`,
  }, now);
}

export const handleAvailNotif = ariHandler("OTA_HotelAvailNotifRQ");
export const handleRateAmountNotif = ariHandler("OTA_HotelRateAmountNotifRQ");
