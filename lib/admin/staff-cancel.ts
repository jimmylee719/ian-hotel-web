import { eq } from "drizzle-orm";
import { alreadyCancelled, cancelBase, cancelConfirmed, plannedCancelRefund, refundTotal } from "@/lib/booking/manage";
import type { Deps } from "@/lib/booking/notify";
import { reservations } from "@/lib/db/schema";
import { todayInTaipei } from "@/lib/domain/dates";
import { recordAudit } from "./audit";
import { modifyRefundPending } from "./money-metrics";
import type { StaffContext } from "./auth";
import { can } from "./permissions";

export type StaffCancelOptions = {
  /** Required: why staff cancelled (kept in the audit log). */
  reason: string;
  /**
   * Refund this amount instead of the policy's (needs `reservations.refund_override`): an integer from 0 to the
   * cancel base (the total received minus money already owed back after a staff modification, which is refunded
   * at the front desk on top, whatever the override). As with the policy, the online net goes back through the gateway and the rest is
   * `frontDeskRefundDue`. Used only when this call creates the cancellation's refund intent; if one already
   * exists (e.g. an earlier guest attempt), its split wins and the result says `overrideIgnored`.
   */
  refundOverride?: number;
  notifyGuest: boolean;
  /** Set when no payment gateway is configured: only a cancellation refunding 0 can go ahead. */
  paymentsUnavailable?: boolean;
};

export type StaffCancelError =
  | "NOT_FOUND" | "FORBIDDEN" | "NOT_CANCELLABLE" | "REFUND_FAILED" | "OVERRIDE_EXCEEDS_PAID" | "INVALID_OVERRIDE"
  | "REASON_REQUIRED" | "PAYMENTS_UNAVAILABLE" | "MODIFICATION_REFUND_PENDING";

export type StaffCancelResult =
  | {
      ok: true;
      /** Refunded online, through the gateway. */
      refunded: number;
      /** Present (> 0) when the front desk must hand part of the refund back. */
      frontDeskRefundDue?: number;
      alreadyCancelled: boolean;
      overrideIgnored?: true;
    }
  | { ok: false; error: StaffCancelError };

/**
 * Cancel a confirmed booking for staff. It goes through the same core, claim and `cancel:<id>` refund
 * intent as the guest cancel, so a staff and a guest cancel at the same time converge on one refund.
 * Unlike guests, staff may cancel after check-in: only the nights from today (Taipei) on are given back,
 * so after check-out nothing is. Another property's booking is NOT_FOUND. Every attempt that gets past
 * validation is audited with the reason, the amount refunded online and any front-desk refund due.
 */
export async function staffCancel(
  deps: Deps, ctx: StaffContext, reservationId: string, opts: StaffCancelOptions, now: Date,
): Promise<StaffCancelResult> {
  const { db } = deps;
  if (!can(ctx.staff, "reservations.cancel")) return { ok: false, error: "FORBIDDEN" };
  const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  if (!res || !can(ctx.staff, "reservations.cancel", res.propertyId)) return { ok: false, error: "NOT_FOUND" };

  const reason = opts.reason.trim();
  if (!reason) return { ok: false, error: "REASON_REQUIRED" };
  const override = opts.refundOverride;
  if (override !== undefined) {
    if (!can(ctx.staff, "reservations.refund_override", res.propertyId)) return { ok: false, error: "FORBIDDEN" };
    if (!Number.isInteger(override) || override < 0) return { ok: false, error: "INVALID_OVERRIDE" };
    if (override > await cancelBase(db, res)) return { ok: false, error: "OVERRIDE_EXCEEDS_PAID" };
  }

  const result = await run();
  const refunded = result.ok ? result.refunded : 0;
  const frontDeskRefundDue = result.ok ? result.frontDeskRefundDue ?? 0 : 0;
  await recordAudit(db, ctx, {
    action: "reservation.cancel", entity: "reservation", entityId: res.id,
    before: { status: res.status, refundedAmount: res.refundedAmount },
    after: {
      reason, refundOverride: override ?? null, notifyGuest: opts.notifyGuest, refunded, frontDeskRefundDue,
      outcome: result.ok ? (result.alreadyCancelled ? "already_cancelled" : "cancelled") : result.error,
      ...(result.ok && result.overrideIgnored ? { overrideIgnored: true } : {}),
    },
  }, now);
  return result;

  async function run(): Promise<StaffCancelResult> {
    const withOverride = (r: StaffCancelResult): StaffCancelResult =>
      r.ok && override !== undefined && r.refunded + (r.frontDeskRefundDue ?? 0) !== override ? { ...r, overrideIgnored: true } : r;
    if (res.status === "cancelled") return withOverride(alreadyCancelled(res) as StaffCancelResult);
    if (res.status !== "confirmed") return { ok: false, error: "NOT_CANCELLABLE" };
    // Only the online part needs the gateway; front-desk money is handed back at the desk.
    if (opts.paymentsUnavailable && (await plannedCancelRefund(db, res, now, override)).online > 0)
      return { ok: false, error: "PAYMENTS_UNAVAILABLE" };
    const r = await cancelConfirmed(deps, res.id, now, {
      reason: "STAFF_CANCELLED", // the free-text reason stays in the audit log, not at the gateway
      refundOverride: override,
      releaseFrom: todayInTaipei(now),
      notifyGuest: opts.notifyGuest,
      gatewayAvailable: !opts.paymentsUnavailable,
    });
    return r.ok ? withOverride(r) : r;
  }
}

/**
 * For the cancel dialog: what a cancel now would refund in all by the rules (or the existing intent's split),
 * how much of that the front desk hands back, and the most an override may refund (the cancel base).
 * `modifyRefundPending`: a staff modification's refund has not settled, so a cancel would be refused
 * (MODIFICATION_REFUND_PENDING) until it is reconciled. Null unless the booking is confirmed.
 */
export async function staffCancelPreview(
  db: Deps["db"], reservationId: string, now: Date,
): Promise<{ refund: number; frontDeskRefundDue: number; maxOverride: number; modifyRefundPending: boolean } | null> {
  const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  if (!res || res.status !== "confirmed") return null;
  const plan = await plannedCancelRefund(db, res, now);
  return {
    refund: refundTotal(plan), frontDeskRefundDue: plan.frontDesk, maxOverride: await cancelBase(db, res),
    modifyRefundPending: await modifyRefundPending(db, res.id),
  };
}
