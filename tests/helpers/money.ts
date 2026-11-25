import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
import type { StaffContext } from "@/lib/admin/auth";
import { recordFrontDeskPayment } from "@/lib/admin/front-desk";
import { applyModification, previewModification, type ModificationChange } from "@/lib/admin/modify";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { payments, ratePlans, staff } from "@/lib/db/schema";
import { setAri } from "./ari";
import { bookingSetup, minutes } from "./booking";

export const AT = minutes(10); // 2026-11-24 Taipei: 7 days before check-in → 100% by the default policy
export const REASON = "旅客來電要求改期";

/** One night: 12-01 alone, 4000. */
export const ONE_NIGHT: ModificationChange = { checkIn: "2026-12-01", checkOut: "2026-12-02", adults: 2, children: 0 };
/** Both nights again: 12-01 + 12-02, 10000. */
export const TWO_NIGHTS: ModificationChange = { ...ONE_NIGHT, checkOut: "2026-12-03" };

/**
 * A confirmed booking for 12-01 → 12-03 totalling 10000 (4000 + 6000). `deposit`: the plan takes 30% online
 * (3000), else the whole 10000 is paid online. `desk`: that much is then also paid at the front desk.
 */
export async function tenK(o: { deposit?: boolean; desk?: number } = {}) {
  const s = await bookingSetup();
  await setAri(s.db, s.ids.unitTypeId, s.ids.ratePlanId, "2026-12-01", { price: 4000 });
  await setAri(s.db, s.ids.unitTypeId, s.ids.ratePlanId, "2026-12-02", { price: 6000 });
  if (o.deposit) await s.db.update(ratePlans).set({ paymentMode: "deposit", depositPct: 30 }).where(eq(ratePlans.id, s.ids.ratePlanId));
  const code = await s.book();
  const pending = await s.reservation(code);
  expect(pending.totalAmount).toBe(10000);
  await handlePaymentNotice(s.deps, await s.notice(code, { amount: o.deposit ? 3000 : 10000 }), minutes(2));
  const id = pending.id;
  const mk = async (role: "front_desk" | "manager" | "owner"): Promise<StaffContext> => {
    const row = { id: `s-${role}`, email: `${role}@nk.test`, name: role, role, propertyIds: [s.propertyId], active: true };
    await s.db.insert(staff).values(row).onConflictDoNothing();
    return { staff: row, email: row.email };
  };
  const frontDesk = await mk("front_desk");
  if (o.desk) expect(await recordFrontDeskPayment(s.db, frontDesk, id, { method: "cash", amount: o.desk }, minutes(5))).toMatchObject({ ok: true });
  expect((await s.reservation(code)).status).toBe("confirmed");
  const refunds = () => s.db.select().from(payments).where(and(eq(payments.reservationId, id), eq(payments.kind, "refund")));
  const marketing: StaffContext = { staff: { id: "s-mkt", email: "mkt@nk.test", name: "mkt", role: "marketing", propertyIds: [s.propertyId], active: true }, email: "mkt@nk.test" };
  const modify = async (c: ModificationChange, at = AT) => {
    const p = await previewModification(s.db, frontDesk, id, c, at);
    if (!p.ok) throw new Error(JSON.stringify(p));
    return applyModification(s.deps, frontDesk, id, c, { expectedDifference: p.difference, reason: REASON }, at);
  };
  return { ...s, code, id, frontDesk, marketing, manager: await mk("manager"), mk, refunds, modify, row: () => s.reservation(code) };
}

