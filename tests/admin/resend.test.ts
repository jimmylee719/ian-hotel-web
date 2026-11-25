import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { StaffContext } from "@/lib/admin/auth";
import { resendNotification } from "@/lib/admin/resend";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { auditLog, notifications, staff } from "@/lib/db/schema";
import { bookingSetup, minutes } from "@/tests/helpers/booking";

const GUEST = "mei@example.com";

/** A confirmed booking whose guest confirmation email the provider refused. */
async function setup() {
  const s = await bookingSetup();
  const code = await s.book();
  s.email.failNext = 1; // the guest's booking_confirmed is sent first
  await handlePaymentNotice(s.deps, await s.notice(code), minutes(2));
  const res = await s.reservation(code);
  const [failed] = await s.db.select().from(notifications)
    .where(and(eq(notifications.reservationId, res.id), eq(notifications.kind, "booking_confirmed")));
  expect(failed).toMatchObject({ status: "failed", to: GUEST });
  const mk = async (role: "front_desk" | "marketing", propertyIds = [s.propertyId]): Promise<StaffContext> => {
    const row = { id: `s-${role}-${propertyIds.join()}`, email: `${role}@nk.test`, name: role, role, propertyIds, active: true };
    await s.db.insert(staff).values(row).onConflictDoNothing();
    return { staff: row, email: row.email };
  };
  return { ...s, code, res, failed, frontDesk: await mk("front_desk"), mk };
}

test("a failed email is re-rendered and resent on the same row, which becomes sent", async () => {
  const { db, deps, email, frontDesk, failed, code, res } = await setup();
  const before = email.sent.length;
  expect(await resendNotification(deps, frontDesk, failed.id, minutes(10))).toEqual({ ok: true, status: "sent" });
  const mail = email.sent.slice(before);
  expect(mail).toHaveLength(1);
  expect(mail[0]).toMatchObject({ to: GUEST });
  expect(mail[0].subject).toContain(code);
  const rows = await db.select().from(notifications)
    .where(and(eq(notifications.reservationId, res.id), eq(notifications.kind, "booking_confirmed")));
  expect(rows).toMatchObject([{ id: failed.id, status: "sent", providerId: expect.any(String) }]);
  expect(await db.select().from(auditLog).where(eq(auditLog.entityId, failed.id)))
    .toMatchObject([{ action: "notification.resend", entity: "notification", staffEmail: frontDesk.email }]);
});

test("an email that is already sent is not sent again", async () => {
  const { deps, email, frontDesk, failed } = await setup();
  await resendNotification(deps, frontDesk, failed.id, minutes(10));
  const before = email.sent.length;
  expect(await resendNotification(deps, frontDesk, failed.id, minutes(11))).toEqual({ ok: false, error: "ALREADY_SENT" });
  expect(email.sent.length).toBe(before);
});

test("a resend the provider refuses again stays failed on the same row", async () => {
  const { db, deps, email, frontDesk, failed } = await setup();
  email.failNext = 1;
  expect(await resendNotification(deps, frontDesk, failed.id, minutes(10))).toEqual({ ok: true, status: "failed" });
  expect(await db.select().from(notifications).where(eq(notifications.id, failed.id))).toMatchObject([{ status: "failed" }]);
});

test("resending needs notifications.resend at the row's property", async () => {
  const { deps, mk, failed } = await setup();
  expect(await resendNotification(deps, await mk("marketing"), failed.id, minutes(10))).toEqual({ ok: false, error: "FORBIDDEN" });
  expect(await resendNotification(deps, await mk("front_desk", ["prop-other"]), failed.id, minutes(10))).toEqual({ ok: false, error: "NOT_FOUND" });
});
