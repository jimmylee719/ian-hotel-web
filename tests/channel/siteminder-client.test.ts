import { afterEach, describe, expect, test, vi } from "vitest";
import { resendAnswer } from "@/lib/booking/channel-sync";
import { SiteMinderChannelManager, type SiteMinderOptions } from "@/lib/channel/siteminder/client";
import { classifyAnswer } from "@/lib/channel/siteminder/errors";
import { discountedNights, guestsPerRoom, uniqueIdFor } from "@/lib/channel/siteminder/map";
import { CHANNEL_MAX_TIMEOUT_MS, CHANNEL_MIN_TIMEOUT_MS, type ChannelReservation } from "@/lib/channel/types";
import { log } from "@/lib/runtime/log";
import { channelConformance } from "@/tests/conformance/channel";
import { fakeSiteMinder, filled, fixture, parseRequest, xp } from "@/tests/helpers/siteminder-fake";

const USER = "fake-channel-user";
const PASS = "Fake-Outb0und!2026";
const HOTEL = "NKHOSTEL";
const ENDPOINT = "https://siteminder.test/reservation-gateway/services";
const NOW = new Date("2026-11-27T02:00:05.123Z");
const ECHO = "6f9619ff-8b86-d011-b42d-00c04fc964ff";

const reservation = (over: Partial<ChannelReservation> = {}): ChannelReservation => ({
  code: "NK-AB12CD", smPropertyCode: HOTEL, checkIn: "2026-12-01", checkOut: "2026-12-03",
  rooms: [
    { smRoomCode: "MIXEDCUBE", smRatePlanCode: "DIRECTFLEX", nightlyPrices: [2000, 2400], roomName: "混合旅艙", ratePlanName: "官網彈性" },
    { smRoomCode: "FEMALECUBE", smRatePlanCode: "DIRECTFLEX", nightlyPrices: [1500, 1500], roomName: "女性旅艙", ratePlanName: "官網彈性" },
  ],
  guest: { firstName: "Mei", lastName: "Lin & Co", email: "mei@example.com", phone: "+886912345678" },
  adults: 3, children: 1, currency: "TWD",
  createdAt: Date.parse("2026-11-20T03:04:05Z"), lastModifiedAt: Date.parse("2026-11-26T08:09:10Z"),
  total: 8300, paidAmount: 2490, discount: 300,
  addons: [{ code: "BREAKFAST", name: "早餐", amount: 1000 }, { code: "PARKING", name: "停車", amount: 200 }],
  promoCode: "EARLY",
  ...over,
});

const answer = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/xml; charset=utf-8" } });

function manager(over: Partial<SiteMinderOptions> = {}) {
  const fake = fakeSiteMinder({ username: USER, password: PASS, hotelCode: HOTEL });
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = over.fetch ?? fake.fetch;
  const cm = new SiteMinderChannelManager({
    endpoint: ENDPOINT, username: USER, password: PASS, hotelCode: HOTEL, requestorId: "NKDIRECT",
    now: () => NOW, echoToken: () => ECHO, ...over,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return fetchFn(url, init);
    }) as typeof fetch,
  });
  const sent = () => parseRequest(String(calls.at(-1)!.init.body));
  return { cm, fake, calls, sent };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("OTA_HotelResNotifRQ: every mapped field", () => {
  test("Commit: envelope, WS-Security, POS, and the whole reservation", async () => {
    const { cm, calls, sent } = manager();
    const r = await cm.pushReservation(reservation());
    expect(r).toEqual({ ok: true, smConfirmation: "SMR1NKAB12CD" });

    const { url, init } = calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("text/xml; charset=utf-8");
    const raw = String(init.body);
    expect(raw).not.toMatch(/>\s+</); // minified [REQ]
    expect(raw.split("\n")).toHaveLength(1);

    const d = sent();
    const sec = xp(d, "Envelope/Header/Security");
    expect(sec["@mustUnderstand"]).toBe("1");
    expect(xp(sec, "UsernameToken/Username")).toBe(USER);
    expect(xp(sec, "UsernameToken/Password/#text")).toBe(PASS);
    expect(xp(sec, "UsernameToken/Password/@Type")).toBe("http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText");
    expect(raw).toContain('xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"');

    const rq = xp(d, "Envelope/Body/OTA_HotelResNotifRQ");
    expect(raw).toContain('<OTA_HotelResNotifRQ xmlns="http://www.opentravel.org/OTA/2003/05" ');
    expect(rq["@EchoToken"]).toBe(ECHO);
    expect(rq["@TimeStamp"]).toBe("2026-11-27T02:00:05Z");
    expect(rq["@Version"]).toBe("1.0");
    expect(rq["@ResStatus"]).toBe("Commit");
    expect(xp(rq, "POS/Source/RequestorID/@Type")).toBe("22");
    expect(xp(rq, "POS/Source/RequestorID/@ID")).toBe("NKDIRECT");
    expect(xp(rq, "POS/Source/BookingChannel/@Primary")).toBe("true");
    expect(xp(rq, "POS/Source/BookingChannel/CompanyName/@Code")).toBe("NKDIRECT");
    expect(xp(rq, "POS/Source/BookingChannel/CompanyName/#text")).toBe("NK Hostel");

    expect(rq.HotelReservations.HotelReservation).toHaveLength(1); // one reservation per message [RES]
    const hr = xp(rq, "HotelReservations/HotelReservation");
    expect(hr["@CreateDateTime"]).toBe("2026-11-20T03:04:05Z");
    expect(hr["@LastModifyDateTime"]).toBeUndefined(); // Modify and Cancel only
    expect(xp(hr, "UniqueID/@Type")).toBe("14");
    expect(xp(hr, "UniqueID/@ID")).toBe("NKAB12CD");

    // Rooms: the 300 discount is spread over the nights (rates and totals add up), rates per night.
    const stays = xp(hr, "RoomStays").RoomStay;
    expect(stays).toHaveLength(2);
    const s0 = stays[0];
    expect(s0["@PromotionCode"]).toBe("EARLY");
    expect(xp(s0, "RoomTypes/RoomType/@RoomTypeCode")).toBe("MIXEDCUBE");
    expect(xp(s0, "RoomTypes/RoomType/RoomDescription/@Name")).toBe("混合旅艙");
    expect(xp(s0, "RatePlans/RatePlan/@RatePlanCode")).toBe("DIRECTFLEX");
    expect(xp(s0, "RatePlans/RatePlan/RatePlanDescription/@Name")).toBe("官網彈性");
    const rr = xp(s0, "RoomRates/RoomRate");
    expect([rr["@RoomTypeCode"], rr["@RatePlanCode"], rr["@NumberOfUnits"]]).toEqual(["MIXEDCUBE", "DIRECTFLEX", "1"]);
    expect(xp(rr, "Rates").Rate.map((x: Record<string, unknown>) => [x["@UnitMultiplier"], x["@RateTimeUnit"], x["@EffectiveDate"], x["@ExpireDate"], xp(x, "Base/@AmountAfterTax"), xp(x, "Base/@CurrencyCode")]))
      .toEqual([["1", "Day", "2026-12-01", "2026-12-02", "1919", "TWD"], ["1", "Day", "2026-12-02", "2026-12-03", "2303", "TWD"]]);
    expect(xp(s0, "GuestCounts").GuestCount.map((g: Record<string, string>) => [g["@AgeQualifyingCode"], g["@Count"]])).toEqual([["10", "2"], ["8", "1"]]);
    expect(xp(s0, "TimeSpan/@Start")).toBe("2026-12-01");
    expect(xp(s0, "TimeSpan/@End")).toBe("2026-12-03");
    expect(xp(s0, "Total/@AmountAfterTax")).toBe("4222");
    expect(xp(s0, "Total/@CurrencyCode")).toBe("TWD");
    expect(xp(s0, "BasicPropertyInfo/@HotelCode")).toBe(HOTEL);
    expect(xp(s0, "ResGuestRPHs/ResGuestRPH/@RPH")).toBe("1");
    const s1 = stays[1];
    expect(xp(s1, "RoomTypes/RoomType/@RoomTypeCode")).toBe("FEMALECUBE");
    expect(xp(s1, "RoomRates/RoomRate/Rates").Rate.map((x: unknown) => xp(x, "Base/@AmountAfterTax"))).toEqual(["1439", "1439"]);
    expect(xp(s1, "GuestCounts").GuestCount.map((g: Record<string, string>) => [g["@AgeQualifyingCode"], g["@Count"]])).toEqual([["10", "1"]]);
    expect(xp(s1, "Total/@AmountAfterTax")).toBe("2878");

    // Add-ons: booking level, Inclusive, no ServiceRPH.
    const svc = xp(hr, "Services").Service;
    expect(svc.map((x: Record<string, unknown>) => [x["@ServiceInventoryCode"], x["@Inclusive"], x["@Quantity"], x["@ID"], xp(x, "Price/Total/@AmountAfterTax"), xp(x, "Price/Total/@CurrencyCode"), xp(x, "Price/RateDescription/Text")]))
      .toEqual([["BREAKFAST", "true", "1", "1", "1000", "TWD", "早餐"], ["PARKING", "true", "1", "2", "200", "TWD", "停車"]]);
    expect(raw).not.toContain("ServiceRPH");
    expect(raw).toContain("<Surname>Lin &amp; Co</Surname>"); // escaped on the wire

    // The guest: ResGuest (primary) and the booker (Customer) in ResGlobalInfo.
    const rg = xp(hr, "ResGuests/ResGuest");
    expect([rg["@ResGuestRPH"], rg["@PrimaryIndicator"]]).toEqual(["1", "1"]);
    for (const c of [xp(rg, "Profiles/ProfileInfo/Profile"), xp(hr, "ResGlobalInfo/Profiles/ProfileInfo/Profile")]) {
      expect(c["@ProfileType"]).toBe("1");
      expect(xp(c, "Customer/PersonName/GivenName")).toBe("Mei");
      expect(xp(c, "Customer/PersonName/Surname")).toBe("Lin & Co");
      expect(xp(c, "Customer/Telephone/@PhoneNumber")).toBe("+886912345678");
      expect(xp(c, "Customer/Email")).toBe("mei@example.com");
    }

    // Totals, the discount comment, the amount paid (Deposit Only, no card).
    const g = xp(hr, "ResGlobalInfo");
    expect(xp(g, "Total/@AmountAfterTax")).toBe("8300");
    expect(xp(g, "Total/@CurrencyCode")).toBe("TWD");
    expect(xp(g, "Comments").Comment.map((c: unknown) => xp(c, "Text"))).toEqual(["優惠折扣 300 TWD（優惠碼 EARLY），已反映在每晚房價與總額"]);
    expect(xp(g, "DepositPayments/GuaranteePayment/AmountPercent/@Amount")).toBe("2490");
    expect(xp(g, "DepositPayments/GuaranteePayment/AmountPercent/@CurrencyCode")).toBe("TWD");
    expect(raw).not.toMatch(/PaymentCard|CardNumber/);
    expect(Object.keys(g)).toEqual(["Comments", "Total", "DepositPayments", "Profiles"]); // [RES] order
    expect(Object.keys(hr).filter((k) => !k.startsWith("@"))).toEqual(["UniqueID", "RoomStays", "Services", "ResGuests", "ResGlobalInfo"]);
  });

  test("special requests go into a ResGlobalInfo comment; no discount, no payment, no add-ons, no promo leave theirs out", async () => {
    const { cm, sent } = manager();
    await cm.pushReservation(reservation({ discount: 0, promoCode: undefined, paidAmount: 0, addons: [], specialRequests: "晚到 23:00", total: 7400, children: 0 }));
    const hr = xp(sent(), "Envelope/Body/OTA_HotelResNotifRQ/HotelReservations/HotelReservation");
    expect(xp(hr, "ResGlobalInfo/Comments").Comment.map((c: unknown) => xp(c, "Text"))).toEqual(["晚到 23:00"]);
    expect(xp(hr, "ResGlobalInfo/DepositPayments")).toBeUndefined();
    expect(hr.Services).toBeUndefined();
    expect(xp(hr, "RoomStays/RoomStay")["@PromotionCode"]).toBeUndefined();
    expect(xp(hr, "RoomStays/RoomStay/RoomRates/RoomRate/Rates").Rate.map((x: unknown) => xp(x, "Base/@AmountAfterTax"))).toEqual(["2000", "2400"]);
    expect(xp(hr, "RoomStays/RoomStay/GuestCounts").GuestCount).toHaveLength(1);
  });

  test("Modify and Cancel: same UniqueID, the whole reservation, LastModifyDateTime", async () => {
    const { cm, sent } = manager();
    const p = await cm.pushReservation(reservation());
    if (!p.ok) throw new Error(p.error);
    expect(await cm.modifyReservation(reservation({ checkOut: "2026-12-04" }), p.smConfirmation)).toEqual({ ok: true, smConfirmation: p.smConfirmation });
    let rq = xp(sent(), "Envelope/Body/OTA_HotelResNotifRQ");
    expect(rq["@ResStatus"]).toBe("Modify");
    expect(xp(rq, "HotelReservations/HotelReservation/UniqueID/@ID")).toBe("NKAB12CD");
    expect(xp(rq, "HotelReservations/HotelReservation/@CreateDateTime")).toBe("2026-11-20T03:04:05Z");
    expect(xp(rq, "HotelReservations/HotelReservation/@LastModifyDateTime")).toBe("2026-11-26T08:09:10Z");
    expect(xp(rq, "HotelReservations/HotelReservation/RoomStays/RoomStay/TimeSpan/@End")).toBe("2026-12-04");

    expect(await cm.cancelReservation(reservation({ lastModifiedAt: Date.parse("2026-11-27T01:00:00Z") }), p.smConfirmation)).toEqual({ ok: true, retryable: false });
    rq = xp(sent(), "Envelope/Body/OTA_HotelResNotifRQ");
    expect(rq["@ResStatus"]).toBe("Cancel");
    expect(xp(rq, "HotelReservations/HotelReservation/UniqueID/@ID")).toBe("NKAB12CD");
    expect(xp(rq, "HotelReservations/HotelReservation/@LastModifyDateTime")).toBe("2026-11-27T01:00:00Z");
    expect(xp(rq, "HotelReservations/HotelReservation/RoomStays").RoomStay).toHaveLength(2);
    expect(xp(rq, "HotelReservations/HotelReservation/ResGlobalInfo/Total/@AmountAfterTax")).toBe("8300");
  });

  test("every request has a new UUID EchoToken by default", async () => {
    const { cm, calls } = manager({ echoToken: undefined });
    await cm.pushReservation(reservation());
    await cm.pushReservation(reservation());
    const tokens = calls.map((c) => xp(parseRequest(String(c.init.body)), "Envelope/Body/OTA_HotelResNotifRQ/@EchoToken"));
    expect(tokens[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(tokens[1]).not.toBe(tokens[0]);
  });
});

describe("mapping rules", () => {
  test("SITEMINDER-OPEN-Q4: UniqueID is the code without non-alphanumerics", () => {
    expect(uniqueIdFor("NK-AB12CD")).toBe("NKAB12CD");
    expect(uniqueIdFor("nk_ab-12.cd")).toBe("nkab12cd");
  });

  test("the discount is spread exactly over the nights", () => {
    expect(discountedNights([[2000, 2400], [1500, 1500]], 300)).toEqual([[1919, 2303], [1439, 1439]]);
    expect(discountedNights([[1000]], 5000)).toEqual([[0]]);
    expect(discountedNights([[1000, 1000]], 0)).toEqual([[1000, 1000]]);
    expect(discountedNights([[333, 333, 334]], 100).flat().reduce((a, b) => a + b)).toBe(900);
  });

  test("SITEMINDER-OPEN-Q9: guests are split over the rooms, at least one adult each", () => {
    expect(guestsPerRoom(3, 1, 2)).toEqual([{ adults: 2, children: 1 }, { adults: 1, children: 0 }]);
    expect(guestsPerRoom(2, 0, 1)).toEqual([{ adults: 2, children: 0 }]);
    expect(guestsPerRoom(1, 0, 2)).toEqual([{ adults: 1, children: 0 }, { adults: 1, children: 0 }]);
  });

  test("a reservation we cannot send is refused here, not retryable, nothing sent", async () => {
    const { cm, calls } = manager();
    const bad = reservation({ rooms: [{ ...reservation().rooms[0], smRoomCode: "" }] });
    expect(await cm.pushReservation(bad)).toMatchObject({ ok: false, retryable: false, error: "MISSING_ROOM_OR_RATE_CODE", detail: { kind: "config" } });
    expect(await cm.pushReservation(reservation({ smPropertyCode: "OTHER" }))).toMatchObject({ ok: false, retryable: false, error: "HOTEL_CODE_MISMATCH" });
    expect(await cm.modifyReservation(reservation(), "")).toMatchObject({ ok: false, retryable: false, error: "NO_SM_CONFIRMATION" });
    expect(calls).toHaveLength(0);
  });

  test("the hotel code can be read lazily; an unset one is retryable (our configuration), nothing sent", async () => {
    const lazy = manager({ hotelCode: async () => HOTEL });
    expect(await lazy.cm.pushReservation(reservation())).toMatchObject({ ok: true });
    const unset = manager({ hotelCode: async () => { throw new Error("no property code"); } });
    expect(await unset.cm.pushReservation(reservation())).toMatchObject({ ok: false, retryable: true, error: "SITEMINDER_HOTEL_CODE_NOT_SET" });
    expect(unset.calls).toHaveLength(0);
  });

  test("timeoutMs defaults to 60 s and must stay within 60–120 s", () => {
    expect(manager().cm.timeoutMs).toBe(CHANNEL_MIN_TIMEOUT_MS);
    expect(manager({ timeoutMs: CHANNEL_MAX_TIMEOUT_MS }).cm.timeoutMs).toBe(CHANNEL_MAX_TIMEOUT_MS);
    expect(() => manager({ timeoutMs: 30_000 })).toThrow(RangeError);
    expect(() => manager({ timeoutMs: 121_000 })).toThrow(RangeError);
  });
});

describe("answers: §5.1 classification", () => {
  const vals = { ECHO_TOKEN: ECHO, UNIQUE_ID: "NKAB12CD", RES_ID: "SM-42", HOTEL_CODE: HOTEL, NODE: "CreateDateTime" };

  test.each([
    ["res-notif-rs-error-credentials.xml", 4, "Invalid Username and/or Password for ABC"],
    ["res-notif-rs-error-hotel-not-found.xml", 6, `Hotel not found for HotelCode=${HOTEL}`],
    ["res-notif-rs-error-no-hotel-codes.xml", 6, "No HotelCodes were found in the message payload. Authorisation cannot proceed."],
    ["res-notif-rs-error-node-missing.xml", 10, "Node CreateDateTime must exist"],
  ])("%s → not retryable, structured", (name, type, text) => {
    expect(classifyAnswer(200, filled(name, vals), ECHO)).toEqual({
      ok: false, retryable: false, error: `SITEMINDER_ERROR type=${type}: ${text}`, detail: { kind: "ota", httpStatus: 200, type, code: undefined, echoToken: ECHO },
    });
  });

  test("an OTA error with a Code keeps it", () => {
    const xml = filled("res-notif-rs-error-credentials.xml", vals).replace('Type="4"', 'Type="12" Code="187"');
    expect(classifyAnswer(200, xml, ECHO)).toMatchObject({ ok: false, retryable: false, detail: { kind: "ota", type: 12, code: 187 } });
  });

  test("Success → ok with ResID_Value; Warnings are accepted", () => {
    expect(classifyAnswer(200, filled("res-notif-rs-success.xml", vals), ECHO)).toEqual({ ok: true, resId: "SM-42", echoToken: ECHO, warnings: [] });
    expect(classifyAnswer(200, filled("res-notif-rs-warning.xml", vals), ECHO)).toMatchObject({ ok: true, resId: "SM-42", warnings: [{ type: 11, code: 999 }] });
  });

  test("a SOAP Fault is not retryable, with HTTP 200 or 500 (SITEMINDER-OPEN-Q2)", () => {
    for (const status of [200, 500])
      expect(classifyAnswer(status, fixture("soap-fault-auth.xml"), ECHO)).toEqual({
        ok: false, retryable: false, error: `SITEMINDER_SOAP_FAULT http=${status} SOAP-ENV:Client: Invalid Username and/or Password for ABC`,
        detail: { kind: "soap_fault", httpStatus: status, echoToken: ECHO },
      });
  });

  test.each([
    [500, true], [502, true], [503, true], [504, true], [507, true],
    [501, false], [505, false],
    [400, false], [401, false], [403, false], [404, false], [405, false], [406, false], [409, false], [415, false],
  ])("HTTP %i without an OTA answer → retryable %s", (status, retryable) => {
    expect(classifyAnswer(status, "<html>gateway</html>", ECHO)).toEqual({
      ok: false, retryable, error: `SITEMINDER_HTTP_${status}`, detail: { kind: "http", httpStatus: status, echoToken: ECHO },
    });
  });

  test("a 2xx we cannot read is retryable (outcome unknown; the resend converges)", () => {
    expect(classifyAnswer(200, "not xml", ECHO)).toMatchObject({ ok: false, retryable: true, detail: { kind: "bad_response" } });
    expect(classifyAnswer(200, fixture("rooms-and-rates-rq.xml"), ECHO)).toMatchObject({ ok: false, retryable: true });
  });

  test("HTTP 500 through the adapter: retryable, EchoToken in the error", async () => {
    const { cm } = manager({ fetch: (async () => answer("Internal error", 500)) as unknown as typeof fetch });
    expect(await cm.pushReservation(reservation())).toEqual({
      ok: false, retryable: true, error: `SITEMINDER_HTTP_500 (echo=${ECHO})`, detail: { kind: "http", httpStatus: 500, echoToken: ECHO },
    });
  });

  test("a network error is retryable", async () => {
    const { cm } = manager({ fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    expect(await cm.pushReservation(reservation())).toMatchObject({ ok: false, retryable: true, detail: { kind: "network", echoToken: ECHO } });
  });

  test("timeout: a fetch that never answers is aborted at timeoutMs and reported retryable", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const never = ((_u: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>(() => {}); // ignores the abort too
    }) as unknown as typeof fetch;
    const { cm } = manager({ fetch: never, timeoutMs: 90_000 });
    let done: unknown;
    const p = cm.pushReservation(reservation()).then((r) => (done = r));
    await vi.advanceTimersByTimeAsync(89_999);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(signal?.aborted).toBe(true);
    expect(done).toEqual({ ok: false, retryable: true, error: `TIMEOUT (echo=${ECHO})`, detail: { kind: "timeout", echoToken: ECHO } });
  });

  test("a fetch that rejects on abort is a timeout too", async () => {
    vi.useFakeTimers();
    const aborting = ((_u: string, init: RequestInit) => new Promise<Response>((_, reject) =>
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const { cm } = manager({ fetch: aborting });
    const p = cm.cancelReservation(reservation(), "SM-1");
    await vi.advanceTimersByTimeAsync(CHANNEL_MIN_TIMEOUT_MS);
    expect(await p).toMatchObject({ ok: false, retryable: true, detail: { kind: "timeout" } });
  });

  test("a modify or cancel answered for another ResID_Value is refused, not retryable", async () => {
    const { cm } = manager();
    await cm.pushReservation(reservation());
    expect(await cm.modifyReservation(reservation(), "SM-OTHER")).toMatchObject({ ok: false, retryable: false, error: "SM_CONFIRMATION_MISMATCH" });
  });

  test("a Success without ResID_Value: the UniqueID stands in", async () => {
    const bare = filled("res-notif-rs-success.xml", { ...vals, ECHO_TOKEN: ECHO }).replace(/<ResGlobalInfo>[\s\S]*<\/ResGlobalInfo>/, "");
    const { cm } = manager({ fetch: (async () => answer(bare)) as unknown as typeof fetch });
    expect(await cm.pushReservation(reservation())).toEqual({ ok: true, smConfirmation: "NKAB12CD" });
    expect(await cm.modifyReservation(reservation(), "NKAB12CD")).toEqual({ ok: true, smConfirmation: "NKAB12CD" });
  });

  test("resendAnswer reads the adapter's structured status (SITEMINDER-OPEN-Q1)", async () => {
    const { cm } = manager({ fetch: (async () => answer("Conflict", 409)) as unknown as typeof fetch });
    const r = await cm.pushReservation(reservation());
    expect(r).toMatchObject({ ok: false, retryable: false, detail: { kind: "http", httpStatus: 409 } });
    expect(resendAnswer(r)).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/^RESEND_ALREADY_HELD_NO_CONFIRMATION: SITEMINDER_HTTP_409/) });
    const { cm: ota } = manager({ fetch: (async () => answer(filled("res-notif-rs-error-credentials.xml", vals))) as unknown as typeof fetch });
    const e = await ota.pushReservation(reservation());
    expect(resendAnswer(e)).toEqual(e);
  });
});

describe("logging", () => {
  test("logs the EchoToken, status and outcome; never credentials, XML or guest data", async () => {
    const lines: string[] = [];
    for (const m of ["info", "warn", "error"] as const) vi.spyOn(log, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const { cm } = manager();
    await cm.pushReservation(reservation());
    const { cm: bad } = manager({ password: "Wrong-Passw0rd!" });
    await bad.pushReservation(reservation());
    const all = lines.join("\n");
    expect(all).toContain(ECHO);
    expect(all).toMatch(/Commit NKAB12CD echo=.*: ok/);
    expect(all).toMatch(/not retryable kind=ota http=200 type=4/);
    for (const secret of [USER, PASS, "Wrong-Passw0rd!", "mei@example.com", "+886912345678", "Mei", "<", "Invalid Username"]) expect(all).not.toContain(secret);
  });
});

describe("SiteMinderChannelManager conformance (fixture-backed fake SiteMinder)", () => {
  const fresh = () => manager().cm;
  channelConformance(fresh, {
    fixtures: {
      reservation: (code) => reservation({ code }),
      // The abort firing at once (the timer itself is covered above).
      timingOut: () => manager({ fetch: (async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }) as unknown as typeof fetch }).cm,
    },
  });
});
