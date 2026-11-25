import { and, eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import type { StaffContext } from "@/lib/admin/auth";
import { staffCancel } from "@/lib/admin/staff-cancel";
import { cancelReservation } from "@/lib/booking/manage";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { auditLog, inventoryDaily, payments, reservations, staff } from "@/lib/db/schema";
import { fillAri } from "@/tests/helpers/ari";
import { bookingSetup, minutes, STAFF } from "@/tests/helpers/booking";

const PAID = 4960; // 2 nights × 2480
const GUEST = "mei@example.com";
const EARLY = new Date("2026-12-06T16:00:00Z"); // 2026-12-07 Taipei: 3 days before → 100%
const HALF = new Date("2026-12-08T16:00:00Z"); // 2026-12-09 Taipei: 1 day before → 50%
const NIGHT2 = new Date("2026-12-10T16:00:00Z"); // 2026-12-11 Taipei: second night of the stay
const AFTER_CHECKOUT = new Date("2026-12-12T16:00:00Z"); // 2026-12-13 Taipei
const REASON = "旅客來電要求取消";

/** A confirmed booking for 2026-12-10 → 12-12, paid 4960, plus front-desk and manager staff at its property. */
async function confirmedBooking(o: { failRefund?: boolean } = {}) {
  const s = await bookingSetup(o);
  await fillAri(s.db, s.propertyId, "2026-12-10", 2, { available: 3, price: 2480 });
  const code = await s.book({ checkIn: "2026-12-10", checkOut: "2026-12-12" });
  await handlePaymentNotice(s.deps, await s.notice(code, { amount: PAID }), minutes(2));
  const res = await s.reservation(code);
  expect(res.status).toBe("confirmed");
  const mk = async (role: "front_desk" | "manager", propertyIds = [s.propertyId]): Promise<StaffContext> => {
    const row = { id: `s-${role}-${propertyIds.join()}`, email: `${role}@nk.test`, name: role, role, propertyIds, active: true };
    await s.db.insert(staff).values(row).onConflictDoNothing();
    return { staff: row, email: row.email };
  };
  const avail = async (date: string) =>
    (await s.db.select().from(inventoryDaily)
      .where(and(eq(inventoryDaily.unitTypeId, s.ids.unitTypeId), eq(inventoryDaily.date, date))))[0].available;
  const refunds = () => s.db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund")));
  const audits = () => s.db.select().from(auditLog).where(eq(auditLog.entityId, res.id));
  return { ...s, code, id: res.id, frontDesk: await mk("front_desk"), manager: await mk("manager"), mk, avail, refunds, audits };
}

const opts = (o: Partial<Parameters<typeof staffCancel>[3]> = {}) => ({ reason: REASON, notifyGuest: true, ...o });

test("a staff cancel by the rules refunds 50% the day before, exactly as a guest cancel would, under cancel:<id>", async () => {
  const { deps, gateway, email, frontDesk, id, code, reservation, refunds, avail, audits } = await confirmedBooking();
  const refund = vi.spyOn(gateway, "refund");
  expect(await staffCancel(deps, frontDesk, id, opts(), HALF)).toEqual({ ok: true, refunded: PAID / 2, alreadyCancelled: false });

  expect(await reservation(code)).toMatchObject({ status: "cancelled", refundedAmount: PAID / 2, cancelledAt: HALF.getTime(), syncState: "synced" });
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ amount: PAID / 2, idempotencyKey: `cancel:${id}` }));
  expect(await refunds()).toMatchObject([{ status: "succeeded", amount: PAID / 2, idempotencyKey: `cancel:${id}` }]);
  expect(await avail("2026-12-10")).toBe(3);
  expect(await avail("2026-12-11")).toBe(3);
  expect(email.sent.filter((e) => e.to === GUEST && e.subject.includes("cancelled"))).toHaveLength(1);
  // A guest cancel afterwards sees the same, finished cancellation.
  expect(await cancelReservation(deps, code, GUEST, HALF)).toEqual({ ok: true, refunded: PAID / 2, alreadyCancelled: true });
  expect(await audits()).toMatchObject([{
    action: "reservation.cancel", entity: "reservation", staffEmail: frontDesk.email,
    after: expect.objectContaining({ reason: REASON, refunded: PAID / 2 }),
  }]);
});

test("a staff cancel and a guest cancel at the same time refund once", async () => {
  const { deps, gateway, frontDesk, id, code, reservation } = await confirmedBooking();
  const refund = vi.spyOn(gateway, "refund");
  const [a, b] = await Promise.all([
    staffCancel(deps, frontDesk, id, opts(), HALF),
    cancelReservation(deps, code, GUEST, HALF),
  ]);
  expect(refund).toHaveBeenCalledTimes(1);
  expect([a, b].filter((r) => r.ok && !r.alreadyCancelled)).toHaveLength(1);
  expect(await reservation(code)).toMatchObject({ status: "cancelled", refundedAmount: PAID / 2 });
});

test("front desk may not override the refund: FORBIDDEN and nothing changes", async () => {
  const { deps, gateway, frontDesk, id, code, reservation, refunds, audits } = await confirmedBooking();
  const refund = vi.spyOn(gateway, "refund");
  expect(await staffCancel(deps, frontDesk, id, opts({ refundOverride: 1000 }), HALF)).toEqual({ ok: false, error: "FORBIDDEN" });
  expect(await reservation(code)).toMatchObject({ status: "confirmed", cancelledAt: null, refundedAmount: 0 });
  expect(await refunds()).toEqual([]);
  expect(await audits()).toEqual([]);
  expect(refund).not.toHaveBeenCalled();
});

test("a manager's override must be a whole amount between 0 and the net paid", async () => {
  const { deps, manager, id, code, reservation, refunds } = await confirmedBooking();
  expect(await staffCancel(deps, manager, id, opts({ refundOverride: PAID + 1 }), HALF)).toEqual({ ok: false, error: "OVERRIDE_EXCEEDS_PAID" });
  expect(await staffCancel(deps, manager, id, opts({ refundOverride: 1.5 }), HALF)).toEqual({ ok: false, error: "INVALID_OVERRIDE" });
  expect(await staffCancel(deps, manager, id, opts({ refundOverride: -1 }), HALF)).toEqual({ ok: false, error: "INVALID_OVERRIDE" });
  expect(await reservation(code)).toMatchObject({ status: "confirmed", cancelledAt: null });
  expect(await refunds()).toEqual([]);
});

test("a manager's override refunds that amount through the same cancel:<id> intent", async () => {
  const { deps, gateway, manager, id, code, reservation, refunds, audits } = await confirmedBooking();
  const refund = vi.spyOn(gateway, "refund");
  expect(await staffCancel(deps, manager, id, opts({ refundOverride: 1234 }), HALF)).toEqual({ ok: true, refunded: 1234, alreadyCancelled: false });
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ amount: 1234, idempotencyKey: `cancel:${id}` }));
  expect(await reservation(code)).toMatchObject({ status: "cancelled", refundedAmount: 1234 });
  expect(await refunds()).toMatchObject([{ amount: 1234, idempotencyKey: `cancel:${id}` }]);
  expect((await audits())[0].after).toMatchObject({ reason: REASON, refundOverride: 1234, refunded: 1234 });
});

test("an override does not replace an existing cancellation intent: its amount wins and the result says so", async () => {
  const { deps, gateway, manager, id, code, reservation } = await confirmedBooking({ failRefund: true });
  expect(await cancelReservation(deps, code, GUEST, EARLY)).toEqual({ ok: false, error: "REFUND_FAILED" }); // intent row: failed, PAID
  vi.spyOn(gateway, "refund").mockResolvedValueOnce({ ok: true, refundRef: "R-2" });
  expect(await staffCancel(deps, manager, id, opts({ refundOverride: 100 }), HALF))
    .toEqual({ ok: true, refunded: PAID, alreadyCancelled: false, overrideIgnored: true });
  expect(await reservation(code)).toMatchObject({ status: "cancelled", refundedAmount: PAID });
});

test("cancelling during the stay releases only tonight and later; after check-out nothing is released", async () => {
  const a = await confirmedBooking();
  expect(await a.avail("2026-12-10")).toBe(2);
  expect(await staffCancel(a.deps, a.frontDesk, a.id, opts(), NIGHT2)).toEqual({ ok: true, refunded: 0, alreadyCancelled: false });
  expect(await a.reservation(a.code)).toMatchObject({ status: "cancelled" });
  expect(await a.avail("2026-12-10")).toBe(2); // the night already stayed stays sold
  expect(await a.avail("2026-12-11")).toBe(3);

  const b = await confirmedBooking();
  const cancel = vi.spyOn(b.channel, "cancelReservation");
  expect(await staffCancel(b.deps, b.frontDesk, b.id, opts(), AFTER_CHECKOUT)).toEqual({ ok: true, refunded: 0, alreadyCancelled: false });
  expect(await b.avail("2026-12-10")).toBe(2);
  expect(await b.avail("2026-12-11")).toBe(2);
  expect(cancel).toHaveBeenCalledWith(b.code);
});

test("another property's booking is NOT_FOUND, revealing nothing", async () => {
  const { deps, mk, id, code, reservation, audits } = await confirmedBooking();
  const elsewhere = await mk("manager", ["prop-other"]);
  expect(await staffCancel(deps, elsewhere, id, opts(), HALF)).toEqual({ ok: false, error: "NOT_FOUND" });
  expect(await staffCancel(deps, elsewhere, "no-such-id", opts(), HALF)).toEqual({ ok: false, error: "NOT_FOUND" });
  expect((await reservation(code)).status).toBe("confirmed");
  expect(await audits()).toEqual([]);
});

test("the reason is required", async () => {
  const { deps, frontDesk, id, code, reservation } = await confirmedBooking();
  expect(await staffCancel(deps, frontDesk, id, opts({ reason: "   " }), HALF)).toEqual({ ok: false, error: "REASON_REQUIRED" });
  expect((await reservation(code)).status).toBe("confirmed");
});

test("staff may skip the guest email; staff are still told", async () => {
  const { deps, email, frontDesk, id } = await confirmedBooking();
  await staffCancel(deps, frontDesk, id, opts({ notifyGuest: false }), HALF);
  expect(email.sent.filter((e) => e.to === GUEST && e.subject.includes("cancelled"))).toHaveLength(0);
  expect(email.sent.filter((e) => e.to === STAFF).length).toBeGreaterThan(0);
});

test("without online payments, a zero-refund cancel still works and a paying one is refused untouched", async () => {
  const { deps, gateway, manager, frontDesk, id, code, reservation, refunds, db } = await confirmedBooking();
  const refund = vi.spyOn(gateway, "refund");
  expect(await staffCancel(deps, frontDesk, id, opts({ paymentsUnavailable: true }), HALF)).toEqual({ ok: false, error: "PAYMENTS_UNAVAILABLE" });
  expect(await reservation(code)).toMatchObject({ status: "confirmed", cancelledAt: null });

  expect(await staffCancel(deps, manager, id, opts({ refundOverride: 0, paymentsUnavailable: true }), HALF))
    .toEqual({ ok: true, refunded: 0, alreadyCancelled: false });
  expect(refund).not.toHaveBeenCalled();
  expect(await refunds()).toEqual([]);
  expect((await db.select().from(reservations).where(eq(reservations.id, id)))[0].status).toBe("cancelled");
});
