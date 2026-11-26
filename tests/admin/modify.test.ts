import { and, eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import type { StaffContext } from "@/lib/admin/auth";
import { applyModification, previewModification, type ModificationChange } from "@/lib/admin/modify";
import { staffCancel } from "@/lib/admin/staff-cancel";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { addons, auditLog, inventoryDaily, notifications, payments, reservationRooms, reservations, staff, unitTypes } from "@/lib/db/schema";
import { runSyncRetry } from "@/lib/jobs/sync-retry";
import { MockChannelManager } from "@/lib/channel/mock";
import { BookingDisabledError } from "@/lib/runtime/deps";
import { setAri } from "@/tests/helpers/ari";
import { bookingSetup, minutes } from "@/tests/helpers/booking";

const GUEST = "mei@example.com";
const AT = minutes(10); // 2026-11-24 Taipei, well before check-in
const AFTER_CHECKIN = new Date("2026-12-01T16:30:00Z"); // 2026-12-02 00:30 Taipei: the stay began on 12-01
const REASON = "旅客來電要求改期";

/**
 * A confirmed mixed-cube booking from 2026-12-01 for `nights` nights at 2000 a night, paid in full online,
 * plus staff at its property. ARI: 5 days from 12-01, 3 rooms a night.
 */
async function confirmed(o: { nights?: number; addons?: { slug: string; qty: number }[] } = {}) {
  const nights = o.nights ?? 2;
  const s = await bookingSetup();
  if (o.addons?.length)
    await s.db.insert(addons).values([
      { id: "ad-bf", propertyId: s.propertyId, slug: "breakfast", name: { "zh-TW": "早餐", en: "Breakfast", ja: "朝食", ko: "조식" }, price: 150, unit: "per_person_night" },
      { id: "ad-pk", propertyId: s.propertyId, slug: "parking", name: { "zh-TW": "停車", en: "Parking", ja: "駐車", ko: "주차" }, price: 200, unit: "per_night" },
      { id: "ad-fl", propertyId: s.propertyId, slug: "flowers", name: { "zh-TW": "花束", en: "Flowers", ja: "花束", ko: "꽃다발" }, price: 500, unit: "per_stay" },
    ]);
  const checkOut = `2026-12-0${1 + nights}`;
  const code = await s.book({ checkIn: "2026-12-01", checkOut, addons: o.addons ?? [] });
  const before = await s.reservation(code);
  await handlePaymentNotice(s.deps, await s.notice(code, { amount: before.totalAmount }), minutes(2));
  const res = await s.reservation(code);
  expect(res.status).toBe("confirmed");
  const mk = async (role: "front_desk" | "manager" | "marketing", propertyIds = [s.propertyId]): Promise<StaffContext> => {
    const row = { id: `s-${role}-${propertyIds.join()}`, email: `${role}@nk.test`, name: role, role, propertyIds, active: true };
    await s.db.insert(staff).values(row).onConflictDoNothing();
    return { staff: row, email: row.email };
  };
  const availOf = async (unitTypeId: string, date: string) =>
    (await s.db.select().from(inventoryDaily)
      .where(and(eq(inventoryDaily.unitTypeId, unitTypeId), eq(inventoryDaily.date, date))))[0].available;
  const refunds = () => s.db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund")));
  const audits = () => s.db.select().from(auditLog).where(and(eq(auditLog.entityId, res.id), eq(auditLog.action, "reservation.modify")));
  const rooms = () => s.db.select().from(reservationRooms).where(eq(reservationRooms.reservationId, res.id));
  return {
    ...s, code, id: res.id, total: res.totalAmount, mk, refunds, audits, rooms,
    frontDesk: await mk("front_desk"),
    avail: (date: string) => availOf(s.ids.unitTypeId, date),
    availOf,
  };
}

const change = (o: Partial<ModificationChange> = {}): ModificationChange =>
  ({ checkIn: "2026-12-01", checkOut: "2026-12-03", adults: 2, children: 0, ...o });

const opts = (expectedDifference: number, reason = REASON) => ({ expectedDifference, reason });

afterEach(() => {
  vi.restoreAllMocks();
});

test("2 nights → 3: the difference is owed, the balance due grows, only the new night is taken", async () => {
  const s = await confirmed();
  const c = change({ checkOut: "2026-12-04" });
  const preview = await previewModification(s.db, s.frontDesk, s.id, c, AT);
  expect(preview).toMatchObject({ ok: true, difference: 2000, refundIfLower: 0, balanceIfHigher: 2000, newQuote: { nights: 3, total: 6000 } });

  const refund = vi.spyOn(s.gateway, "refund");
  expect(await applyModification(s.deps, s.frontDesk, s.id, c, opts(2000), AT))
    .toMatchObject({ ok: true, difference: 2000, refunded: 0, frontDeskRefundDue: 0, balanceDue: 2000 });
  expect(refund).not.toHaveBeenCalled();

  expect(await s.reservation(s.code)).toMatchObject({
    checkIn: "2026-12-01", checkOut: "2026-12-04", totalAmount: 6000, modCount: 1, syncState: "synced",
    quote: expect.objectContaining({ nights: 3, total: 6000 }),
  });
  expect(await s.avail("2026-12-01")).toBe(2); // overlapping nights: untouched
  expect(await s.avail("2026-12-02")).toBe(2);
  expect(await s.avail("2026-12-03")).toBe(2); // the new night: one fewer
  expect(await s.avail("2026-12-04")).toBe(3);
  expect(await s.rooms()).toMatchObject([{ unitTypeId: s.ids.unitTypeId, nightlyPrices: [2000, 2000, 2000] }]);
  expect(s.channel.pushed.find((p) => p.code === s.code)).toMatchObject({ checkOut: "2026-12-04", total: 6000 });
  expect(await s.audits()).toMatchObject([{
    staffEmail: s.frontDesk.email,
    before: expect.objectContaining({ checkOut: "2026-12-03", total: 4000 }),
    after: expect.objectContaining({ checkOut: "2026-12-04", total: 6000, difference: 2000, reason: REASON, modCount: 1 }),
  }]);
  // The guest is told once, in the booking's language.
  const mails = s.email.sent.filter((e) => e.to === GUEST && e.subject.includes("changed"));
  expect(mails).toHaveLength(1);
  expect(mails[0].text).toContain("2026-12-04");
  expect(mails[0].text).toContain("NT$2,000");
});

test("3 nights → 2: the difference is refunded once under modify:<id>:1; resending the request refunds nothing more", async () => {
  const s = await confirmed({ nights: 3 });
  expect(s.total).toBe(6000);
  const c = change({ checkOut: "2026-12-03" });
  expect(await previewModification(s.db, s.frontDesk, s.id, c, AT))
    .toMatchObject({ ok: true, difference: -2000, refundIfLower: 2000, balanceIfHigher: 0 });

  const refund = vi.spyOn(s.gateway, "refund");
  expect(await applyModification(s.deps, s.frontDesk, s.id, c, opts(-2000), AT))
    .toMatchObject({ ok: true, difference: -2000, refunded: 2000, frontDeskRefundDue: 0, balanceDue: 0 });
  expect(refund).toHaveBeenCalledTimes(1);
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ amount: 2000, idempotencyKey: `modify:${s.id}:1` }));
  expect(await s.refunds()).toMatchObject([{ status: "succeeded", amount: 2000, idempotencyKey: `modify:${s.id}:1` }]);
  expect(await s.avail("2026-12-03")).toBe(3); // released
  expect(await s.avail("2026-12-01")).toBe(2);

  // The same request again: the booking is already 2 nights, so the difference is 0 now, not -2000.
  expect(await applyModification(s.deps, s.frontDesk, s.id, c, opts(-2000), minutes(11))).toEqual({ ok: false, error: "PRICE_CHANGED" });
  expect(refund).toHaveBeenCalledTimes(1);
  expect(await s.refunds()).toHaveLength(1);
  expect(await s.reservation(s.code)).toMatchObject({ modCount: 1, totalAmount: 4000 });
  const mails = s.email.sent.filter((e) => e.to === GUEST && e.subject.includes("changed"));
  expect(mails).toHaveLength(1);
  expect(mails[0].text).toContain("NT$2,000");
});

test("a lower price paid partly at the front desk refunds the online net and leaves the rest to the desk", async () => {
  const s = await confirmed({ nights: 3 });
  // 6000 paid online, of which 3000 was already refunded, and 3000 paid at the desk: online net 3000, received 6000.
  const [charge] = await s.db.select().from(payments).where(and(eq(payments.reservationId, s.id), eq(payments.kind, "charge")));
  await s.db.insert(payments).values([
    { id: "fd-1", reservationId: s.id, kind: "front_desk", method: "cash", amount: 3000, status: "succeeded", createdAt: AT.getTime() },
    {
      id: "rf-0", reservationId: s.id, kind: "refund", method: "sinopac_online", amount: 3000, status: "succeeded",
      refundOf: charge.id, idempotencyKey: "test:partial", createdAt: AT.getTime(),
    },
  ]);
  const c = change({ checkOut: "2026-12-02" }); // 3 nights → 1: -4000
  expect(await previewModification(s.db, s.frontDesk, s.id, c, AT))
    .toMatchObject({ ok: true, difference: -4000, refundIfLower: 3000, frontDeskRefundIfLower: 1000 });
  expect(await applyModification(s.deps, s.frontDesk, s.id, c, opts(-4000), AT))
    .toMatchObject({ ok: true, refunded: 3000, frontDeskRefundDue: 1000 });
  expect(await s.reservation(s.code)).toMatchObject({ totalAmount: 2000, frontDeskRefundDue: 1000 });
});

test("dates with no room left: NOT_AVAILABLE, and inventory, booking and quote are untouched", async () => {
  const s = await confirmed();
  await setAri(s.db, s.ids.unitTypeId, s.ids.ratePlanId, "2026-12-03", { available: 0 });
  const before = await s.reservation(s.code);
  const c = change({ checkOut: "2026-12-04" });
  expect(await previewModification(s.db, s.frontDesk, s.id, c, AT)).toEqual({ ok: false, error: "NOT_AVAILABLE" });
  expect(await applyModification(s.deps, s.frontDesk, s.id, c, opts(2000), AT)).toEqual({ ok: false, error: "NOT_AVAILABLE" });
  expect(await s.reservation(s.code)).toEqual(before);
  expect(await s.avail("2026-12-01")).toBe(2);
  expect(await s.avail("2026-12-02")).toBe(2);
  expect(await s.avail("2026-12-03")).toBe(0);
  expect(await s.audits()).toEqual([]);
});

test("the last room taken between the preview and the batch: the CHECK rolls everything back, NOT_AVAILABLE", async () => {
  const s = await confirmed();
  const before = await s.reservation(s.code);
  // Another booking takes 12-03's last rooms just before this request's batch runs (tests run runAtomic as a transaction).
  const real = s.db.transaction.bind(s.db);
  vi.spyOn(s.db, "transaction").mockImplementationOnce(((fn: never) => {
    s.db.update(inventoryDaily).set({ available: 0 })
      .where(and(eq(inventoryDaily.unitTypeId, s.ids.unitTypeId), eq(inventoryDaily.date, "2026-12-03"))).run();
    return real(fn);
  }) as never);
  // 12-01 → 12-02 → 12-04 moves the stay: 12-01 released, 12-03 taken; the failed hold must undo the release too.
  const c = change({ checkIn: "2026-12-02", checkOut: "2026-12-04" });
  expect(await applyModification(s.deps, s.frontDesk, s.id, c, opts(0), AT)).toEqual({ ok: false, error: "NOT_AVAILABLE" });
  expect(await s.reservation(s.code)).toEqual(before);
  expect(await s.avail("2026-12-01")).toBe(2);
  expect(await s.avail("2026-12-02")).toBe(2);
  expect(await s.avail("2026-12-03")).toBe(0);
  expect(await s.rooms()).toMatchObject([{ nightlyPrices: [2000, 2000] }]);
  expect(await s.audits()).toEqual([]);
});

test("an expectedDifference that no longer matches is PRICE_CHANGED and changes nothing", async () => {
  const s = await confirmed();
  const before = await s.reservation(s.code);
  const c = change({ checkOut: "2026-12-04" });
  await setAri(s.db, s.ids.unitTypeId, s.ids.ratePlanId, "2026-12-03", { price: 2500 });
  expect(await applyModification(s.deps, s.frontDesk, s.id, c, opts(2000), AT)).toEqual({ ok: false, error: "PRICE_CHANGED" });
  expect(await s.reservation(s.code)).toEqual(before);
  expect(await s.avail("2026-12-03")).toBe(3);
  expect(await s.audits()).toEqual([]);
});

test("a retryable channel failure leaves the sync pending; the next change goes out as a modify with the latest stay, never a push", async () => {
  const s = await confirmed();
  const modify = vi.spyOn(s.channel, "modifyReservation")
    .mockResolvedValueOnce({ ok: false, retryable: true, error: "SM_TIMEOUT" });
  const push = vi.spyOn(s.channel, "pushReservation");
  const c = change({ checkOut: "2026-12-04" });
  expect(await applyModification(s.deps, s.frontDesk, s.id, c, opts(2000), AT)).toMatchObject({ ok: true });
  expect(await s.reservation(s.code)).toMatchObject({ status: "confirmed", checkOut: "2026-12-04", syncState: "pending", syncAttempts: 1, lastSyncError: "SM_TIMEOUT" });
  // A pending sync does not block another modification (M-3): its hand-off simply carries the latest stay.
  expect(await applyModification(s.deps, s.frontDesk, s.id, change({ checkOut: "2026-12-05" }), opts(2000), minutes(11))).toMatchObject({ ok: true, modCount: 2 });
  expect(modify).toHaveBeenCalledTimes(2);
  expect(push).not.toHaveBeenCalled();
  expect(modify.mock.calls[1][0]).toMatchObject({ code: s.code, checkOut: "2026-12-05", total: 8000 });
  expect(await s.reservation(s.code)).toMatchObject({ status: "confirmed", modCount: 2, syncState: "synced", syncAttempts: 0, lastSyncError: null });
  expect(await runSyncRetry(s.deps, minutes(16))).toEqual({ attempted: 0 });
});

test("with no channel configured (offline mode) two modifications in a row both succeed; the sync waits, then sends the latest (M-3)", async () => {
  const s = await confirmed();
  const offline = new MockChannelManager();
  const off = async () => { throw new BookingDisabledError("CHANNEL_MODE_NOT_SET"); };
  offline.modifyReservation = off;
  offline.cancelReservation = off;
  offline.pushReservation = off;
  const deps = { ...s.deps, channel: offline };
  expect(await applyModification(deps, s.frontDesk, s.id, change({ checkOut: "2026-12-04" }), opts(2000), AT)).toMatchObject({ ok: true, modCount: 1 });
  expect(await s.reservation(s.code)).toMatchObject({ syncState: "pending", lastSyncError: "CHANNEL_MODE_NOT_SET" });
  expect(await previewModification(s.db, s.frontDesk, s.id, change({ checkOut: "2026-12-05" }), minutes(11))).toMatchObject({ ok: true, difference: 2000 });
  expect(await applyModification(deps, s.frontDesk, s.id, change({ checkOut: "2026-12-05" }), opts(2000), minutes(11))).toMatchObject({ ok: true, modCount: 2 });
  expect(await s.reservation(s.code)).toMatchObject({ checkOut: "2026-12-05", totalAmount: 8000, modCount: 2, syncState: "pending" });

  // Once a channel is configured, the retry job sends ONE modify with the current state.
  const modify = vi.spyOn(s.channel, "modifyReservation");
  expect(await runSyncRetry(s.deps, minutes(30))).toEqual({ attempted: 1 });
  expect(modify).toHaveBeenCalledTimes(1);
  expect(modify.mock.calls[0][0]).toMatchObject({ code: s.code, checkOut: "2026-12-05", total: 8000 });
  expect(await s.reservation(s.code)).toMatchObject({ syncState: "synced" });
});

test("a staff cancel in offline mode waits for the channel, and the retry job then sends a cancel (M-3)", async () => {
  const s = await confirmed();
  const offline = new MockChannelManager();
  offline.cancelReservation = async () => { throw new BookingDisabledError("CHANNEL_MODE_NOT_SET"); };
  expect(await applyModification(s.deps, s.frontDesk, s.id, change({ checkOut: "2026-12-04" }), opts(2000), AT)).toMatchObject({ ok: true });
  const manager = await s.mk("manager");
  expect(await staffCancel({ ...s.deps, channel: offline }, manager, s.id, { reason: "x", notifyGuest: false, refundOverride: 0 }, minutes(11)))
    .toMatchObject({ ok: true, refunded: 0 });
  expect(await s.reservation(s.code)).toMatchObject({ status: "cancelled", syncState: "pending" });
  const cancel = vi.spyOn(s.channel, "cancelReservation");
  const modify = vi.spyOn(s.channel, "modifyReservation");
  expect(await runSyncRetry(s.deps, minutes(30))).toEqual({ attempted: 1 });
  expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ code: s.code }), (await s.reservation(s.code)).smConfirmation);
  expect(modify).not.toHaveBeenCalled();
  expect(await s.reservation(s.code)).toMatchObject({ status: "cancelled", syncState: "synced" });
});

test("a non-retryable channel failure alerts staff and keeps the booking (no automatic cancel)", async () => {
  const s = await confirmed();
  vi.spyOn(s.channel, "modifyReservation").mockResolvedValueOnce({ ok: false, retryable: false, error: "SM_REJECTED" });
  const cancel = vi.spyOn(s.channel, "cancelReservation");
  expect(await applyModification(s.deps, s.frontDesk, s.id, change({ checkOut: "2026-12-04" }), opts(2000), AT)).toMatchObject({ ok: true });
  expect(await s.reservation(s.code)).toMatchObject({ status: "confirmed", checkOut: "2026-12-04", syncState: "failed", lastSyncError: "SM_REJECTED" });
  expect(cancel).not.toHaveBeenCalled();
  // Staff are told by the next retry run (and daily while it stays so); nothing is retried automatically.
  expect(await runSyncRetry(s.deps, minutes(15))).toEqual({ attempted: 0, alerted: [s.code] });
  expect(await s.db.select().from(notifications).where(and(eq(notifications.reservationId, s.id), eq(notifications.kind, "staff_sync_failed"))))
    .toMatchObject([{ ref: "channel-unsynced:2026-11-24" }]);
});

test("a failed refund keeps the new stay, records the error and alerts staff with the refund row as ref", async () => {
  const s = await confirmed({ nights: 3 });
  vi.spyOn(s.gateway, "refund").mockResolvedValueOnce({ ok: false, error: "GATEWAY_DOWN" });
  expect(await applyModification(s.deps, s.frontDesk, s.id, change(), opts(-2000), AT))
    .toMatchObject({ ok: true, refunded: 0, refundFailed: true });
  const res = await s.reservation(s.code);
  expect(res).toMatchObject({ checkOut: "2026-12-03", totalAmount: 4000, modCount: 1 });
  expect(res.lastSyncError).toContain("GATEWAY_DOWN");
  const [row] = await s.refunds();
  expect(row).toMatchObject({ status: "failed", amount: 2000, idempotencyKey: `modify:${s.id}:1` });
  expect(await s.db.select().from(notifications).where(and(eq(notifications.reservationId, s.id), eq(notifications.kind, "staff_payment_alert"))))
    .toMatchObject([{ ref: row.id }]);
  // Until that refund is settled, the booking cannot be modified again.
  expect(await previewModification(s.db, s.frontDesk, s.id, change({ checkOut: "2026-12-04" }), minutes(20)))
    .toEqual({ ok: false, error: "NOT_MODIFIABLE" });
});

test("changing the room type takes every night of the new type and gives back every night of the old one", async () => {
  const s = await confirmed();
  const [female] = await s.db.select().from(unitTypes).where(eq(unitTypes.slug, "female-cube"));
  const c = change({ checkIn: "2026-12-02", checkOut: "2026-12-04", unitTypeSlug: "female-cube" });
  expect(await applyModification(s.deps, s.frontDesk, s.id, c, opts(0), AT)).toMatchObject({ ok: true, difference: 0 });
  expect(await s.avail("2026-12-01")).toBe(3);
  expect(await s.avail("2026-12-02")).toBe(3);
  expect(await s.availOf(female.id, "2026-12-02")).toBe(2);
  expect(await s.availOf(female.id, "2026-12-03")).toBe(2);
  expect(await s.rooms()).toMatchObject([{ unitTypeId: female.id }]);
});

test("add-ons are kept and re-priced for the new nights and guests; per-stay ones stay as they were", async () => {
  const s = await confirmed({ addons: [{ slug: "breakfast", qty: 1 }, { slug: "parking", qty: 1 }, { slug: "flowers", qty: 1 }] });
  // 2 nights: 4000 + breakfast 150×2×2 + parking 200×2 + flowers 500 = 5500
  expect(s.total).toBe(5500);
  await s.db.update(addons).set({ price: 999 }); // today's prices do not matter: the booked ones are kept
  const p = await previewModification(s.db, s.frontDesk, s.id, change({ checkOut: "2026-12-04", adults: 1 }), AT);
  // 3 nights, 1 adult: 6000 + breakfast 150×1×3 + parking 200×3 + flowers 500 = 7550
  expect(p).toMatchObject({ ok: true, difference: 2050, newQuote: { total: 7550, addonSubtotal: 1550 } });
});

test("a booking whose stay has begun, or whose cancellation has started, is NOT_MODIFIABLE", async () => {
  const s = await confirmed();
  expect(await previewModification(s.db, s.frontDesk, s.id, change({ checkIn: "2026-12-02", checkOut: "2026-12-04" }), AFTER_CHECKIN))
    .toEqual({ ok: false, error: "NOT_MODIFIABLE" });
  expect(await applyModification(s.deps, s.frontDesk, s.id, change({ checkIn: "2026-12-02", checkOut: "2026-12-04" }), opts(0), AFTER_CHECKIN))
    .toEqual({ ok: false, error: "NOT_MODIFIABLE" });

  const b = await confirmed();
  expect(await staffCancel(b.deps, b.frontDesk, b.id, { reason: "x", notifyGuest: false }, AT)).toMatchObject({ ok: true });
  expect(await applyModification(b.deps, b.frontDesk, b.id, change({ checkOut: "2026-12-04" }), opts(2000), AT))
    .toEqual({ ok: false, error: "NOT_MODIFIABLE" });
});

test("a booking changed after the preview was read is CONFLICT", async () => {
  const s = await confirmed();
  const c = change({ checkOut: "2026-12-04" });
  // Another write lands between this request's re-preview and its batch (tests run runAtomic as a transaction).
  const real = s.db.transaction.bind(s.db);
  vi.spyOn(s.db, "transaction").mockImplementationOnce(((fn: never) => {
    s.db.update(reservations).set({ updatedAt: AT.getTime() + 1 }).where(eq(reservations.id, s.id)).run();
    return real(fn);
  }) as never);
  expect(await applyModification(s.deps, s.frontDesk, s.id, c, opts(2000), AT)).toEqual({ ok: false, error: "CONFLICT" });
  expect(await s.reservation(s.code)).toMatchObject({ checkOut: "2026-12-03", modCount: 0 });
  expect(await s.avail("2026-12-03")).toBe(3);
  expect(await s.audits()).toEqual([]);
});

test("input is validated; marketing may not modify, another property's booking is NOT_FOUND", async () => {
  const s = await confirmed();
  expect(await previewModification(s.db, s.frontDesk, s.id, change({ checkOut: "2026-12-01" }), AT)).toEqual({ ok: false, error: "INVALID_INPUT" });
  expect(await previewModification(s.db, s.frontDesk, s.id, change({ adults: 0 }), AT)).toEqual({ ok: false, error: "INVALID_INPUT" });
  expect(await previewModification(s.db, s.frontDesk, s.id, change({ adults: 3 }), AT)).toEqual({ ok: false, error: "NOT_AVAILABLE" }); // a cube sleeps 2
  expect(await applyModification(s.deps, s.frontDesk, s.id, change(), opts(0, "  "), AT)).toEqual({ ok: false, error: "REASON_REQUIRED" });
  expect(await previewModification(s.db, await s.mk("marketing"), s.id, change(), AT)).toEqual({ ok: false, error: "FORBIDDEN" });
  expect(await applyModification(s.deps, await s.mk("marketing"), s.id, change(), opts(0), AT)).toEqual({ ok: false, error: "FORBIDDEN" });
  expect(await previewModification(s.db, await s.mk("manager", ["prop-other"]), s.id, change(), AT)).toEqual({ ok: false, error: "NOT_FOUND" });
});

test("the modify routes answer 403 to marketing", async () => {
  const s = await confirmed();
  await s.db.insert(staff).values({ id: "mkt", email: "mkt@nk.test", name: "mkt", role: "marketing", propertyIds: [s.propertyId], active: true });
  vi.resetModules();
  vi.doMock("@/lib/db/client", () => ({ getDb: async () => s.db }));
  vi.doMock("@/lib/runtime/env", () => ({ appEnv: async () => ({ ENVIRONMENT: "local", DEV_STAFF_EMAIL: "mkt@nk.test" }) }));
  try {
    const apply = await import("@/app/api/admin/reservations/[id]/modify/route");
    const preview = await import("@/app/api/admin/reservations/[id]/modify/preview/route");
    const route = { params: Promise.resolve({ id: s.id }) };
    const body = JSON.stringify({ ...change({ checkOut: "2026-12-04" }), expectedDifference: 2000, reason: REASON });
    const req = (path: string) => new Request(`http://x/api/admin/reservations/${s.id}/${path}`, { method: "POST", body });
    expect((await apply.POST(req("modify"), route)).status).toBe(403);
    expect((await preview.POST(req("modify/preview"), route)).status).toBe(403);
    expect(await s.reservation(s.code)).toMatchObject({ checkOut: "2026-12-03", modCount: 0 });
  } finally {
    vi.doUnmock("@/lib/db/client");
    vi.doUnmock("@/lib/runtime/env");
  }
});
