import { and, eq } from "drizzle-orm";
import { emailContext, type Deps } from "@/lib/booking/notify";
import { notifications } from "@/lib/db/schema";
import { renderEmail } from "@/lib/email/templates";
import { recordAudit } from "./audit";
import type { StaffContext } from "./auth";
import { can } from "./permissions";

export type ResendResult =
  | { ok: true; status: "sent" | "failed" }
  | { ok: false; error: "NOT_FOUND" | "FORBIDDEN" | "ALREADY_SENT" };

const STAFF_KINDS: readonly string[] = ["staff_new_booking", "staff_sync_failed", "staff_payment_alert"];

/**
 * Send a failed email again (needs `notifications.resend` at the row's property; another property's row is
 * NOT_FOUND). It is re-rendered from the booking as it is now (emailContext) and sent to the same address;
 * the same notifications row becomes sent or stays failed, so the unique-send row is never duplicated.
 * The row is first claimed (failed → sent, as sendOnce writes it before sending), so two staff resending
 * at once send it once. Needs only the email deps, not the payment gateway.
 */
export async function resendNotification(
  deps: Pick<Deps, "db" | "email" | "baseUrl">, ctx: StaffContext, notificationId: string, now: Date,
): Promise<ResendResult> {
  const { db } = deps;
  if (!can(ctx.staff, "notifications.resend")) return { ok: false, error: "FORBIDDEN" };
  const [n] = await db.select().from(notifications).where(eq(notifications.id, notificationId));
  if (!n || !can(ctx.staff, "notifications.resend", n.propertyId)) return { ok: false, error: "NOT_FOUND" };
  if (n.status === "sent") return { ok: false, error: "ALREADY_SENT" };

  const [claimed] = await db.update(notifications).set({ status: "sent", at: now.getTime() })
    .where(and(eq(notifications.id, n.id), eq(notifications.status, "failed"))).returning();
  if (!claimed) return { ok: false, error: "ALREADY_SENT" };

  let sent: Awaited<ReturnType<typeof deps.email.send>>;
  try {
    const c = await emailContext(deps, n.reservationId, STAFF_KINDS.includes(n.kind) ? "zh-TW" : undefined);
    sent = await deps.email.send({ to: n.to, ...renderEmail(n.kind, c.locale, c.data) });
  } catch (e) {
    sent = { ok: false, error: String(e) };
  }
  await db.update(notifications)
    .set(sent.ok ? { providerId: sent.id } : { status: "failed" })
    .where(eq(notifications.id, n.id));
  const status = sent.ok ? "sent" : "failed";
  await recordAudit(db, ctx, {
    action: "notification.resend", entity: "notification", entityId: n.id,
    before: { status: n.status }, after: { status, kind: n.kind, to: n.to, ...(sent.ok ? {} : { error: sent.error }) },
  }, now);
  return { ok: true, status };
}
