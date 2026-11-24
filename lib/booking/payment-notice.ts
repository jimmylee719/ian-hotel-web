import { and, eq, isNull } from "drizzle-orm";
import { hasSqliteError } from "@/lib/db/inventory-hold";
import { paymentEvents, payments, reservations, type PaymentEventVerdict } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Quote } from "@/lib/domain/quote";
import type { PaymentNotice } from "@/lib/payments/types";
import { confirmWithChannel, refundCharge } from "./confirm";
import { notifyStaff, refundableCharges, type ChargeRow, type Deps } from "./notify";
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

  // 3. Already processed. A resend is also the provider's recovery channel: if an earlier attempt
  //    died after recording the charge, finish the job now.
  const [seen] = await db.select().from(payments).where(eq(payments.providerRef, n.providerRef));
  if (seen) {
    const out = await reply("duplicate", res);
    if (seen.kind === "charge" && seen.status === "succeeded") await settle(deps, res.id, seen, now);
    return out;
  }

  // 4. Failed payment: record it and keep the reservation payable.
  if (n.status === "failed") return reply(await recordCharge(db, res.id, n, now) ? "accepted" : "duplicate", res);

  // The unique provider_ref index makes recording the charge the dedupe lock.
  const charge = await recordCharge(db, res.id, n, now);
  if (!charge) return reply("duplicate", res);

  // 5–7. Mismatch, re-hold after expiry and the SiteMinder push all run in confirmWithChannel,
  //      which the retry job also runs, so a crash from here on is recovered.
  let verdict: PaymentEventVerdict = n.amount === (res.quote as Quote).payNow ? "accepted" : "amount_mismatch";
  try {
    if (await settle(deps, res.id, charge, now) === "stray") verdict = "stray_charge";
  } finally {
    await log(verdict, n, res);
  }
  return { status: 200, verdict };
}

/**
 * Take a recorded succeeded charge as far as it can go:
 * - pending_payment / expired → paid_pending_confirm (retry job armed), then confirmWithChannel;
 * - an extra charge on a booking that is already paid or closed → refund it ("stray");
 * - already paid_pending_confirm with this charge → resume confirmWithChannel (lease-guarded).
 */
async function settle(deps: Deps, reservationId: string, charge: ChargeRow, now: Date): Promise<"settled" | "stray"> {
  const { db } = deps;
  for (let i = 0; i < 2; i++) {
    const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
    if (res.status === "pending_payment" || res.status === "expired") {
      // nextSyncAt = now: from this moment the retry job is the safety net.
      if (await transition(db, reservationId, res.status, "paid_pending_confirm",
        { syncState: "pending", nextSyncAt: now.getTime(), lastSyncError: null }, now)) {
        await confirmWithChannel(deps, reservationId, now);
        return "settled";
      }
      continue; // the status moved under us (expiry or another notice); look again
    }
    if (await isStray(db, res, charge)) {
      await refundStray(deps, res, charge, now);
      return "stray";
    }
    if (res.status === "paid_pending_confirm") await confirmWithChannel(deps, reservationId, now);
    return "settled";
  }
  return "settled";
}

/**
 * A charge is stray when it still holds money and the booking cannot use it: the booking is closed,
 * or it is already paid by another charge.
 */
async function isStray(db: Db, res: Reservation, charge: ChargeRow): Promise<boolean> {
  const charges = await refundableCharges(db, res.id);
  const ours = charges.find((c) => c.id === charge.id);
  if (!ours || ours.remaining <= 0) return false;
  if (res.status === "cancelled" || res.status === "confirm_failed_refunded") return true;
  if (res.status === "paid_pending_confirm" || res.status === "confirmed")
    return charges.some((c) => c.id !== charge.id && c.remaining > 0);
  return false;
}

/** Refund a stray charge against its own provider ref and alert staff, once per provider ref. */
async function refundStray(deps: Deps, res: Reservation, charge: ChargeRow, now: Date): Promise<void> {
  const ours = (await refundableCharges(deps.db, res.id)).find((c) => c.id === charge.id)!;
  const r = await refundCharge(deps, charge, ours.remaining, "STRAY_CHARGE", now);
  if (!r.ok)
    await deps.db.update(reservations)
      .set({ lastSyncError: `STRAY_REFUND_FAILED: ${charge.providerRef}: ${r.error}`, updatedAt: now.getTime() })
      .where(eq(reservations.id, res.id));
  await notifyStaff(deps, res.id, "staff_payment_alert", now, {}, charge.providerRef ?? charge.id);
}

/**
 * Record the notice as a charge. A success fills in the reservation's pending charge row; a failure
 * gets its own row so the pending one stays for the next attempt. Returns null if this provider_ref
 * was already recorded (a concurrent duplicate).
 */
async function recordCharge(db: Db, reservationId: string, n: PaymentNotice, now: Date): Promise<ChargeRow | null> {
  const fields = {
    status: n.status, amount: n.amount, providerRef: n.providerRef, authCode: n.authCode ?? null, last4: n.last4 ?? null,
  } as const;
  try {
    if (n.status === "succeeded") {
      const [pending] = await db.select({ id: payments.id }).from(payments).where(and(
        eq(payments.reservationId, reservationId), eq(payments.kind, "charge"), eq(payments.status, "pending"), isNull(payments.providerRef),
      ));
      if (pending) {
        const [updated] = await db.update(payments).set(fields)
          .where(and(eq(payments.id, pending.id), eq(payments.status, "pending"))).returning();
        if (updated) return updated;
      }
    }
    const [inserted] = await db.insert(payments).values({
      id: crypto.randomUUID(), reservationId, kind: "charge", method: "sinopac_online", createdAt: now.getTime(), ...fields,
    }).returning();
    return inserted;
  } catch (e) {
    if (hasSqliteError(e, "UNIQUE constraint failed")) return null;
    throw e;
  }
}
