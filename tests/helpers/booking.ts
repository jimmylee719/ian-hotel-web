import { and, eq } from "drizzle-orm";
import { createReservation, type CreateInput } from "@/lib/booking/create";
import type { Deps } from "@/lib/booking/notify";
import { MockChannelManager } from "@/lib/channel/mock";
import { inventoryDaily, reservations } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import { MockEmailSender } from "@/lib/email/mock";
import { MockSinoPacGateway } from "@/lib/payments/mock-sinopac";
import type { PaymentNotice } from "@/lib/payments/types";
import { fillAri, idsFor } from "./ari";
import { createTestDb } from "./test-db";

export const NOW = new Date("2026-11-24T02:00:00Z");
export const BASE = "https://hotel.test";
export const STAFF = "staff@hotel.test";
export const PAY_NOW = 4000; // mixed-cube, 2 nights × 2000, paid in full
export const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

export const bookingInput = (over: Partial<CreateInput> = {}): CreateInput => ({
  propertySlug: "nk-hostel",
  checkIn: "2026-12-01",
  checkOut: "2026-12-03",
  adults: 2,
  children: 0,
  rooms: 1,
  unitTypeSlug: "mixed-cube",
  ratePlanSlug: "direct-flex",
  addons: [],
  guest: { firstName: "Mei", lastName: "Lin", email: "mei@example.com", phone: "+886912345678", country: "TW" },
  locale: "en",
  idempotencyKey: "key-0001-abcdef",
  acceptTerms: true,
  ...over,
});

export async function bookingSetup(o: { available?: number; channel?: MockChannelManager; failRefund?: boolean } = {}) {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  await fillAri(db, propertyId, "2026-12-01", 5, { available: o.available ?? 3 });
  const ids = await idsFor(db, "mixed-cube");
  const gateway = new MockSinoPacGateway({ secret: "s", baseUrl: BASE, failRefund: o.failRefund });
  const channel = o.channel ?? new MockChannelManager();
  const email = new MockEmailSender();
  const deps: Deps = { db, gateway, channel, email, staffEmails: [STAFF], baseUrl: BASE };

  const avail = async (date = "2026-12-01") =>
    (await db.select().from(inventoryDaily)
      .where(and(eq(inventoryDaily.unitTypeId, ids.unitTypeId), eq(inventoryDaily.date, date))))[0].available;

  const book = async (over: Partial<CreateInput> = {}, at = NOW) => {
    const r = await createReservation(deps, bookingInput(over), at);
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.code;
  };

  const reservation = async (code: string) =>
    (await db.select().from(reservations).where(eq(reservations.code, code)))[0];

  const notice = (code: string, over: Partial<PaymentNotice> = {}) =>
    gateway.signedNotice({ reservationCode: code, providerRef: `REF-${code}`, amount: PAY_NOW, status: "succeeded", ...over });

  return { db, propertyId, ids, gateway, channel, email, deps, avail, book, reservation, notice };
}
