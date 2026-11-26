import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HANDLERS, handleSiteMinderInbound, MAX_BODY_BYTES, sameSecret, type InboundDeps } from "@/lib/channel/siteminder/inbound/dispatch";
import { uniqueNames } from "@/lib/channel/siteminder/inbound/rooms-and-rates";
import { ratePlans, unitTypes } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import { rsEcho } from "@/lib/channel/siteminder/inbound/soap";
import { log } from "@/lib/runtime/log";
import { createTestDb } from "@/tests/helpers/test-db";

const NOW = new Date("2026-11-27T02:00:05.123Z");
const USER = "fake-siteminder-user";
const PASS = "Fake-Passw0rd!2026";
const fixture = (name: string) => readFileSync(path.resolve(__dirname, "../fixtures/siteminder", name), "utf8");
const RR = fixture("rooms-and-rates-rq.xml");

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://hotel.test/api/channel/siteminder", {
    method: "POST", body, headers: { "content-type": "text/xml; charset=utf-8", "cf-connecting-ip": "52.13.134.140", ...headers },
  });

async function setup(over: Partial<InboundDeps> = {}) {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  const deps: InboundDeps = { db, username: USER, password: PASS, ...over };
  return { db, propertyId, deps, call: (body: string, h?: Record<string, string>) => handleSiteMinderInbound(deps, post(body, h), NOW) };
}

/** Parse a response keeping namespace prefixes, every repeatable element as an array (XPath-like access). */
const parse = (xml: string) =>
  new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false, parseAttributeValue: false, isArray: (n) => ["RoomStay", "Error"].includes(n) })
    .parse(xml);
const body = (xml: string) => parse(xml)["SOAP-ENV:Envelope"]["SOAP-ENV:Body"];

const AUTH_FAULT_BODY =
  '<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Header/><SOAP-ENV:Body>'
  + '<OTA_HotelAvailRS xmlns="http://www.opentravel.org/OTA/2003/05" EchoToken="879791878" TimeStamp="2026-11-27T02:00:05Z" Version="1.0">'
  + '<Errors><Error Type="4" Code="448">Invalid Username and/or Password</Error></Errors></OTA_HotelAvailRS></SOAP-ENV:Body></SOAP-ENV:Envelope>';

afterEach(() => vi.restoreAllMocks());

describe("authentication", () => {
  test("correct credentials: the request is handled", async () => {
    const r = await (await setup()).call(RR);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/xml; charset=utf-8");
    expect(body(await r.text()).OTA_HotelAvailRS.Success).toBeDefined();
  });

  test.each([
    ["wrong password", RR.replace(PASS, "Wrong-Passw0rd!2026")],
    ["wrong username", RR.replace(USER, "someone-else")],
    ["no Security header", RR.replace(/<SOAP-ENV:Header>[\s\S]*<\/SOAP-ENV:Header>/, "<SOAP-ENV:Header/>")],
    ["a password type other than PasswordText", RR.replace("#PasswordText", "#PasswordDigest")],
  ])("%s → exactly the docs' Type 4 / Code 448 error, HTTP 200", async (_label, xml) => {
    const r = await (await setup()).call(xml);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(AUTH_FAULT_BODY);
  });

  test.each([
    ["both unset", { username: undefined, password: undefined }],
    ["password unset", { password: undefined }],
    ["both empty", { username: "", password: "" }],
  ])("inbound secrets %s → every request is refused, even with empty credentials sent", async (_l, over) => {
    const s = await setup(over);
    expect(await (await s.call(RR)).text()).toBe(AUTH_FAULT_BODY);
    const empty = RR.replace(USER, "").replace(PASS, "");
    expect(await (await s.call(empty)).text()).toBe(AUTH_FAULT_BODY);
  });

  test("a Password without a Type attribute is read as PasswordText", async () => {
    const r = await (await setup()).call(RR.replace(/ Type="[^"]*#PasswordText"/, ""));
    expect(body(await r.text()).OTA_HotelAvailRS.Success).toBeDefined();
  });

  test("with several UsernameTokens only the first counts", async () => {
    const token = (u: string, p: string) => `<wsse:UsernameToken><wsse:Username>${u}</wsse:Username><wsse:Password>${p}</wsse:Password></wsse:UsernameToken>`;
    const withTokens = (...ts: string[]) => RR.replace(/<wsse:UsernameToken>[\s\S]*<\/wsse:UsernameToken>/, ts.join(""));
    const s = await setup();
    expect(await (await s.call(withTokens(token("intruder", "x"), token(USER, PASS)))).text()).toBe(AUTH_FAULT_BODY);
    expect(body(await (await s.call(withTokens(token(USER, PASS), token("intruder", "x")))).text()).OTA_HotelAvailRS.Success).toBeDefined();
  });

  test("CDATA is taken literally; plain text is entity-decoded exactly once", async () => {
    const s = await setup({ password: "Fake&amp;Pass!2026" });
    const pw = (inner: string) => RR.replace(`>${PASS}<`, `>${inner}<`);
    const ok = async (xml: string) => (await (await s.call(xml)).text()).includes("<Success/>");
    expect(await ok(pw("<![CDATA[Fake&amp;Pass!2026]]>"))).toBe(true); // CDATA: literal
    expect(await ok(pw("Fake&amp;amp;Pass!2026"))).toBe(true); // text: decoded once
    expect(await ok(pw("Fake&amp;Pass!2026"))).toBe(false); // text "Fake&amp;Pass" → "Fake&Pass"
    expect(await ok(pw("<![CDATA[Fake&amp;amp;Pass!2026]]>"))).toBe(false); // CDATA is not decoded at all
  });

  test("sameSecret compares exactly", async () => {
    expect(await sameSecret("abc", "abc")).toBe(true);
    expect(await sameSecret("abc", "abd")).toBe(false);
    expect(await sameSecret("abc", "abcd")).toBe(false);
    expect(await sameSecret("", "")).toBe(true);
  });
});

describe("protocol", () => {
  test("a body over the limit is refused with 413 (by Content-Length and by the bytes sent)", async () => {
    const s = await setup();
    expect((await s.call(RR, { "content-length": String(MAX_BODY_BYTES + 1) })).status).toBe(413);
    const big = RR.replace("<SOAP-ENV:Body>", `<SOAP-ENV:Body><!--${"x".repeat(MAX_BODY_BYTES)}-->`);
    const r = await s.call(big);
    expect(r.status).toBe(413);
    expect(body(await r.text())["SOAP-ENV:Fault"]).toMatchObject({ faultcode: "SOAP-ENV:Client", faultstring: "Request too large" });
  });

  test("malformed XML → 400 SOAP Fault", async () => {
    const r = await (await setup()).call(fixture("malformed.xml"));
    expect(r.status).toBe(400);
    expect(body(await r.text())["SOAP-ENV:Fault"]).toMatchObject({ faultcode: "SOAP-ENV:Client", faultstring: "Malformed request" });
  });

  test("a DTD is refused before parsing, for that reason", async () => {
    const warn = vi.spyOn(log, "warn");
    const r = await (await setup()).call(fixture("doctype-entity.xml"));
    expect(r.status).toBe(400);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed request (DTD_NOT_ALLOWED)"));
  });

  test("deep nesting is refused", async () => {
    const deep = `${"<a>".repeat(200)}x${"</a>".repeat(200)}`;
    const r = await (await setup()).call(RR.replace('<HotelRef HotelCode="NKHOSTEL"/>', deep));
    expect(r.status).toBe(400);
    expect(body(await r.text())["SOAP-ENV:Fault"].faultstring).toBe("Malformed request");
  });

  test("a __proto__ element is refused (no prototype pollution)", async () => {
    const s = await setup();
    const asRoot = await s.call(RR.replace(/OTA_HotelAvailRQ/g, "__proto__"));
    expect(asRoot.status).toBe(400);
    const nested = await s.call(RR.replace("<AvailRequestSegments>", "<__proto__><polluted>1</polluted></__proto__><AvailRequestSegments>"));
    expect(nested.status).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test.each([
    ["a DTD with entities", fixture("doctype-entity.xml")],
    ["not a SOAP envelope", '<OTA_HotelAvailRQ xmlns="http://www.opentravel.org/OTA/2003/05" EchoToken="1" Version="1.0"/>'],
    ["an empty body", ""],
    ["two Body elements", RR.replace("</OTA_HotelAvailRQ>", "</OTA_HotelAvailRQ><OTA_HotelAvailRQ/>")],
  ])("%s → 400 SOAP Fault, nothing handled", async (_l, xml) => {
    const r = await (await setup()).call(xml);
    expect(r.status).toBe(400);
    expect(body(await r.text())["SOAP-ENV:Fault"].faultstring).toBe("Malformed request");
  });

  test("an unknown root element (authenticated) → 400 SOAP Fault naming it", async () => {
    const r = await (await setup()).call(fixture("unknown-root-rq.xml"));
    expect(r.status).toBe(400);
    expect(body(await r.text())["SOAP-ENV:Fault"]).toMatchObject({ faultcode: "SOAP-ENV:Client", faultstring: "Unsupported message: OTA_HotelDescriptiveInfoRQ" });
  });

  test("an unknown root with wrong credentials gets the 448 error in its RS", async () => {
    const r = await (await setup()).call(fixture("unknown-root-rq.xml").replace(PASS, "nope"));
    const rs = body(await r.text()).OTA_HotelDescriptiveInfoRS;
    expect(rs["@EchoToken"]).toBe("11111111-2222-3333-4444-555555555555");
    expect(rs.Errors.Error[0]).toMatchObject({ "@Type": "4", "@Code": "448", "#text": "Invalid Username and/or Password" });
  });

  test("the handler is found by the full root name (a long name is cut only in logs and faults)", async () => {
    const long = `OTA_HotelAvailRQ${"X".repeat(70)}`;
    const r = await (await setup()).call(RR.replace(/OTA_HotelAvailRQ/g, long));
    expect(r.status).toBe(400);
    expect(body(await r.text())["SOAP-ENV:Fault"].faultstring).toBe(`Unsupported message: ${long.slice(0, 64)}`);
  });

  test("RS TimeStamp policy: AvailRS is generated now; AvailNotifRS / RateAmountNotifRS echo the request's", () => {
    const req = { "@EchoToken": "e-1", "@TimeStamp": "2026-11-27T01:00:00Z" };
    expect(rsEcho("OTA_HotelAvailRS", req, NOW)).toEqual({ echoToken: "e-1", timeStamp: "2026-11-27T02:00:05Z" });
    expect(rsEcho("OTA_HotelAvailNotifRS", req, NOW)).toEqual({ echoToken: "e-1", timeStamp: "2026-11-27T01:00:00Z" });
    expect(rsEcho("OTA_HotelRateAmountNotifRS", req, NOW).timeStamp).toBe("2026-11-27T01:00:00Z");
    expect(rsEcho("OTA_HotelAvailNotifRS", { "@EchoToken": "e-2" }, NOW).timeStamp).toBe("2026-11-27T02:00:05Z");
    expect(rsEcho("OTA_SomethingRS", req, NOW).timeStamp).toBe("2026-11-27T02:00:05Z");
    expect(rsEcho("OTA_HotelAvailRS", req, NOW, "echo").timeStamp).toBe("2026-11-27T01:00:00Z");
  });

  test("an auth failure for an ARI message echoes the request's TimeStamp", async () => {
    const ari = RR.replace(/OTA_HotelAvailRQ/g, "OTA_HotelAvailNotifRQ").replace(PASS, "nope");
    const rs = body(await (await (await setup()).call(ari)).text()).OTA_HotelAvailNotifRS;
    expect(rs).toMatchObject({ "@EchoToken": "879791878", "@TimeStamp": "2026-11-27T02:00:00Z" });
    expect(rs.Errors.Error[0]["@Code"]).toBe("448");
  });

  test("Object prototype names are not handlers", async () => {
    expect(Object.keys(HANDLERS)).toEqual(["OTA_HotelAvailRQ", "OTA_HotelAvailNotifRQ", "OTA_HotelRateAmountNotifRQ"]);
    const r = await (await setup()).call(RR.replace(/OTA_HotelAvailRQ/g, "constructor"));
    expect(r.status).toBe(400);
  });

  test("over the rate limit → 503 with Retry-After", async () => {
    const s = await setup();
    const { checkRate } = await import("@/lib/api/rate-limit");
    for (let i = 0; i < 600; i++) await checkRate(s.db, "siteminder-inbound:52.13.134.140", 600, 60, NOW);
    const r = await s.call(RR);
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBeTruthy();
    // Another source IP is not limited.
    expect((await s.call(RR, { "cf-connecting-ip": "34.213.128.113" })).status).toBe(200);
  });
});

describe("Rooms and Rates (OTA_HotelAvailRQ)", () => {
  test("lists every active room type × rate plan, one RoomStay each, in the docs' format", async () => {
    const s = await setup();
    const [flex] = await s.db.select().from(ratePlans);
    await s.db.insert(ratePlans).values({
      ...flex, id: "plan-b", slug: "direct-breakfast", smRatePlanCode: "DIRECTBREAKFAST",
      name: { "zh-TW": "含早餐", en: "With breakfast", ja: "朝食付き", ko: "조식 포함" },
    });
    await s.db.insert(ratePlans).values({ ...flex, id: "plan-off", slug: "old-plan", smRatePlanCode: "OLDPLAN", active: false });
    await s.db.update(unitTypes).set({ active: false }).where(eq(unitTypes.slug, "connecting-room"));

    const r = await s.call(RR);
    expect(r.status).toBe(200);
    const xml = await r.text();
    expect(xml).not.toMatch(/>\s+</); // minified
    const env = parse(xml)["SOAP-ENV:Envelope"];
    expect(env["@xmlns:SOAP-ENV"]).toBe("http://schemas.xmlsoap.org/soap/envelope/");
    expect(env["SOAP-ENV:Header"]).toBe("");
    const rs = env["SOAP-ENV:Body"].OTA_HotelAvailRS;
    expect(rs).toMatchObject({
      "@xmlns": "http://www.opentravel.org/OTA/2003/05", "@EchoToken": "879791878", "@TimeStamp": "2026-11-27T02:00:05Z", "@Version": "1.0",
    });
    expect(rs.Success).toBe("");
    expect(rs.Errors).toBeUndefined();

    const stays = rs.RoomStays.RoomStay as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    const pairs = stays.map((st) => `${st.RoomTypes.RoomType["@RoomTypeCode"]}/${st.RatePlans.RatePlan["@RatePlanCode"]}`);
    const rooms = ["MIXEDCUBE", "FEMALECUBE", "BUDDYROOM", "BUDDYROOMSIX", "MINIROOM", "CLASSICROOM", "DELUXEROOM"];
    expect(pairs).toEqual(rooms.flatMap((room) => [`${room}/DIRECTBREAKFAST`, `${room}/DIRECTFLEX`]));
    expect(new Set(pairs).size).toBe(pairs.length);

    const first = stays[0];
    expect(first.RoomTypes.RoomType.RoomDescription).toEqual({ "@Name": "男.女混合雙人旅艙", Text: "MIXED CUBE" });
    expect(first.RatePlans.RatePlan.RatePlanDescription).toEqual({ "@Name": "含早餐", Text: "With breakfast" });
    expect(first.RoomTypes.RoomType.Occupancy).toBeUndefined(); // PDP
    const names = stays.map((st) => `${st.RoomTypes.RoomType.RoomDescription["@Name"]}|${st.RatePlans.RatePlan.RatePlanDescription["@Name"]}`);
    expect(new Set(names).size).toBe(names.length);
  });

  test("a room type or plan without a code is not listed", async () => {
    const s = await setup();
    await s.db.update(unitTypes).set({ smRoomCode: null }).where(eq(unitTypes.slug, "mixed-cube"));
    const stays = body(await (await s.call(RR)).text()).OTA_HotelAvailRS.RoomStays.RoomStay;
    expect(stays).toHaveLength(7);
  });

  test("no active plan → Success without RoomStays", async () => {
    const s = await setup();
    await s.db.update(ratePlans).set({ active: false });
    const rs = body(await (await s.call(RR)).text()).OTA_HotelAvailRS;
    expect(rs.Success).toBe("");
    expect(rs.RoomStays).toBeUndefined();
  });

  test("an unknown HotelCode → exactly Type 6 / Code 392 'Hotel not found for HotelCode=…' (case-sensitive)", async () => {
    const s = await setup();
    for (const code of ["NOSUCHHOTEL", "nkhostel"]) {
      const r = await s.call(RR.replace('HotelCode="NKHOSTEL"', `HotelCode="${code}"`));
      expect(r.status).toBe(200);
      const rs = body(await r.text()).OTA_HotelAvailRS;
      expect(rs["@EchoToken"]).toBe("879791878");
      expect(rs.Success).toBeUndefined();
      expect(rs.RoomStays).toBeUndefined();
      expect(rs.Errors.Error).toEqual([{ "@Type": "6", "@Code": "392", "#text": `Hotel not found for HotelCode=${code}` }]);
    }
  });

  test("a missing HotelRef → a Required field missing error", async () => {
    const r = await (await setup()).call(RR.replace('<HotelRef HotelCode="NKHOSTEL"/>', ""));
    expect(body(await r.text()).OTA_HotelAvailRS.Errors.Error[0]).toMatchObject({ "@Type": "10", "@Code": "321" });
  });

  test("names that repeat get the code appended", () => {
    expect(uniqueNames([{ code: "A", name: "房" }, { code: "B", name: "房" }, { code: "C", name: "別" }, { code: "D", name: " " }]))
      .toEqual(["房 (A)", "房 (B)", "別", "D"]);
  });
});

test("the preview may not set the inbound secrets, so its endpoint always refuses", async () => {
  const { configRefusal } = await import("@/lib/runtime/config-guard");
  const env = { ENVIRONMENT: "preview", PAYMENT_MODE: "mock", CHANNEL_MODE: "mock" };
  expect(configRefusal(env)).toBeNull();
  expect(configRefusal({ ...env, SITEMINDER_INBOUND_USERNAME: "u", SITEMINDER_INBOUND_PASSWORD: "p" }))
    .toMatch(/VENDOR_SETTING_IN_PREVIEW: SITEMINDER_INBOUND_PASSWORD.*SITEMINDER_INBOUND_USERNAME/);
});
