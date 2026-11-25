import { and, asc, eq, isNull } from "drizzle-orm";
import { hasSqliteError } from "@/lib/db/inventory-hold";
import { paymentEvents, payments, reservations, type PaymentEventVerdict } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Quote } from "@/lib/domain/quote";
import type { PaymentNotice } from "@/lib/payments/types";
import { confirmWithChannel, refundOnce } from "./confirm";
import { notifyStaff, refundableCharges, type ChargeRow, type Deps } from "./notify";
import { transition, type Reservation } from "./state";

export type { Deps } from "./notify";

type Result = { status: 200 | 400; verdict: PaymentEventVerdict };

/** How much of a bad-signature or unknown-reservation body is stored. */
export const UNTRUSTED_BODY_BYTES = 2048;

/** `s` cut to at most `maxBytes` bytes of UTF-8, never splitting a character. */
export function truncateUtf8(s: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > maxBytes) break;
    bytes += n;
    out += ch;
  }
  return out;
}

/**
 * Handle a payment provider's server-to-server notice. Every call is logged in payment_events.
 * Anything that is not a bad signature answers 200 so the provider stops resending.
 */
export async function handlePaymentNotice(
  deps: Deps, req: { headers: Record<string, string>; body: string }, now: Date,
): Promise<Result> {
  // 1. Signature.
  const v = await deps.gateway.verifyNotice(req);
  if (!v.ok) {
    await logEvent(deps, "bad_signature", req.body, now);
    return { status: 400, verdict: "bad_signature" };
  }
  return applyPaymentNotice(deps, v.notice, req.body, now);
}

async function logEvent(deps: Deps, verdict: PaymentEventVerdict, rawBody: string, now: Date, n?: PaymentNotice, res?: Reservation) {
  // Unauthenticated or unmatched notices are anyone's input: keep enough to debug, not to fill D1.
  const untrusted = verdict === "bad_signature" || verdict === "unknown_reservation";
  await deps.db.insert(paymentEvents).values({
    id: crypto.randomUUID(), propertyId: res?.propertyId ?? null, provider: deps.gateway.provider,
    providerRef: n?.providerRef ?? null, reservationCode: n?.reservationCode ?? null,
    rawBody: untrusted ? truncateUtf8(rawBody, UNTRUSTED_BODY_BYTES) : rawBody, verdict, at: now.getTime(),
  });
}

/**
 * Apply an authenticated payment result: a verified notice (handlePaymentNotice), or what the gateway's
 * queryTransaction reported for a payment whose notice never came (the gateway reconcile job). Steps 2–7 of
 * the notice path, logged in payment_events with `rawBody`: dedupe by providerRef, record the charge, then
 * the amount check, re-hold and channel push (settle → confirmWithChannel).
 */
export async function applyPaymentNotice(deps: Deps, n: PaymentNotice, rawBody: string, now: Date): Promise<Result> {
  const { db } = deps;
  const log = (verdict: PaymentEventVerdict, notice?: PaymentNotice, res?: Reservation) => logEvent(deps, verdict, rawBody, now, notice, res);
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

  // 3. Already processed: a duplicate, which does nothing. The one exception is the provider's resend
  //    after an earlier attempt died between recording the charge and claiming the booking (still
  //    pending_payment or expired): then finish the job. Any later state is owned by the retry job.
  const [seen] = await db.select().from(payments).where(eq(payments.providerRef, n.providerRef));
  if (seen) {
    const out = await reply("duplicate", res);
    if (seen.kind === "charge" && seen.status === "succeeded" && (res.status === "pending_payment" || res.status === "expired"))
      await settle(deps, res.id, seen, now);
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
 * - not the booking's paying charge (an extra payment) → refund it ("stray"), whatever the status;
 * - pending_payment / expired → paid_pending_confirm (retry job armed), then confirmWithChannel;
 * - already paid_pending_confirm → resume confirmWithChannel (lease-guarded).
 * Only the paying charge ever claims the booking, so two different payments racing cannot both count.
 */
async function settle(deps: Deps, reservationId: string, charge: ChargeRow, now: Date): Promise<"settled" | "stray"> {
  const { db } = deps;
  if (await isStray(db, reservationId, charge)) {
    await refundStray(deps, reservationId, charge, now);
    return "stray";
  }
  for (let i = 0; i < 2; i++) {
    const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
    if (res.status === "pending_payment" || res.status === "expired") {
      // nextSyncAt = now: from this moment the retry job is the safety net.
      if (await transition(db, reservationId, res.status, "paid_pending_confirm",
        { syncState: "pending", nextSyncAt: now.getTime(), lastSyncError: null }, now)) {
        await confirmWithChannel(deps, reservationId, now);
        return "settled";
      }
      continue; // the status moved under us (expiry or the expire job's recovery); look again
    }
    if (res.status === "paid_pending_confirm") await confirmWithChannel(deps, reservationId, now);
    return "settled";
  }
  return "settled";
}

/**
 * The paying charge is the booking's first succeeded charge (oldest; the row created with the
 * booking is filled by the first success). It is never stray, whatever the booking's status or
 * balance: what the hotel keeps after a cancellation is Task 6's business, not ours.
 */
export async function payingChargeId(db: Db, reservationId: string): Promise<string | undefined> {
  const [first] = await db.select({ id: payments.id }).from(payments)
    .where(and(eq(payments.reservationId, reservationId), eq(payments.kind, "charge"), eq(payments.status, "succeeded")))
    .orderBy(asc(payments.createdAt), asc(payments.id))
    .limit(1);
  return first?.id;
}

/** A stray charge is any succeeded charge other than the paying one that still holds money. */
async function isStray(db: Db, reservationId: string, charge: ChargeRow): Promise<boolean> {
  if (await payingChargeId(db, reservationId) === charge.id) return false;
  const ours = (await refundableCharges(db, reservationId)).find((c) => c.id === charge.id);
  return !!ours && ours.remaining > 0;
}

/**
 * Refund what is left of a stray charge against its own provider ref and alert staff (once per
 * provider ref). Re-reads the balance first and does nothing if it is already refunded.
 */
export async function refundStray(deps: Deps, reservationId: string, charge: ChargeRow, now: Date): Promise<void> {
  const ours = (await refundableCharges(deps.db, reservationId)).find((c) => c.id === charge.id);
  if (!ours || ours.remaining <= 0) return;
  const r = await refundOnce(deps, `stray:${charge.providerRef ?? charge.id}`, charge, ours.remaining, "STRAY_CHARGE", now);
  if (!r.ok)
    await deps.db.update(reservations)
      .set({ lastSyncError: `STRAY_REFUND_FAILED: ${charge.providerRef}: ${r.error}`, updatedAt: now.getTime() })
      .where(eq(reservations.id, reservationId));
  await notifyStaff(deps, reservationId, "staff_payment_alert", now, {}, (!r.ok && r.pendingRefundId) || (charge.providerRef ?? charge.id));
}

/**
 * Record the notice as a charge. A success fills in the reservation's pending charge row; a failure
 * gets its own row so the pending one stays for the next attempt. Returns null if this provider_ref
 * was already recorded (a concurrent duplicate).
 */
async function recordCharge(db: Db, reservationId: string, n: PaymentNotice, now: Date): Promise<ChargeRow | null> {
  const fields = {
    status: n.status, amount: n.amount, providerRef: n.providerRef, authCode: n.authCode ?? null, last4: n.last4 ?? null,
    merchantOrderNo: n.merchantOrderNo ?? null,
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
