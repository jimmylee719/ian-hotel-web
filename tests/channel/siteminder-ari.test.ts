import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getSystemStatus } from "@/lib/admin/system-status";
import {
  ARI_MAX_FUTURE_SKEW_MS, ARI_MAX_SPAN_DAYS, ARI_REJECTION_ALERT_COUNT, orderingTs,
} from "@/lib/channel/siteminder/inbound/ari";
import { handleSiteMinderInbound, type InboundDeps } from "@/lib/channel/siteminder/inbound/dispatch";
import { searchAvailability } from "@/lib/db/ari-repo";
import { ariDaily, channelAriMessages, guests, inventoryDaily, ratePlans, reservationRooms, reservations, unitTypes } from "@/lib/db/schema";
import { ACK_MARGIN_MS } from "@/lib/db/ari-sync";
import { holdInventory, releaseInventory } from "@/lib/db/inventory-hold";
import { seedNk } from "@/lib/db/seed-nk";
import { MockEmailSender } from "@/lib/email/mock";
import type { AppEnv } from "@/lib/runtime/env";
import { log } from "@/lib/runtime/log";
import { createTestDb, type TestDb } from "@/tests/helpers/test-db";

const NOW = new Date("2026-11-27T02:00:05.123Z");
const TODAY = "2026-11-27";
const fixture = (name: string) => readFileSync(path.resolve(__dirname, "../fixtures/siteminder", name), "utf8");
const AVAIL = fixture("avail-notif-rq.xml");
const RATES = fixture("rate-amount-notif-rq.xml");
const THROUGH = fixture("avail-notif-stay-through-rq.xml");
const PASS = "Fake-Passw0rd!2026";

/** The SOAP header of the doc-sample fixtures (fake credentials), for messages built in the tests. */
const HEAD = AVAIL.slice(AVAIL.indexOf("<SOAP-ENV:Envelope"), AVAIL.indexOf("<OTA_HotelAvailNotifRQ"));
const TAIL = "</SOAP-ENV:Body></SOAP-ENV:Envelope>";
const OTA = 'xmlns="http://www.opentravel.org/OTA/2003/05" Version="1.0"';

type Sac = { start: string; end: string; room?: string; rate?: string };
const sac = (s: Sac) => `<StatusApplicationControl Start="${s.start}" End="${s.end}" InvTypeCode="${s.room ?? "MIXEDCUBE"}"${s.rate === "" ? "" : ` RatePlanCode="${s.rate ?? "DIRECTFLEX"}"`}/>`;
const availMsg = (s: Sac, inner = "", limit?: number | string) =>
  `<AvailStatusMessage${limit !== undefined ? ` BookingLimit="${limit}"` : ""}>${sac(s)}${inner}</AvailStatusMessage>`;
const availRq = (msgs: string[], o: { ts?: string | null; hotel?: string; echo?: string } = {}) =>
  `${HEAD}<OTA_HotelAvailNotifRQ ${OTA} EchoToken="${o.echo ?? "a-1"}"${o.ts === null ? "" : ` TimeStamp="${o.ts ?? "2026-11-27T02:00:00Z"}"`}>`
  + `<AvailStatusMessages HotelCode="${o.hotel ?? "NKHOSTEL"}">${msgs.join("")}</AvailStatusMessages></OTA_HotelAvailNotifRQ>${TAIL}`;
const amt = (amount: string, guests?: number, cur = "TWD") =>
  `<BaseByGuestAmt AgeQualifyingCode="10" AmountAfterTax="${amount}" CurrencyCode="${cur}"${guests !== undefined ? ` NumberOfGuests="${guests}"` : ""}/>`;
const rateMsg = (s: Sac, amounts: string[]) =>
  `<RateAmountMessage>${sac(s)}<Rates><Rate><BaseByGuestAmts>${amounts.join("")}</BaseByGuestAmts></Rate></Rates></RateAmountMessage>`;
const ratesRq = (msgs: string[], o: { ts?: string; hotel?: string } = {}) =>
  `${HEAD}<OTA_HotelRateAmountNotifRQ ${OTA} EchoToken="r-1" TimeStamp="${o.ts ?? "2026-11-27T02:00:00Z"}">`
  + `<RateAmountMessages HotelCode="${o.hotel ?? "NKHOSTEL"}">${msgs.join("")}</RateAmountMessages></OTA_HotelRateAmountNotifRQ>${TAIL}`;
const stopSell = (close: boolean, r?: "Arrival" | "Departure") => `<RestrictionStatus${r ? ` Restriction="${r}"` : ""} Status="${close ? "Close" : "Open"}"/>`;
const los = (...items: [type: string, time?: number][]) =>
  `<LengthsOfStay>${items.map(([t, n]) => `<LengthOfStay MinMaxMessageType="${t}"${n !== undefined ? ` Time="${n}"` : ""}/>`).join("")}</LengthsOfStay>`;

const post = (body: string) =>
  new Request("https://hotel.test/api/channel/siteminder", { method: "POST", body, headers: { "content-type": "text/xml; charset=utf-8", "cf-connecting-ip": "52.13.134.140" } });

async function setup(over: Partial<InboundDeps> = {}) {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  const deps: InboundDeps = { db, username: "fake-siteminder-user", password: PASS, ...over };
  const call = async (xml: string, now = NOW) => {
    const r = await handleSiteMinderInbound(deps, post(xml), now);
    return { status: r.status, text: await r.text() };
  };
  return { db, propertyId, deps, call };
}

const parse = (xml: string) =>
  new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false, parseAttributeValue: false, isArray: (n) => n === "Error" }).parse(xml);
const rsOf = (xml: string) => {
  const b = parse(xml)["SOAP-ENV:Envelope"]["SOAP-ENV:Body"];
  return b.OTA_HotelAvailNotifRS ?? b.OTA_HotelRateAmountNotifRS;
};
const envelope = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Header/><SOAP-ENV:Body>${inner}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;

async function ids(db: TestDb, room = "mixed-cube") {
  const [u] = await db.select().from(unitTypes).where(eq(unitTypes.slug, room));
  const [r] = await db.select().from(ratePlans).where(eq(ratePlans.slug, "direct-flex"));
  return { unitTypeId: u.id, ratePlanId: r.id };
}
async function rowsFor(db: TestDb, room = "mixed-cube") {
  const { unitTypeId } = await ids(db, room);
  const inv = await db.select().from(inventoryDaily).where(eq(inventoryDaily.unitTypeId, unitTypeId)).orderBy(inventoryDaily.date);
  const ari = await db.select().from(ariDaily).where(eq(ariDaily.unitTypeId, unitTypeId)).orderBy(ariDaily.date);
  return { inv, ari, byDate: new Map(ari.map((a) => [a.date, a])) };
}
async function counts(db: TestDb) {
  return { inv: (await db.select().from(inventoryDaily)).length, ari: (await db.select().from(ariDaily)).length };
}

afterEach(() => vi.restoreAllMocks());

describe("OTA_HotelAvailNotifRQ (availability and restrictions)", () => {
  test("the doc sample applies: Success echoing EchoToken and the request TimeStamp; inclusive ranges expanded per day", async () => {
    const { db, call } = await setup();
    const r = await call(AVAIL);
    expect(r.status).toBe(200);
    expect(r.text).toBe(envelope(
      '<OTA_HotelAvailNotifRS xmlns="http://www.opentravel.org/OTA/2003/05" EchoToken="ed8835ff-6198-4f38-b589-3058397f677c" TimeStamp="2026-11-27T01:59:41+00:00" Version="1.0"><Success/></OTA_HotelAvailNotifRS>',
    ));
    const { inv, byDate } = await rowsFor(db);
    // Start=2026-12-05 End=2026-12-07: three days, both ends included.
    expect(inv.map((i) => [i.date, i.available])).toEqual([["2026-12-05", 10], ["2026-12-06", 10], ["2026-12-07", 10]]);
    const ts = Date.parse("2026-11-27T01:59:41Z");
    expect(inv.every((i) => i.source === "siteminder" && i.sourceTs === ts && i.syncedAt === NOW.getTime())).toBe(true);
    expect(byDate.get("2026-12-05")).toMatchObject({ stopSell: false, minStay: 1, maxStay: 3, closedToArrival: false, price: 0, restrictionsSourceTs: ts, priceSourceTs: null });
    expect(byDate.get("2026-12-06")).toMatchObject({ stopSell: false, closedToArrival: true, maxStay: null });
    expect(byDate.get("2026-12-07")).toMatchObject({ stopSell: false, closedToDeparture: true });
  });

  test("availability needs no rate plan: BookingLimit alone, without or with an unknown RatePlanCode, is per room type", async () => {
    const { db, call } = await setup();
    const r = await call(availRq([
      availMsg({ start: "2026-12-01", end: "2026-12-02", rate: "" }, "", 4),
      availMsg({ start: "2026-12-03", end: "2026-12-03", rate: "NOSUCHPLAN" }, "", 0),
    ]));
    expect(rsOf(r.text).Success).toBeDefined();
    const { inv, ari } = await rowsFor(db);
    expect(inv.map((i) => [i.date, i.available])).toEqual([["2026-12-01", 4], ["2026-12-02", 4], ["2026-12-03", 0]]);
    expect(ari).toHaveLength(0); // no rate row, so availability alone never makes a free room
  });

  test("every restriction type is stored: stop sell, CTA, CTD, min/max stay on arrival, Stay Through; a max without Time clears", async () => {
    const { db, call } = await setup();
    expect(rsOf((await call(THROUGH)).text).Success).toBeDefined();
    let { byDate } = await rowsFor(db);
    expect(byDate.get("2026-12-10")).toMatchObject({ minStayThrough: 2, maxStayThrough: 4 });
    expect(byDate.get("2026-12-11")).toMatchObject({ minStayThrough: 2, maxStayThrough: 4 });

    await call(availRq([
      availMsg({ start: "2026-12-10", end: "2026-12-10" }, stopSell(true)),
      availMsg({ start: "2026-12-10", end: "2026-12-10" }, los(["SetMinLOS", 2], ["SetMaxLOS", 5])),
      availMsg({ start: "2026-12-11", end: "2026-12-11" }, los(["SetForwardMaxStay"])),
    ], { ts: "2026-11-27T02:00:01Z" }));
    ({ byDate } = await rowsFor(db));
    expect(byDate.get("2026-12-10")).toMatchObject({ stopSell: true, minStay: 2, maxStay: 5, minStayThrough: 2, maxStayThrough: 4 });
    expect(byDate.get("2026-12-11")).toMatchObject({ minStayThrough: 2, maxStayThrough: null });

    await call(availRq([availMsg({ start: "2026-12-10", end: "2026-12-10" }, stopSell(false) + los(["SetMaxLOS"]))], { ts: "2026-11-27T02:00:02Z" }));
    ({ byDate } = await rowsFor(db));
    expect(byDate.get("2026-12-10")).toMatchObject({ stopSell: false, maxStay: null, minStay: 2 });
  });

  test("unsupported restriction types are ignored and the rest applies (Success)", async () => {
    const { db, call } = await setup();
    const r = await call(availRq([availMsg({ start: "2026-12-01", end: "2026-12-01" },
      '<RestrictionStatus Restriction="Master" Status="Close"/>' + los(["SetSomethingElse", 3], ["SetMinLOS", 2]), 3)]));
    expect(rsOf(r.text).Success).toBeDefined();
    const { inv, byDate } = await rowsFor(db);
    expect(inv[0].available).toBe(3);
    expect(byDate.get("2026-12-01")).toMatchObject({ minStay: 2, stopSell: false });
  });
});

describe("OTA_HotelRateAmountNotifRQ (rates)", () => {
  test("the doc sample applies: the included-occupancy amount is the night's price; the single-guest discount and extra guests are ignored", async () => {
    const { db, call } = await setup();
    const r = await call(RATES);
    expect(r.text).toBe(envelope(
      '<OTA_HotelRateAmountNotifRS xmlns="http://www.opentravel.org/OTA/2003/05" EchoToken="5f0c3a52-1b7e-4c2a-9d1e-2a3b4c5d6e7f" TimeStamp="2026-11-27T01:59:43+00:00" Version="1.0"><Success/></OTA_HotelRateAmountNotifRS>',
    ));
    const { ari } = await rowsFor(db);
    expect(ari.map((a) => [a.date, a.price])).toEqual([["2026-12-05", 2400], ["2026-12-06", 2400], ["2026-12-07", 2400]]);
    expect(ari.every((a) => a.priceSourceTs === Date.parse("2026-11-27T01:59:43Z") && a.restrictionsSourceTs === null)).toBe(true);
  });

  test("an amount without NumberOfGuests is the price; decimals round to whole TWD", async () => {
    const { db, call } = await setup();
    expect(rsOf((await call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-01" }, [amt("2099.50")])]))).text).Success).toBeDefined();
    expect((await rowsFor(db)).ari[0].price).toBe(2100);
  });

  test("restrictions before rates are kept; the night is sold only once its rate arrives", async () => {
    const { db, propertyId, call } = await setup();
    const q = { propertyId, checkIn: "2026-12-01", checkOut: "2026-12-02", adults: 2, today: TODAY };
    await call(availRq([availMsg({ start: "2026-12-01", end: "2026-12-01" }, stopSell(false) + los(["SetMinLOS", 1]), 2)]));
    expect(await searchAvailability(db, q)).toEqual({ ok: true, offers: [] });
    await call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-01" }, [amt("2000.00", 2)])]));
    const s = await searchAvailability(db, q);
    expect(s.ok && s.offers.map((o) => [o.unitType.slug, o.nightlyPrices])).toEqual([["mixed-cube", [2000]]]);
  });

  test("PDP included occupancy other than the room type's → the docs' 137 error; only price 0 is written", async () => {
    const { db, call } = await setup();
    const r = await call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-01" }, [amt("2000.00", 3)])]));
    expect(rsOf(r.text).Errors.Error).toEqual([{ "@Type": "12", "@Code": "137", "#text": "Invalid included occupancy: expecting 2" }]);
    expect((await db.select().from(ariDaily)).map((a) => a.price)).toEqual([0]);
    expect((await db.select().from(inventoryDaily))).toHaveLength(0);
  });

  test("137 for a known room + rate also sets those days' price to 0, so stale prices stop selling", async () => {
    const { db, call } = await setup();
    await call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-03" }, [amt("2000.00", 2)])], { ts: "2026-11-27T01:00:00Z" }));
    const r = await call(ratesRq([rateMsg({ start: "2026-12-02", end: "2026-12-03" }, [amt("2000.00", 3)])]));
    expect(rsOf(r.text).Errors.Error[0]["@Code"]).toBe("137");
    expect((await rowsFor(db)).ari.map((a) => [a.date, a.price])).toEqual([["2026-12-01", 2000], ["2026-12-02", 0], ["2026-12-03", 0]]);
    expect((await db.select().from(channelAriMessages)).at(-1)).toMatchObject({ outcome: "rejected", errorCode: 137 });
  });

  test.each([
    ["a zero price", amt("0.00")],
    ["a negative price", amt("-10")],
    ["a price that rounds to 0", amt("0.40")],
    ["an amount that is not a number", amt("abc")],
  ])("%s → Success, the day stored with price 0 (never sold), a warning", async (_l, bad) => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const { db, call } = await setup();
    await call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-01" }, [amt("2000.00")])], { ts: "2026-11-27T01:00:00Z" }));
    const r = await call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-01" }, [bad]), rateMsg({ start: "2026-12-02", end: "2026-12-02" }, [amt("2100.00")])]));
    expect(rsOf(r.text).Success).toBeDefined();
    expect((await rowsFor(db)).ari.map((a) => [a.date, a.price])).toEqual([["2026-12-01", 0], ["2026-12-02", 2100]]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/RateAmountMessage\[1\] AmountAfterTax .*: price 0/);
    expect((await db.select().from(channelAriMessages)).at(-1)).toMatchObject({ outcome: "applied", degradedRows: 1 });
  });

  test("a CurrencyCode other than the property's → Success, price 0 for those days (the amount is never stored), ops alerted", async () => {
    const email = new MockEmailSender();
    const s = await setup();
    s.deps.ops = { db: s.db, email, opsEmails: ["ops@nk.test"], environment: "production" };
    const r = await s.call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-02" }, [amt("95.00", undefined, "EUR")])]));
    expect(rsOf(r.text).Success).toBeDefined();
    expect((await rowsFor(s.db)).ari.map((a) => a.price)).toEqual([0, 0]);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].text).toContain("CurrencyCode other than TWD");
  });

  test("several amounts without NumberOfGuests: the first is used, with a warning", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const { db, call } = await setup();
    expect(rsOf((await call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-01" }, [amt("2200"), amt("2300")])]))).text).Success).toBeDefined();
    expect((await rowsFor(db)).ari[0].price).toBe(2200);
    expect(warn.mock.calls.flat().join(" ")).toContain("2 amounts for the included occupancy: the first is used");
  });

  test("no amount at all → 321, nothing applied", async () => {
    const { db, call } = await setup();
    const r = await call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-01" }, [])]));
    expect(rsOf(r.text).Errors.Error[0]["#text"]).toBe("Required field missing: RateAmountMessage[1]/Rates/Rate/BaseByGuestAmts/BaseByGuestAmt");
    expect(await counts(db)).toEqual({ inv: 0, ari: 0 });
  });
});

describe("whole-message validation", () => {
  const UNKNOWN_ROOM_RS = (rs: string, ts: string, echo: string) => envelope(
    `<${rs} xmlns="http://www.opentravel.org/OTA/2003/05" EchoToken="${echo}" TimeStamp="${ts}" Version="1.0"><Errors><Error Type="12" Code="402">Room type code not found for this hotel</Error></Errors></${rs}>`);

  test("unknown room type code → exactly the docs' 402 error, and nothing of the message is applied", async () => {
    const { db, call } = await setup();
    const r = await call(availRq([
      availMsg({ start: "2026-12-01", end: "2026-12-03" }, stopSell(true), 5),
      availMsg({ start: "2026-12-01", end: "2026-12-03", room: "NOSUCHROOM" }, "", 5),
    ]));
    expect(r.status).toBe(200);
    expect(r.text).toBe(UNKNOWN_ROOM_RS("OTA_HotelAvailNotifRS", "2026-11-27T02:00:00Z", "a-1"));
    expect(await counts(db)).toEqual({ inv: 0, ari: 0 });
    const rates = await call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-01", room: "NOSUCHROOM" }, [amt("2000.00")])]));
    expect(rates.text).toBe(UNKNOWN_ROOM_RS("OTA_HotelRateAmountNotifRS", "2026-11-27T02:00:00Z", "r-1"));
  });

  test("unknown rate plan code → exactly the docs' 249 error, nothing applied (SITEMINDER-OPEN-Q6: whole message)", async () => {
    const { db, call } = await setup();
    const err = '<Errors><Error Type="12" Code="249">Rate code not found for this hotel</Error></Errors>';
    const a = await call(availRq([
      availMsg({ start: "2026-12-01", end: "2026-12-01" }, stopSell(true), 5),
      availMsg({ start: "2026-12-01", end: "2026-12-01", rate: "NOSUCHPLAN" }, stopSell(true)),
    ]));
    expect(a.text).toBe(envelope(`<OTA_HotelAvailNotifRS xmlns="http://www.opentravel.org/OTA/2003/05" EchoToken="a-1" TimeStamp="2026-11-27T02:00:00Z" Version="1.0">${err}</OTA_HotelAvailNotifRS>`));
    const b = await call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-01" }, [amt("1.00")]), rateMsg({ start: "2026-12-01", end: "2026-12-01", rate: "NOSUCHPLAN" }, [amt("1.00")])]));
    expect(b.text).toBe(envelope(`<OTA_HotelRateAmountNotifRS xmlns="http://www.opentravel.org/OTA/2003/05" EchoToken="r-1" TimeStamp="2026-11-27T02:00:00Z" Version="1.0">${err}</OTA_HotelRateAmountNotifRS>`));
    expect(await counts(db)).toEqual({ inv: 0, ari: 0 });
  });

  test("unknown HotelCode → the docs' 392 error", async () => {
    const { call } = await setup();
    const r = rsOf((await call(availRq([availMsg({ start: "2026-12-01", end: "2026-12-01" }, "", 1)], { hotel: "NOPE" }))).text);
    expect(r.Errors.Error).toEqual([{ "@Type": "6", "@Code": "392", "#text": "Hotel not found for HotelCode=NOPE" }]);
  });

  test(`a range of ${ARI_MAX_SPAN_DAYS} days applies; one day more is refused and nothing is applied`, async () => {
    const { db, call } = await setup();
    const ok = await call(availRq([availMsg({ start: "2026-12-01", end: "2028-12-19" }, "", 2)]));
    expect(rsOf(ok.text).Success).toBeDefined();
    expect((await counts(db)).inv).toBe(750);
    const { db: db2, call: call2 } = await setup();
    const r = await call2(availRq([availMsg({ start: "2026-12-01", end: "2026-12-01" }, "", 2), availMsg({ start: "2026-12-01", end: "2028-12-20" }, "", 2)]));
    expect(rsOf(r.text).Errors.Error).toEqual([{ "@Type": "3", "@Code": "450", "#text": "Unable to process: AvailStatusMessage[2] spans 751 days (at most 750)" }]);
    expect(await counts(db2)).toEqual({ inv: 0, ari: 0 });
  });

  test.each([
    ["End before Start", availMsg({ start: "2026-12-03", end: "2026-12-01" }, "", 1), "Unable to process: AvailStatusMessage[2] End 2026-12-01 is before Start 2026-12-03"],
    ["an impossible date", availMsg({ start: "2026-02-30", end: "2026-03-01" }, "", 1), "Unable to process: AvailStatusMessage[2] date 2026-02-30"],
    ["a min LOS without Time", availMsg({ start: "2026-12-01", end: "2026-12-01" }, los(["SetMinLOS"])), "Required field missing: AvailStatusMessage[2]/LengthOfStay/@Time"],
    ["a restriction without RatePlanCode", availMsg({ start: "2026-12-01", end: "2026-12-01", rate: "" }, stopSell(true)), "Required field missing: AvailStatusMessage[2]/StatusApplicationControl/@RatePlanCode"],
    ["no InvTypeCode", '<AvailStatusMessage BookingLimit="1"><StatusApplicationControl Start="2026-12-01" End="2026-12-01"/></AvailStatusMessage>', "Required field missing: AvailStatusMessage[2]/StatusApplicationControl/@InvTypeCode"],
  ])("%s → an error, nothing applied", async (_l, bad, text) => {
    const { db, call } = await setup();
    const r = await call(availRq([availMsg({ start: "2026-12-01", end: "2026-12-05" }, stopSell(true), 3), bad]));
    expect(rsOf(r.text).Errors.Error[0]["#text"]).toBe(text);
    expect(await counts(db)).toEqual({ inv: 0, ari: 0 });
  });

  test("unusable values are degraded, not refused (a refusal blocks the hotel's ARI queue): Success, safe values, warnings", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const { db, call } = await setup();
    const r = await call(availRq([
      availMsg({ start: "2026-12-01", end: "2026-12-01", rate: "" }, "", "-1"),
      availMsg({ start: "2026-12-02", end: "2026-12-02", rate: "" }, "", "1.5"),
      availMsg({ start: "2026-12-03", end: "2026-12-03" }, '<RestrictionStatus Status="Shut"/>'),
      availMsg({ start: "2026-12-04", end: "2026-12-04" }, los(["SetMinLOS", 0], ["SetMaxLOS", 3])),
    ]));
    expect(rsOf(r.text).Success).toBeDefined();
    const { inv, byDate } = await rowsFor(db);
    expect(inv.map((i) => [i.date, i.available])).toEqual([["2026-12-01", 0], ["2026-12-02", 0]]);
    expect(byDate.get("2026-12-03")!.stopSell).toBe(true);
    expect(byDate.get("2026-12-04")).toMatchObject({ minStay: 1, maxStay: 3 });
    const text = warn.mock.calls.flat().join(" ");
    expect(text).toContain("BookingLimit -1 read as 0");
    expect(text).toContain("RestrictionStatus Status Shut read as Close");
    expect(text).toContain("SetMinLOS Time 0 ignored");
    expect((await db.select().from(channelAriMessages))[0]).toMatchObject({ outcome: "applied", degradedRows: 4 });
  });

  test("an auth failure on an ARI message answers 448 echoing the request's EchoToken and TimeStamp, and applies nothing", async () => {
    const { db, call } = await setup();
    const r = await call(AVAIL.replace(PASS, "Wrong-Passw0rd!2026"));
    expect(r.text).toBe(envelope(
      '<OTA_HotelAvailNotifRS xmlns="http://www.opentravel.org/OTA/2003/05" EchoToken="ed8835ff-6198-4f38-b589-3058397f677c" TimeStamp="2026-11-27T01:59:41+00:00" Version="1.0"><Errors><Error Type="4" Code="448">Invalid Username and/or Password</Error></Errors></OTA_HotelAvailNotifRS>',
    ));
    const rates = rsOf((await call(RATES.replace(PASS, "x"))).text);
    expect(rates).toMatchObject({ "@EchoToken": "5f0c3a52-1b7e-4c2a-9d1e-2a3b4c5d6e7f", "@TimeStamp": "2026-11-27T01:59:43+00:00" });
    expect(await counts(db)).toEqual({ inv: 0, ari: 0 });
    expect(await db.select().from(channelAriMessages)).toHaveLength(0);
  });
});

describe("ordering by TimeStamp (SITEMINDER-OPEN-Q5)", () => {
  test("an older message is ignored per day; equal or newer applies", async () => {
    const { db, call } = await setup();
    // Newer first: days 1–3.
    await call(availRq([availMsg({ start: "2026-12-01", end: "2026-12-03" }, stopSell(true) + los(["SetMinLOS", 3]), 5)], { ts: "2026-11-27T01:00:10Z" }));
    await call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-03" }, [amt("3000")])], { ts: "2026-11-27T01:00:10Z" }));
    // Then an older one for days 2–4: only day 4 (never set) changes.
    const old = await call(availRq([availMsg({ start: "2026-12-02", end: "2026-12-04" }, stopSell(false) + los(["SetMinLOS", 1]), 9)], { ts: "2026-11-27T01:00:05Z" }));
    expect(rsOf(old.text).Success).toBeDefined(); // ignored days are not an error
    await call(ratesRq([rateMsg({ start: "2026-12-02", end: "2026-12-04" }, [amt("1000")])], { ts: "2026-11-27T01:00:05Z" }));
    let { inv, byDate } = await rowsFor(db);
    expect(inv.map((i) => i.available)).toEqual([5, 5, 5, 9]);
    expect([...byDate.values()].map((a) => [a.date, a.stopSell, a.minStay, a.price])).toEqual([
      ["2026-12-01", true, 3, 3000], ["2026-12-02", true, 3, 3000], ["2026-12-03", true, 3, 3000], ["2026-12-04", false, 1, 1000],
    ]);
    // Same TimeStamp as the stored one: applied (≥).
    await call(availRq([availMsg({ start: "2026-12-02", end: "2026-12-02" }, stopSell(false), 7)], { ts: "2026-11-27T01:00:10Z" }));
    ({ inv, byDate } = await rowsFor(db));
    expect(inv[1].available).toBe(7);
    expect(byDate.get("2026-12-02")!.stopSell).toBe(false);
  });

  test("rates and restrictions are ordered separately (separate SiteMinder messages)", async () => {
    const { db, call } = await setup();
    await call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-01" }, [amt("3000")])], { ts: "2026-11-27T01:00:10Z" }));
    await call(availRq([availMsg({ start: "2026-12-01", end: "2026-12-01" }, stopSell(true))], { ts: "2026-11-27T01:00:05Z" }));
    expect((await rowsFor(db)).ari[0]).toMatchObject({ price: 3000, stopSell: true });
  });

  test("orderingTs: the TimeStamp in ms; missing or unreadable = now; far future clamped", () => {
    expect(orderingTs("2026-11-27T01:00:00Z", NOW)).toBe(Date.parse("2026-11-27T01:00:00Z"));
    expect(orderingTs("2026-11-27T09:00:00+08:00", NOW)).toBe(Date.parse("2026-11-27T01:00:00Z"));
    expect(orderingTs("2026-11-27T09:00:00+0800", NOW)).toBe(Date.parse("2026-11-27T01:00:00Z"));
    expect(orderingTs("2026-11-27T01:00:00.123456Z", NOW)).toBe(Date.parse("2026-11-27T01:00:00.123Z"));
    expect(orderingTs("2026-11-27T01:00:00", NOW)).toBe(Date.parse("2026-11-27T01:00:00Z"));
    expect(orderingTs(undefined, NOW)).toBe(NOW.getTime());
    expect(orderingTs("yesterday", NOW)).toBe(NOW.getTime());
    expect(orderingTs("2099-01-01T00:00:00Z", NOW)).toBe(NOW.getTime() + ARI_MAX_FUTURE_SKEW_MS);
  });

  test("a message without TimeStamp is ordered as now (and its RS carries our time)", async () => {
    const { db, call } = await setup();
    const r = rsOf((await call(availRq([availMsg({ start: "2026-12-01", end: "2026-12-01" }, "", 2)], { ts: null }))).text);
    expect(r["@TimeStamp"]).toBe("2026-11-27T02:00:05Z");
    expect((await rowsFor(db)).inv[0].sourceTs).toBe(NOW.getTime());
  });
});

describe("restrictions take effect in the guest search and quote", () => {
  async function priced() {
    const s = await setup();
    // 2026-12-01 .. 2026-12-10 priced and open for MIXEDCUBE / DIRECTFLEX.
    await s.call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-10" }, [amt("2000", 2)])], { ts: "2026-11-27T01:00:00Z" }));
    await s.call(availRq([availMsg({ start: "2026-12-01", end: "2026-12-10" }, stopSell(false), 3)], { ts: "2026-11-27T01:00:00Z" }));
    const search = async (checkIn: string, checkOut: string) => {
      const r = await searchAvailability(s.db, { propertyId: s.propertyId, checkIn, checkOut, adults: 2, today: TODAY });
      return r.ok ? r.offers.map((o) => o.unitType.slug) : r.error;
    };
    const restrict = (start: string, end: string, inner: string, ts = "2026-11-27T01:00:01Z") =>
      s.call(availRq([availMsg({ start, end }, inner)], { ts }));
    return { ...s, search, restrict };
  }

  test("open: offered", async () => {
    expect(await (await priced()).search("2026-12-02", "2026-12-04")).toEqual(["mixed-cube"]);
  });
  test("stop sell on any night of the stay", async () => {
    const p = await priced();
    await p.restrict("2026-12-03", "2026-12-03", stopSell(true));
    expect(await p.search("2026-12-02", "2026-12-04")).toEqual([]);
    expect(await p.search("2026-12-04", "2026-12-05")).toEqual(["mixed-cube"]);
  });
  test("closed to arrival: only on the arrival night", async () => {
    const p = await priced();
    await p.restrict("2026-12-03", "2026-12-03", stopSell(true, "Arrival"));
    expect(await p.search("2026-12-03", "2026-12-04")).toEqual([]);
    expect(await p.search("2026-12-02", "2026-12-04")).toEqual(["mixed-cube"]);
  });
  test("closed to departure: only on the check-out date", async () => {
    const p = await priced();
    await p.restrict("2026-12-04", "2026-12-04", stopSell(true, "Departure"));
    expect(await p.search("2026-12-02", "2026-12-04")).toEqual([]);
    expect(await p.search("2026-12-02", "2026-12-05")).toEqual(["mixed-cube"]);
  });
  test("min / max stay on arrival", async () => {
    const p = await priced();
    await p.restrict("2026-12-02", "2026-12-02", los(["SetMinLOS", 2], ["SetMaxLOS", 3]));
    expect(await p.search("2026-12-02", "2026-12-03")).toEqual([]);
    expect(await p.search("2026-12-02", "2026-12-04")).toEqual(["mixed-cube"]);
    expect(await p.search("2026-12-02", "2026-12-05")).toEqual(["mixed-cube"]);
    expect(await p.search("2026-12-02", "2026-12-06")).toEqual([]);
    expect(await p.search("2026-12-01", "2026-12-02")).toEqual(["mixed-cube"]); // another arrival night: no limit
  });
  test("Stay Through min / max on every night of the stay", async () => {
    const p = await priced();
    await p.restrict("2026-12-05", "2026-12-05", los(["SetForwardMinStay", 3], ["SetForwardMaxStay", 4]));
    expect(await p.search("2026-12-04", "2026-12-06")).toEqual([]); // 2 nights over 12-05
    expect(await p.search("2026-12-03", "2026-12-06")).toEqual(["mixed-cube"]); // 3
    expect(await p.search("2026-12-02", "2026-12-07")).toEqual([]); // 5
    expect(await p.search("2026-12-06", "2026-12-07")).toEqual(["mixed-cube"]); // does not cover 12-05
  });
  test("availability 0 (BookingLimit) is sold out", async () => {
    const p = await priced();
    await p.call(availRq([availMsg({ start: "2026-12-03", end: "2026-12-03", rate: "" }, "", 0)], { ts: "2026-11-27T01:00:02Z" }));
    expect(await p.search("2026-12-02", "2026-12-04")).toEqual([]);
  });
});

describe("observability", () => {
  const env = { ENVIRONMENT: "production", CHANNEL_MODE: "siteminder" } as unknown as AppEnv;

  test("each message is recorded (time, type, days, outcome, rejected codes) and /admin/system shows the last one and the rejected codes", async () => {
    const { db, call } = await setup();
    await call(AVAIL);
    let s = await getSystemStatus(db, env, { now: NOW });
    expect(s.ari.last).toEqual({ at: NOW.getTime(), messageType: "OTA_HotelAvailNotifRQ", days: 9, outcome: "applied", errorCode: null, errorText: null, staleRows: 0, degradedRows: 0 });
    expect(s.ari.rejectedCodes).toEqual([]);

    const later = new Date(NOW.getTime() + 60_000);
    await call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-02", rate: "OLDPLAN" }, [amt("1")])]), later);
    s = await getSystemStatus(db, env, { now: later });
    expect(s.ari.last).toEqual({ at: later.getTime(), messageType: "OTA_HotelRateAmountNotifRQ", days: 2, outcome: "rejected", errorCode: 249, errorText: "Rate code not found for this hotel", staleRows: 0, degradedRows: 0 });
    // An older resend: its days are skipped and counted.
    const older = new Date(later.getTime() + 60_000);
    await call(availRq([availMsg({ start: "2026-12-05", end: "2026-12-06" }, "", 1)], { ts: "2026-11-27T01:00:00Z" }), older);
    expect((await getSystemStatus(db, env, { now: older })).ari.last).toMatchObject({ outcome: "applied", days: 2, staleRows: 2 });
    expect(s.ari.rejectedCodes).toEqual([{ kind: "rate", code: "OLDPLAN", at: later.getTime() }]);
    expect(s.ari.rejected24h).toBe(1);
  });

  test("logs carry no XML and no credentials", async () => {
    const lines: string[] = [];
    for (const m of ["info", "warn", "error"] as const) vi.spyOn(log, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    const { call } = await setup();
    await call(AVAIL);
    await call(availRq([availMsg({ start: "2026-12-01", end: "2026-12-01", room: "NOSUCHROOM" }, "", 1)]));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toMatch(/<|Fake-Passw0rd|fake-siteminder-user/);
    expect(lines.join("\n")).toContain("room:NOSUCHROOM");
  });

  test("402 / 249 / 137 alert ops at once (deduped hourly)", async () => {
    const email = new MockEmailSender();
    const deferred: Promise<unknown>[] = [];
    const s = await setup({ defer: (p) => void deferred.push(p) });
    s.deps.ops = { db: s.db, email, opsEmails: ["ops@nk.test"], environment: "production" };
    await s.call(availRq([availMsg({ start: "2026-12-01", end: "2026-12-01", room: "NOSUCHROOM" }, "", 1)]));
    await Promise.all(deferred);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].text).toContain("房型 NOSUCHROOM");
    await s.call(ratesRq([rateMsg({ start: "2026-12-01", end: "2026-12-01" }, [amt("1", 3)])]), new Date(NOW.getTime() + 60_000));
    await Promise.all(deferred);
    expect(email.sent).toHaveLength(1); // same key within the hour
  });

  test(`${ARI_REJECTION_ALERT_COUNT} rejections of any kind within an hour alert ops once (deduped hourly)`, async () => {
    const email = new MockEmailSender();
    const deferred: Promise<unknown>[] = [];
    const s = await setup({ defer: (p) => void deferred.push(p) });
    s.deps.ops = { db: s.db, email, opsEmails: ["ops@nk.test"], environment: "production" };
    const bad = availRq([availMsg({ start: "2026-12-03", end: "2026-12-01" }, "", 1)]);
    for (let i = 0; i < ARI_REJECTION_ALERT_COUNT - 1; i++) await s.call(bad, new Date(NOW.getTime() + i * 120_000));
    await Promise.all(deferred);
    expect(email.sent).toHaveLength(0);
    for (let i = ARI_REJECTION_ALERT_COUNT - 1; i < ARI_REJECTION_ALERT_COUNT + 2; i++) await s.call(bad, new Date(NOW.getTime() + i * 120_000));
    await Promise.all(deferred);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].text).toContain("messages rejected in the last hour");
  });

  test("a TimeStamp far ahead of our clock is clamped with a warning", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const { db, call } = await setup();
    await call(availRq([availMsg({ start: "2026-12-01", end: "2026-12-01" }, "", 1)], { ts: "2099-01-01T00:00:00Z" }));
    expect(warn.mock.calls.flat().join(" ")).toContain("is more than 10 min ahead of our clock: clamped");
    expect((await rowsFor(db)).inv[0].sourceTs).toBe(NOW.getTime() + ARI_MAX_FUTURE_SKEW_MS);
  });
});

describe("BookingLimit keeps our rooms SiteMinder has not counted (local holds, unacknowledged bookings)", () => {
  const TS = "2026-11-27T02:00:00Z";
  const tsMs = Date.parse(TS);
  type Res = Partial<typeof reservations.$inferInsert> & { rooms?: number };
  async function book(db: TestDb, propertyId: string, o: Res = {}) {
    const { rooms = 1, ...over } = o;
    const guestId = crypto.randomUUID();
    await db.insert(guests).values({ id: guestId, propertyId, firstName: "A", lastName: "B", email: "a@b.test", phone: "1", country: "TW", locale: "en", createdAt: 0 });
    const id = crypto.randomUUID();
    await db.insert(reservations).values({
      id, propertyId, code: `NK-${id.slice(0, 6).toUpperCase()}`, guestId, status: "confirmed", channel: "direct",
      checkIn: "2026-12-01", checkOut: "2026-12-03", adults: 2, locale: "en", quote: {}, totalAmount: 4000,
      syncState: "pending", holdExpiresAt: 1, guestEmailLower: "a@b.test", createdAt: 0, updatedAt: 0, ...over,
    });
    const { unitTypeId, ratePlanId } = await ids(db);
    for (let i = 0; i < rooms; i++)
      await db.insert(reservationRooms).values({ id: crypto.randomUUID(), reservationId: id, unitTypeId, ratePlanId, nightlyPrices: [2000, 2000] });
    return id;
  }
  const limit = (call: (x: string) => Promise<unknown>, n: number, ts = TS) =>
    call(availRq([availMsg({ start: "2026-12-01", end: "2026-12-03", rate: "" }, "", n)], { ts }));
  const avail = async (db: TestDb) => (await rowsFor(db)).inv.map((i) => i.available);

  test("a hold: L − 1 (and sm_available = L); after the hold expires and is released, L — no phantom room", async () => {
    const { db, propertyId, call } = await setup();
    await limit(call, 5, "2026-11-27T01:00:00Z");
    const { unitTypeId, ratePlanId } = await ids(db);
    const nights = ["2026-12-01", "2026-12-02"];
    expect(await holdInventory(db, [{ unitTypeId, ratePlanId, nights, rooms: 1 }])).toEqual({ ok: true });
    const id = await book(db, propertyId, { status: "pending_payment", syncState: "not_required", holdExpiresAt: NOW.getTime() + 600_000 });
    await limit(call, 5);
    expect(await avail(db)).toEqual([4, 4, 5]); // the check-out date is not a night of the stay
    expect((await rowsFor(db)).inv.map((i) => i.smAvailable)).toEqual([5, 5, 5]);
    // The hold expires (lib/jobs/expire-holds.ts): status expired, hold cleared, rooms released.
    await db.update(reservations).set({ status: "expired", holdExpiresAt: null }).where(eq(reservations.id, id));
    await releaseInventory(db, [{ unitTypeId, ratePlanId, nights, rooms: 1 }]);
    expect(await avail(db)).toEqual([5, 5, 5]);
    await limit(call, 5, "2026-11-27T02:00:01Z");
    expect(await avail(db)).toEqual([5, 5, 5]);
  });

  test("paid, not confirmed yet (hold): L − 1", async () => {
    const { db, propertyId, call } = await setup();
    await book(db, propertyId, { status: "paid_pending_confirm", syncState: "not_required" });
    await limit(call, 5);
    expect(await avail(db)).toEqual([4, 4, 5]);
  });

  test.each([
    ["sync pending", { syncState: "pending" }, 4],
    ["sync failed", { syncState: "failed" }, 4],
    ["acknowledged after the message was generated", { syncState: "synced", channelSyncedAt: tsMs + 60_000 }, 4],
    ["acknowledged less than the margin before it", { syncState: "synced", channelSyncedAt: tsMs - ACK_MARGIN_MS + 1000 }, 4],
    ["acknowledged well before it (SiteMinder counted it)", { syncState: "synced", channelSyncedAt: tsMs - ACK_MARGIN_MS - 1000 }, 5],
    ["from SiteMinder itself (an OTA booking)", { channel: "siteminder_ota", syncState: "not_required" }, 5],
    ["cancelled (rooms released)", { status: "cancelled", syncState: "pending", holdExpiresAt: null }, 5],
  ] as const)("confirmed, %s → %s", async (_l, over, expected) => {
    const { db, propertyId, call } = await setup();
    await book(db, propertyId, over as Res);
    await limit(call, 5);
    expect((await avail(db))[0]).toBe(expected);
  });

  test("two rooms in one booking count twice; never below 0", async () => {
    const { db, propertyId, call } = await setup();
    await book(db, propertyId, { rooms: 2 });
    await limit(call, 5);
    expect(await avail(db)).toEqual([3, 3, 5]);
    await limit(call, 1, "2026-11-27T02:00:01Z");
    expect(await avail(db)).toEqual([0, 0, 1]);
    expect((await rowsFor(db)).inv[0].smAvailable).toBe(1);
  });
});

describe("performance: a 210-day × 8-room message", () => {
  const ROOMS = ["MIXEDCUBE", "FEMALECUBE", "BUDDYROOM", "BUDDYROOMSIX", "MINIROOM", "CLASSICROOM", "DELUXEROOM", "CONNECTINGROOM"];
  const DAYS = 210;
  const dates = (i: number) => {
    const t = Date.parse("2026-12-01T00:00:00Z") + i * 86_400_000;
    return new Date(t).toISOString().slice(0, 10);
  };
  /** As SiteMinder batches it: 30 date elements of 7 days per room type [AR]. */
  const ranges = () => Array.from({ length: DAYS / 7 }, (_, k) => ({ start: dates(k * 7), end: dates(k * 7 + 6) }));

  test("availability + restrictions, then rates: every day row stored, one D1 batch each, well inside 1–2 s", async () => {
    const { db, call } = await setup();
    const occ = new Map((await db.select().from(unitTypes)).map((u) => [u.smRoomCode, u.maxOccupancy]));
    const avail = availRq(ROOMS.flatMap((room) => ranges().map((r) => availMsg({ ...r, room }, stopSell(false) + stopSell(false, "Arrival") + los(["SetMinLOS", 1], ["SetMaxLOS", 14]), 4))));
    const rates = ratesRq(ROOMS.flatMap((room) => ranges().map((r) => rateMsg({ ...r, room }, [amt("2500.00", occ.get(room)!)]))));
    expect(avail.length).toBeLessThan(1_000_000);

    // runAtomic opens one better-sqlite3 transaction per batch (one D1 batch in production).
    const tx = vi.spyOn(db, "transaction");

    let t = performance.now();
    const a = await call(avail);
    const availMs = performance.now() - t;
    t = performance.now();
    const b = await call(rates);
    const ratesMs = performance.now() - t;

    expect(rsOf(a.text).Success).toBeDefined();
    expect(rsOf(b.text).Success).toBeDefined();
    expect(await counts(db)).toEqual({ inv: DAYS * ROOMS.length, ari: DAYS * ROOMS.length });
    const priced = await db.select().from(ariDaily).where(and(eq(ariDaily.price, 2500), eq(ariDaily.maxStay, 14)));
    expect(priced).toHaveLength(DAYS * ROOMS.length);
    // One atomic batch per message, the message log included.
    expect(tx).toHaveBeenCalledTimes(2);
    console.log(`ARI perf: availability+restrictions ${availMs.toFixed(0)} ms, rates ${ratesMs.toFixed(0)} ms for ${DAYS * ROOMS.length} day rows each`);
    expect(availMs).toBeLessThan(2000);
    expect(ratesMs).toBeLessThan(2000);
  });
});
