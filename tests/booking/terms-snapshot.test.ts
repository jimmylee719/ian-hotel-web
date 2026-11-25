import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { updateRatePlan } from "@/lib/admin/commerce";
import { applyModification, previewModification, type ModificationChange } from "@/lib/admin/modify";
import type { StaffContext } from "@/lib/admin/auth";
import { cancelReservation, findReservation } from "@/lib/booking/manage";
import { cancellationText, emailContext } from "@/lib/booking/notify";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { ariDaily, ratePlans, reservations, staff, type CancelPolicy } from "@/lib/db/schema";
import { bookingSetup, minutes, PAY_NOW } from "../helpers/booking";

const GUEST = "mei@example.com";
const ORIGINAL: CancelPolicy = { rules: [{ daysBefore: 3, refundPct: 100 }, { daysBefore: 1, refundPct: 50 }] };
const EARLY = new Date("2026-11-24T02:00:00Z"); // far before check-in: the original policy refunds 100%

async function confirmed() {
  const s = await bookingSetup();
  const code = await s.book({ checkIn: "2026-12-01", checkOut: "2026-12-03" });
  await handlePaymentNotice(s.deps, await s.notice(code, { amount: PAY_NOW }), minutes(2));
  const res = await s.reservation(code);
  expect(res.status).toBe("confirmed");
  const row = { id: "own", email: "owner@nk.test", name: "o", role: "owner" as const, propertyIds: [s.propertyId], active: true };
  await s.db.insert(staff).values(row);
  const owner: StaffContext = { staff: row, email: row.email };
  return { ...s, code, res, owner };
}

test("the booking stores the plan's policy and name as booked", async () => {
  const { res } = await confirmed();
  expect(res.cancelPolicy).toEqual(ORIGINAL);
  expect(res.ratePlanName["en"]).toContain("Direct");
});

test("editing the plan to 0% refund does not change what an existing booking is refunded", async () => {
  const { db, deps, owner, code, ids } = await confirmed();
  const none: CancelPolicy = { rules: [{ daysBefore: 0, refundPct: 0 }] };
  expect(await updateRatePlan(db, owner, ids.ratePlanId, { cancelPolicy: none }, minutes(3))).toEqual({ ok: true });
  expect((await db.select().from(ratePlans).where(eq(ratePlans.id, ids.ratePlanId)))[0].cancelPolicy).toEqual(none);
  expect(await cancelReservation(deps, code, GUEST, EARLY)).toEqual({ ok: true, refunded: PAY_NOW, alreadyCancelled: false });
});

test("the guest view and emails show the original terms after the plan is edited", async () => {
  const { db, deps, owner, res, code, ids } = await confirmed();
  const none: CancelPolicy = { rules: [] };
  await updateRatePlan(db, owner, ids.ratePlanId, { cancelPolicy: none, name: { "zh-TW": "新名", en: "New name", ja: "新名", ko: "새 이름" } }, minutes(3));
  const { data } = await emailContext(deps, res.id, "en");
  expect(data.cancellationText).toBe(cancellationText(ORIGINAL, "en"));
  expect(data.cancellationText).not.toBe(cancellationText(none, "en"));
  expect((await findReservation(db, code, GUEST, EARLY))?.ratePlanName["en"]).not.toBe("New name");
});

// A second plan on the same room type, with its own policy.
async function withOtherPlan(s: Awaited<ReturnType<typeof confirmed>>, policy: CancelPolicy) {
  const id = crypto.randomUUID();
  const name = { "zh-TW": "彈性", en: "Other plan", ja: "Other", ko: "Other" };
  await s.db.insert(ratePlans).values({ id, propertyId: s.propertyId, slug: "other", name, directOnly: false, paymentMode: "full", depositPct: 0, cancelPolicy: policy });
  for (const date of ["2026-12-01", "2026-12-02", "2026-12-03"])
    await s.db.insert(ariDaily).values({ propertyId: s.propertyId, unitTypeId: s.ids.unitTypeId, ratePlanId: id, date, price: 2000, minStay: 1, source: "siteminder", syncedAt: 0 });
  return name;
}
const change = (o: Partial<ModificationChange> = {}): ModificationChange => ({ checkIn: "2026-12-01", checkOut: "2026-12-03", adults: 2, children: 0, ...o });
const modify = async (s: Awaited<ReturnType<typeof confirmed>>, c: ModificationChange) => {
  const p = await previewModification(s.db, s.owner, s.res.id, c, minutes(10));
  if (!p.ok) throw new Error(JSON.stringify(p));
  return applyModification(s.deps, s.owner, s.res.id, c, { expectedDifference: p.difference, reason: "test" }, minutes(10));
};

test("a modification onto a different plan adopts that plan's terms", async () => {
  const s = await confirmed();
  const policy: CancelPolicy = { rules: [{ daysBefore: 7, refundPct: 80 }] };
  const name = await withOtherPlan(s, policy);
  expect(await modify(s, change({ ratePlanSlug: "other" }))).toMatchObject({ ok: true });
  expect((await s.reservation(s.code))).toMatchObject({ cancelPolicy: policy, ratePlanName: name });
});

test("a modification on the same plan keeps the booked snapshot, even after the plan was edited", async () => {
  const s = await confirmed();
  const edited: CancelPolicy = { rules: [{ daysBefore: 0, refundPct: 0 }] };
  await updateRatePlan(s.db, s.owner, s.ids.ratePlanId, { cancelPolicy: edited }, minutes(3));
  expect(await modify(s, change({ checkOut: "2026-12-02" }))).toMatchObject({ ok: true });
  const r = (await s.db.select().from(reservations).where(eq(reservations.id, s.res.id)))[0];
  expect(r.cancelPolicy).toEqual(ORIGINAL);
});
