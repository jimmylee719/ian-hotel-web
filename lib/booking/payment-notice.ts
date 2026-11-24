import { and, eq, isNull } from "drizzle-orm";
import { hasSqliteError, holdInventory } from "@/lib/db/inventory-hold";
import { paymentEvents, payments, reservations, type PaymentEventVerdict } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Quote } from "@/lib/domain/quote";
import type { PaymentNotice } from "@/lib/payments/types";
import { confirmWithChannel, holdItemsFor, refundAndFail, SYNC_RETRY_MS } from "./confirm";
import { notifyStaff, type Deps } from "./notify";
import { transition, type Reservation } from "./state";

export type { Deps } from "./notify";

type Result = { status: 200 | 400; verdict: PaymentEventVerdict };

/**
 * Handle a payment provider's server-to-server notice. Every call is logged in payment_events.
 * Anything that is not a bad signature answers 200 so the provider stops resending.
 */
export async function handlePaymentNotice(
  deps: Deps, req: { headers: Record<string, string>; body: string }, now: Date,
): Promise<Result> {
  const { db, gateway } = deps;
  const log = async (verdict: PaymentEventVerdict, n?: PaymentNotice, res?: Reservation) => {
    await db.insert(paymentEvents).values({
      id: crypto.randomUUID(), propertyId: res?.propertyId ?? null, provider: gateway.provider,
      providerRef: n?.providerRef ?? null, reservationCode: n?.reservationCode ?? null,
      rawBody: req.body, verdict, at: now.getTime(),
    });
  };

  // 1. Signature.
  const v = await gateway.verifyNotice(req);
  if (!v.ok) {
    await log("bad_signature");
    return { status: 400, verdict: "bad_signature" };
  }
  const n = v.notice;
  const reply = async (verdict: PaymentEventVerdict, res: Reservation): Promise<Result> => {
    await log(verdict, n, res);
    return { status: 200, verdict };
  };

  // 2. Reservation.
  const [res] = await db.select().from(reservations).where(eq(reservations.code, n.reservationCode));
  if (!res) {
    await log("unknown_reservation", n);
    return { status: 200, verdict: "unknown_reservation" };
  }

  // 3. Already processed? The unique provider_ref index makes recordCharge the real lock.
  const [seen] = await db.select({ id: payments.id }).from(payments).where(eq(payments.providerRef, n.providerRef));
  if (seen) return reply("duplicate", res);

  // 4. Failed payment: record it and keep the reservation payable.
  if (n.status === "failed") return reply(await recordCharge(db, res.id, n, now) ? "accepted" : "duplicate", res);

  if (!await recordCharge(db, res.id, n, now)) return reply("duplicate", res);

  // Claim the reservation: only one notice moves it to paid_pending_confirm.
  const payNow = (res.quote as Quote).payNow;
  const mismatch = n.amount !== payNow;
  const from = await claimPaid(db, res, now, mismatch);
  if (!from) {
    // Money arrived for a reservation that is already paid, cancelled or refunded: a human must sort it out.
    const out = await reply("duplicate", res);
    await notifyStaff(deps, res.id, "staff_payment_alert", now);
    return out;
  }

  // 5. Wrong amount: refund it all.
  if (mismatch) {
    const out = await reply("amount_mismatch", res);
    await refundAndFail(deps, res.id, `AMOUNT_MISMATCH: expected ${payNow}, got ${n.amount}`, now, { staffKind: "staff_payment_alert" });
    return out;
  }
  const out = await reply("accepted", res);

  // 6. Paid after the hold lapsed: take the rooms again, or refund.
  if (from === "expired") {
    const hold = await holdInventory(db, await holdItemsFor(db, res));
    if (!hold.ok) {
      await refundAndFail(deps, res.id, "SOLD_OUT_AFTER_EXPIRY", now, { guestKind: "booking_failed_refunded", staffKind: "staff_payment_alert" });
      return out;
    }
    await db.update(reservations)
      .set({ holdExpiresAt: now.getTime(), nextSyncAt: now.getTime() + SYNC_RETRY_MS })
      .where(eq(reservations.id, res.id));
  }

  // 7. Confirm with SiteMinder.
  await confirmWithChannel(deps, res.id, now);
  return out;
}

/**
 * Move the reservation to paid_pending_confirm from pending_payment or expired; returns the status it
 * came from, or null if it is in neither (or another notice won). Re-reads once in case the hold
 * expired between the read and the claim.
 * nextSyncAt is a safety net: if this request dies before confirming, the retry job picks it up.
 * It stays null when inventory is not held yet (expired) or a refund is coming (mismatch).
 */
async function claimPaid(db: Db, res: Reservation, now: Date, mismatch: boolean): Promise<"pending_payment" | "expired" | null> {
  let status = res.status;
  for (let i = 0; i < 2; i++) {
    if (status !== "pending_payment" && status !== "expired") return null;
    const nextSyncAt = status === "pending_payment" && !mismatch ? now.getTime() + SYNC_RETRY_MS : null;
    if (await transition(db, res.id, status, "paid_pending_confirm", { syncState: "pending", nextSyncAt, lastSyncError: null }, now))
      return status;
    [{ status }] = await db.select({ status: reservations.status }).from(reservations).where(eq(reservations.id, res.id));
  }
  return null;
}

/**
 * Record the notice as a charge. A success fills in the reservation's pending charge row; a failure
 * gets its own row so the pending one stays for the next attempt. Returns false if this provider_ref
 * was already recorded (a concurrent duplicate).
 */
async function recordCharge(db: Db, reservationId: string, n: PaymentNotice, now: Date): Promise<boolean> {
  const fields = {
    status: n.status, amount: n.amount, providerRef: n.providerRef, authCode: n.authCode ?? null, last4: n.last4 ?? null,
  } as const;
  try {
    if (n.status === "succeeded") {
      const [pending] = await db.select({ id: payments.id }).from(payments).where(and(
        eq(payments.reservationId, reservationId), eq(payments.kind, "charge"), eq(payments.status, "pending"), isNull(payments.providerRef),
      ));
      if (pending) {
        const updated = await db.update(payments).set(fields)
          .where(and(eq(payments.id, pending.id), eq(payments.status, "pending"))).returning({ id: payments.id });
        if (updated.length) return true;
      }
    }
    await db.insert(payments).values({
      id: crypto.randomUUID(), reservationId, kind: "charge", method: "sinopac_online", createdAt: now.getTime(), ...fields,
    });
    return true;
  } catch (e) {
    if (hasSqliteError(e, "UNIQUE constraint failed")) return false;
    throw e;
  }
}
