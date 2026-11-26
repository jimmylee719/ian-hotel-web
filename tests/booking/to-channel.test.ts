import { expect, test } from "vitest";
import { cancelReservation } from "@/lib/booking/manage";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { toChannelReservation } from "@/lib/booking/to-channel";
import { SiteMinderChannelManager } from "@/lib/channel/siteminder/client";
import { addons, promoCodes } from "@/lib/db/schema";
import { bookingSetup, minutes, NOW } from "@/tests/helpers/booking";
import { fakeSiteMinder, parseRequest, xp } from "@/tests/helpers/siteminder-fake";

const GUEST = "mei@example.com";

test("toChannelReservation fills everything the SiteMinder message needs from the booking", async () => {
  const s = await bookingSetup();
  await s.db.insert(addons).values({
    id: "a1", propertyId: s.propertyId, slug: "breakfast", name: { "zh-TW": "早餐", en: "Breakfast", ja: "Breakfast", ko: "Breakfast" },
    price: 250, unit: "per_person_night", active: true,
  });
  await s.db.insert(promoCodes).values({ id: "p1", propertyId: s.propertyId, code: "TENOFF", kind: "fixed", value: 100, active: true });
  const code = await s.book({ addons: [{ slug: "breakfast", qty: 1 }], promoCode: "TENOFF", adults: 1, children: 1 });
  const res = await s.reservation(code);
  const r = await toChannelReservation(s.db, res.id);
  expect(r).toEqual({
    code, smPropertyCode: "NKHOSTEL", checkIn: "2026-12-01", checkOut: "2026-12-03",
    rooms: [{ smRoomCode: "MIXEDCUBE", smRatePlanCode: "DIRECTFLEX", nightlyPrices: [2000, 2000], roomName: "男.女混合雙人旅艙", ratePlanName: "官網專屬・彈性取消" }],
    guest: { firstName: "Mei", lastName: "Lin", email: GUEST, phone: "+886912345678" },
    adults: 1, children: 1, currency: "TWD",
    createdAt: NOW.getTime(), lastModifiedAt: NOW.getTime(),
    total: 4400, paidAmount: 0, discount: 100,
    addons: [{ code: "BREAKFAST", name: "早餐", amount: 500 }],
    promoCode: "TENOFF",
  });
});

test("through the sync: the booking is committed to (fake) SiteMinder, and its cancel carries the whole booking", async () => {
  const fake = fakeSiteMinder({ username: "u", password: "p", hotelCode: "NKHOSTEL" });
  const channel = new SiteMinderChannelManager({ endpoint: "https://siteminder.test/x", username: "u", password: "p", hotelCode: "NKHOSTEL", requestorId: "NKDIRECT", fetch: fake.fetch });
  const s = await bookingSetup({ channel: channel as never });
  const code = await s.book();
  await handlePaymentNotice(s.deps, await s.notice(code), minutes(2));
  const uid = code.replace(/[^A-Za-z0-9]/g, "");
  expect(await s.reservation(code)).toMatchObject({ status: "confirmed", syncState: "synced", smConfirmation: `SMR1${uid}` });
  expect(fake.requests).toHaveLength(1);

  expect(await cancelReservation(s.deps, code, GUEST, minutes(10))).toMatchObject({ ok: true });
  expect(await s.reservation(code)).toMatchObject({ status: "cancelled", syncState: "synced" });
  expect(fake.held.get(uid)).toEqual({ resId: `SMR1${uid}`, state: "cancelled" });
  const rq = xp(parseRequest(fake.requests.at(-1)!), "Envelope/Body/OTA_HotelResNotifRQ");
  expect(rq["@ResStatus"]).toBe("Cancel");
  const hr = xp(rq, "HotelReservations/HotelReservation");
  expect(xp(hr, "UniqueID/@ID")).toBe(uid);
  expect(hr["@LastModifyDateTime"]).toBe(minutes(10).toISOString().replace(/\.\d{3}Z$/, "Z"));
  expect(xp(hr, "RoomStays/RoomStay/RoomTypes/RoomType/@RoomTypeCode")).toBe("MIXEDCUBE");
});
