import { and, eq, like } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { alertHref, getDashboard } from "@/lib/admin/dashboard";
import { reconcileRefund } from "@/lib/admin/reconcile";
import { cancelReservation } from "@/lib/booking/manage";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { settleRefundRow } from "@/lib/booking/confirm";
import type { Deps } from "@/lib/booking/notify";
import { jobRuns, notifications, paymentEvents, payments, reservations } from "@/lib/db/schema";
import {
  CHANNEL_RECONCILE_JOB, CRON_CHANNEL_RECONCILE, CRON_EVERY_5_MIN, CRON_GATEWAY_RECONCILE, CRON_JOB, GATEWAY_RECONCILE_JOB, recordJob, runCronTrigger,
} from "@/lib/jobs/cron";
import { FLOW_UNFINISHED_REF, GATEWAY_RECONCILE_BUDGET_MS, REFUND_FAILED_REF, runGatewayReconcile } from "@/lib/jobs/reconcile-gateway";
import { bookingSetup, minutes, PAY_NOW, STAFF } from "@/tests/helpers/booking";

const GUEST = "mei@example.com";

/** A confirmed booking whose cancellation refund reached the gateway but whose answer was lost (row stuck pending). */
async function stuckCancellation() {
  const s = await bookingSetup({ refundTimeoutNext: 1 });
  const code = await s.book();
  await handlePaymentNotice(s.deps, await s.notice(code), minutes(1));
  expect((await s.reservation(code)).status).toBe("confirmed");
  // The refund is made but times out, and the follow-up query cannot tell yet.
  vi.spyOn(s.gateway, "queryRefund").mockResolvedValueOnce({ status: "pending" });
  expect(await cancelReservation(s.deps, code, GUEST, minutes(2))).toEqual({ ok: false, error: "REFUND_FAILED" });
  const res = await s.reservation(code);
  const refundRows = () => s.db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund")));
  const [row] = await refundRows();
  expect(row).toMatchObject({ status: "pending", idempotencyKey: `cancel:${res.id}` });
  expect(res.status).toBe("confirmed");
  return { ...s, code, id: res.id, row, refundRows };
}

test("a pending refund the gateway reports succeeded is settled and the cancellation finishes", async () => {
  const { deps, gateway, email, code, reservation, refundRows, channel } = await stuckCancellation();
  const refund = vi.spyOn(gateway, "refund");
  const amount = (await refundRows())[0].amount;

  // Younger than 10 minutes: left alone.
  expect(await runGatewayReconcile(deps, minutes(5))).toMatchObject({ refundsChecked: 0 });
  expect((await reservation(code)).status).toBe("confirmed");

  const r = await runGatewayReconcile(deps, minutes(15));
  expect(r).toMatchObject({ refundsChecked: 1, refundsSettled: 1, refundsFailed: 0, refundsUnresolved: 0 });
  expect(refund).not.toHaveBeenCalled(); // never refunds again: only asks
  expect(await refundRows()).toMatchObject([{ status: "succeeded", providerRef: gateway.refunds[0].refundRef, settledAt: minutes(15).getTime() }]);
  const res = await reservation(code);
  expect(res).toMatchObject({ status: "cancelled", refundedAmount: amount, cancelledAt: minutes(2).getTime() });
  expect(channel.records).toMatchObject([{ code, state: "cancelled" }]);
  expect(email.sent.filter((e) => e.to === GUEST && e.subject.includes("cancelled"))).toHaveLength(1);

  // A second run finds nothing to do and counts nothing twice.
  expect(await runGatewayReconcile(deps, minutes(30))).toMatchObject({ refundsChecked: 0 });
  expect((await reservation(code)).refundedAmount).toBe(amount);
});

test("a pending refund the gateway reports not_found stays pending for staff (refund_pending), nothing emailed", async () => {
  const { db, deps, gateway, propertyId, code, reservation, refundRows } = await stuckCancellation();
  vi.spyOn(gateway, "queryRefund").mockResolvedValueOnce({ status: "not_found" });
  expect(await runGatewayReconcile(deps, minutes(15))).toMatchObject({ refundsChecked: 1, refundsFailed: 0, refundsUnresolved: 1 });
  expect(await refundRows()).toMatchObject([{ status: "pending" }]);
  expect(await reservation(code)).toMatchObject({ status: "confirmed", refundedAmount: 0 });
  expect(await db.select().from(notifications).where(like(notifications.ref, `${REFUND_FAILED_REF}%`))).toEqual([]);
  expect((await getDashboard(db, propertyId, minutes(15))).alerts.map((a) => a.kind)).toContain("refund_pending");
});

test("a pending refund the gateway reports failed is marked failed, staff are emailed once and the dashboard alerts", async () => {
  const { db, deps, gateway, propertyId, code, id, reservation, refundRows } = await stuckCancellation();
  vi.spyOn(gateway, "queryRefund").mockResolvedValueOnce({ status: "failed" });
  expect(await runGatewayReconcile(deps, minutes(15))).toMatchObject({ refundsChecked: 1, refundsFailed: 1 });
  const [row] = await refundRows();
  expect(row).toMatchObject({ status: "failed" });
  expect(await reservation(code)).toMatchObject({ status: "confirmed", refundedAmount: 0 });
  const alerts = () => db.select().from(notifications).where(eq(notifications.ref, `${REFUND_FAILED_REF}${row.id}`));
  expect(await alerts()).toMatchObject([{ kind: "staff_payment_alert", to: STAFF, reservationId: id }]);

  const dash = async (at: Date) => (await getDashboard(db, propertyId, at)).alerts.filter((a) => a.kind === "refund_failed");
  expect(await dash(minutes(15))).toMatchObject([{ reservationId: id, code }]);
  expect(alertHref((await dash(minutes(15)))[0])).toBe("/admin/refunds");

  // Not asked again (no longer pending), not emailed again.
  expect(await runGatewayReconcile(deps, minutes(30))).toMatchObject({ refundsChecked: 0 });
  expect(await alerts()).toHaveLength(1);

  // A staff retry refunds and finishes the cancellation: the alert goes away.
  const member = { id: "s-manager", email: "manager@nk.test", name: "m", role: "manager" as const, propertyIds: [propertyId], active: true };
  const staff = { staff: member, email: member.email };
  expect(await reconcileRefund(deps, staff, row.id, { kind: "retry" }, minutes(31))).toMatchObject({ ok: true, completed: "cancellation" });
  expect(await reservation(code)).toMatchObject({ status: "cancelled" });
  expect(await dash(minutes(31))).toEqual([]);
});

test("a refund query that is still pending or fails leaves the row pending", async () => {
  const { deps, gateway, refundRows } = await stuckCancellation();
  const q = vi.spyOn(gateway, "queryRefund");
  q.mockResolvedValueOnce({ status: "pending" });
  expect(await runGatewayReconcile(deps, minutes(15))).toMatchObject({ refundsChecked: 1, refundsUnresolved: 1 });
  q.mockResolvedValueOnce({ error: "QUERY_DOWN" });
  expect(await runGatewayReconcile(deps, minutes(30))).toMatchObject({ refundsChecked: 1, refundsUnresolved: 1 });
  q.mockRejectedValueOnce(new Error("socket hang up"));
  expect(await runGatewayReconcile(deps, minutes(45))).toMatchObject({ refundsChecked: 1, refundsUnresolved: 1 });
  expect(await refundRows()).toMatchObject([{ status: "pending" }]);
});

test("a payment with no notice that the gateway reports succeeded goes through the notice path and confirms", async () => {
  const { db, deps, gateway, channel, code, ...s } = await (async () => {
    const s = await bookingSetup();
    return { ...s, code: await s.book() };
  })();
  const query = vi.spyOn(gateway, "queryTransaction").mockResolvedValue({ status: "succeeded", amount: PAY_NOW, providerRef: "BANK-777" });

  expect(await runGatewayReconcile(deps, minutes(9))).toMatchObject({ chargesChecked: 0 });
  expect(query).not.toHaveBeenCalled();

  expect(await runGatewayReconcile(deps, minutes(11))).toMatchObject({ chargesChecked: 1, chargesApplied: 1 });
  expect(query).toHaveBeenCalledWith({ merchantOrderNo: `${code}-1` });
  const res = await s.reservation(code);
  expect(res).toMatchObject({ status: "confirmed", syncState: "synced" });
  expect(channel.pushed.map((p) => p.code)).toEqual([code]);
  expect(await db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "charge"))))
    .toMatchObject([{ status: "succeeded", providerRef: "BANK-777", amount: PAY_NOW }]);
  expect(await db.select().from(paymentEvents)).toMatchObject([{ verdict: "accepted", providerRef: "BANK-777", reservationCode: code }]);

  // Paid now: never asked again; a late real notice is a duplicate.
  query.mockClear();
  expect(await runGatewayReconcile(deps, minutes(30))).toMatchObject({ chargesChecked: 0 });
  expect(query).not.toHaveBeenCalled();
  expect((await handlePaymentNotice(deps, await s.notice(code, { providerRef: "BANK-777" }), minutes(31))).verdict).toBe("duplicate");
});

test("a queried charge of the wrong amount is checked like a notice: the booking is refunded, not confirmed", async () => {
  const s = await bookingSetup();
  const code = await s.book();
  vi.spyOn(s.gateway, "queryTransaction").mockResolvedValue({ status: "succeeded", amount: PAY_NOW - 1, providerRef: "BANK-1" });
  expect(await runGatewayReconcile(s.deps, minutes(11))).toMatchObject({ chargesApplied: 1 });
  expect(await s.reservation(code)).toMatchObject({ status: "confirm_failed_refunded", refundedAmount: PAY_NOW - 1 });
  expect(await s.db.select().from(paymentEvents)).toMatchObject([{ verdict: "amount_mismatch" }]);
  expect(s.channel.pushed).toHaveLength(0);
});

test("a queried charge that is not succeeded changes nothing", async () => {
  const s = await bookingSetup();
  const code = await s.book();
  const q = vi.spyOn(s.gateway, "queryTransaction");
  for (const r of [{ status: "pending" as const }, { status: "not_found" as const }, { error: "DOWN" }]) {
    q.mockResolvedValueOnce(r);
    expect(await runGatewayReconcile(s.deps, minutes(11))).toMatchObject({ chargesChecked: 1, chargesApplied: 0 });
  }
  expect((await s.reservation(code)).status).toBe("pending_payment");
  expect(await s.db.select().from(paymentEvents)).toHaveLength(0);
});

test("the job records a job_runs row with its counts, or its error without throwing", async () => {
  const { db, deps } = await bookingSetup();
  await recordJob(db, GATEWAY_RECONCILE_JOB, minutes(20), () => runGatewayReconcile(deps, minutes(20)));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await recordJob(db, GATEWAY_RECONCILE_JOB, minutes(35), async () => { throw new Error("boom"); });
  error.mockRestore();
  const rows = await db.select().from(jobRuns).where(eq(jobRuns.name, GATEWAY_RECONCILE_JOB)).orderBy(jobRuns.startedAt);
  expect(rows).toMatchObject([
    { startedAt: minutes(20).getTime(), result: expect.objectContaining({ refundsChecked: 0, chargesChecked: 0 }) },
    { startedAt: minutes(35).getTime(), result: { error: "boom" } },
  ]);
});

test("each cron trigger runs its own job: the reconcile triggers record their own job_runs row, not the 5-minute cron's", async () => {
  const { db } = await bookingSetup();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const env = { PAYMENT_MODE: "mock", CHANNEL_MODE: "mock", ENVIRONMENT: "local" } as never;
  await runCronTrigger(env, CRON_GATEWAY_RECONCILE, minutes(20), db);
  await runCronTrigger(env, CRON_CHANNEL_RECONCILE, minutes(21), db);
  await runCronTrigger({ PAYMENT_MODE: "mock", ENVIRONMENT: "local" } as never, CRON_CHANNEL_RECONCILE, minutes(22), db);
  await runCronTrigger(env, CRON_EVERY_5_MIN, minutes(25), db);
  log.mockRestore(); warn.mockRestore();
  const rows = await db.select().from(jobRuns).orderBy(jobRuns.startedAt);
  expect(rows.map((r) => [r.name, r.result])).toEqual([
    [GATEWAY_RECONCILE_JOB, expect.objectContaining({ refundsChecked: 0, chargesChecked: 0 })],
    [CHANNEL_RECONCILE_JOB, expect.objectContaining({ checked: 0, mismatches: [] })],
    [CHANNEL_RECONCILE_JOB, { skipped: "CHANNEL_MODE_NOT_SET" }],
    [CRON_JOB, expect.objectContaining({ expired: expect.any(Number) })],
  ]);
});

/** A booking whose payment was started twice (attempt 1, then attempt 2 at +3 min), the gateway answering per attempt. */
async function twoAttempts(answers: Record<number, { status: "succeeded" | "pending" | "not_found"; providerRef?: string; amount?: number }>) {
  const s = await bookingSetup();
  const code = await s.book();
  expect(await s.book({}, minutes(3))).toBe(code); // same idempotency key: payment restarted
  expect((await s.reservation(code)).chargeAttempt).toBe(2);
  const query = vi.spyOn(s.gateway, "queryTransaction").mockImplementation(async ({ merchantOrderNo }) => {
    const n = Number(merchantOrderNo?.slice(code.length + 1));
    return answers[n] ?? { status: "not_found" };
  });
  const charges = async () => s.db.select().from(payments)
    .where(and(eq(payments.reservationId, (await s.reservation(code)).id), eq(payments.kind, "charge"), eq(payments.status, "succeeded")));
  return { ...s, code, query, charges };
}

test("an earlier attempt paid with its notice lost is found and applied though the guest's retry was abandoned", async () => {
  const { deps, code, query, charges, reservation } = await twoAttempts({
    1: { status: "succeeded", providerRef: "BANK-1", amount: PAY_NOW }, 2: { status: "pending" },
  });
  expect(await runGatewayReconcile(deps, minutes(15))).toMatchObject({ chargesApplied: 1 });
  expect(query).toHaveBeenCalledWith({ merchantOrderNo: `${code}-1` });
  expect(await reservation(code)).toMatchObject({ status: "confirmed" });
  expect(await charges()).toMatchObject([{ providerRef: "BANK-1", merchantOrderNo: `${code}-1` }]);

  // Attempt 1 is recorded now: only attempt 2 is asked about again.
  query.mockClear();
  expect(await runGatewayReconcile(deps, minutes(30))).toMatchObject({ chargesApplied: 0 });
  expect(query.mock.calls).toEqual([[{ merchantOrderNo: `${code}-2` }]]);
});

test("an earlier attempt's lost payment on a booking that has since expired takes the late-payment path", async () => {
  const { deps, code, reservation } = await twoAttempts({ 1: { status: "succeeded", providerRef: "BANK-1", amount: PAY_NOW } });
  const { runExpireHolds } = await import("@/lib/jobs/expire-holds");
  await runExpireHolds(deps, minutes(30));
  expect((await reservation(code)).status).toBe("expired");
  expect(await runGatewayReconcile(deps, minutes(31))).toMatchObject({ chargesApplied: 1 });
  expect(await reservation(code)).toMatchObject({ status: "confirmed" }); // re-held and confirmed, as a late notice would be
});

test("two attempts both paid: one settles, the other is refunded as a stray exactly once over repeated runs", async () => {
  const { db, deps, gateway, code, query, charges, reservation } = await twoAttempts({
    1: { status: "succeeded", providerRef: "BANK-1", amount: PAY_NOW }, 2: { status: "succeeded", providerRef: "BANK-2", amount: PAY_NOW },
  });
  expect(await runGatewayReconcile(deps, minutes(15))).toMatchObject({ chargesApplied: 2 });
  expect(await reservation(code)).toMatchObject({ status: "confirmed" });
  expect(gateway.refunds).toMatchObject([{ providerRef: "BANK-2", amount: PAY_NOW }]);
  expect((await db.select().from(paymentEvents)).map((e) => [e.providerRef, e.verdict]))
    .toEqual([["BANK-1", "accepted"], ["BANK-2", "stray_charge"]]);

  query.mockClear();
  await runGatewayReconcile(deps, minutes(30));
  await runGatewayReconcile(deps, minutes(45));
  expect(query).not.toHaveBeenCalled(); // both attempts are recorded
  expect(gateway.refunds).toHaveLength(1);
  expect((await charges()).map((c) => c.merchantOrderNo).sort()).toEqual([`${code}-1`, `${code}-2`]);
});

test("over 50 abandoned attempts do not starve a recent lost-notice payment: newest first, in a single run", async () => {
  const s = await bookingSetup({ available: 80 });
  for (let i = 0; i < 55; i++) await s.book({ idempotencyKey: `key-old-${String(i).padStart(4, "0")}` }, minutes(i % 5));
  const recent = await s.book({ idempotencyKey: "key-recent-0001" }, minutes(20));
  const query = vi.spyOn(s.gateway, "queryTransaction").mockImplementation(async ({ merchantOrderNo }) =>
    merchantOrderNo === `${recent}-1` ? { status: "succeeded", amount: PAY_NOW, providerRef: "BANK-NEW" } : { status: "not_found" });
  const r = await runGatewayReconcile(s.deps, minutes(31));
  expect(r).toMatchObject({ chargesChecked: 50, chargesApplied: 1 });
  expect(query.mock.calls[0]).toEqual([{ merchantOrderNo: `${recent}-1` }]);
  expect((await s.reservation(recent)).status).toBe("confirmed");
});

test("an attempt over an hour old is asked about about hourly, not on every 15-minute run", async () => {
  const s = await bookingSetup();
  await s.book();
  const query = vi.spyOn(s.gateway, "queryTransaction").mockResolvedValue({ status: "not_found" });
  for (let m = 15; m < 60; m += 15) await runGatewayReconcile(s.deps, minutes(m));
  expect(query).toHaveBeenCalledTimes(3); // first hour: every run
  query.mockClear();
  for (let m = 60; m < 180; m += 15) await runGatewayReconcile(s.deps, minutes(m));
  expect(query).toHaveBeenCalledTimes(2); // then once an hour
});

/**
 * deps whose db refuses every UPDATE of reservations (a worker dying mid-flow), everything else as usual;
 * with `afterSettle`, only once a payments row has been updated (the refund settled first).
 */
function failingReservationUpdates(deps: Deps, o: { afterSettle?: boolean } = {}): Deps {
  let armed = !o.afterSettle;
  const db = new Proxy(deps.db, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "update") return typeof v === "function" ? v.bind(target) : v;
      return (table: unknown) => {
        if (table === payments) armed = true;
        else if (table === reservations && armed) throw new Error("D1_ERROR: worker died");
        return (v as (t: unknown) => unknown).call(target, table);
      };
    },
  });
  return { ...deps, db };
}

test("a settled cancellation refund whose flow never finished (worker died) is finished by a later run, not by one inside its grace", async () => {
  const s = await stuckCancellation();
  // The gateway reports the refund made; the job settles the row, then finishing the cancellation dies.
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await runGatewayReconcile(failingReservationUpdates(s.deps, { afterSettle: true }), minutes(15))).toMatchObject({ refundsChecked: 1 });
  expect(await s.refundRows()).toMatchObject([{ status: "succeeded", settledAt: minutes(15).getTime() }]);
  expect(await s.reservation(s.code)).toMatchObject({ status: "confirmed" }); // refunded, but still holding the room
  // Staff are told, once.
  const [row] = await s.refundRows();
  const told = () => s.db.select().from(notifications).where(eq(notifications.ref, `${FLOW_UNFINISHED_REF}${row.id}`));
  expect(await told()).toMatchObject([{ kind: "staff_payment_alert", to: STAFF }]);

  // Within the grace after settling (a live cancel may still be finishing it): left alone.
  expect(await runGatewayReconcile(s.deps, minutes(20))).toMatchObject({ flowsFinished: 0 });
  expect((await s.reservation(s.code)).status).toBe("confirmed");

  // Later: finished, the room released, the guest emailed once; staff not told again.
  expect(await runGatewayReconcile(s.deps, minutes(30))).toMatchObject({ flowsFinished: 1, flowsFailed: 0 });
  expect(await s.reservation(s.code)).toMatchObject({ status: "cancelled", refundedAmount: row.amount, cancelledAt: minutes(2).getTime() });
  expect(s.channel.records).toMatchObject([{ code: s.code, state: "cancelled" }]);
  expect(s.email.sent.filter((e) => e.to === GUEST && e.subject.includes("cancelled"))).toHaveLength(1);
  expect(await told()).toHaveLength(1);

  // Nothing left to finish.
  expect(await runGatewayReconcile(s.deps, minutes(45))).toMatchObject({ flowsFinished: 0, flowsFailed: 0 });
  error.mockRestore();
});

test("the sweep keeps trying a flow that throws, alerting staff once per row", async () => {
  const s = await stuckCancellation();
  const [pending] = await s.refundRows();
  // The live cancel's refund settled, and then the request died before cancelling the booking.
  await settleRefundRow(s.db, pending, "BANK-R", true, minutes(3));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await runGatewayReconcile(failingReservationUpdates(s.deps), minutes(15))).toMatchObject({ flowsFinished: 0, flowsFailed: 1 });
  expect(await runGatewayReconcile(failingReservationUpdates(s.deps), minutes(30))).toMatchObject({ flowsFailed: 1 });
  error.mockRestore();
  expect(await s.db.select().from(notifications).where(eq(notifications.ref, `${FLOW_UNFINISHED_REF}${pending.id}`))).toHaveLength(1);
  expect(await runGatewayReconcile(s.deps, minutes(45))).toMatchObject({ flowsFinished: 1 });
  expect((await s.reservation(s.code)).status).toBe("cancelled");
});

test("a failed booking whose refund settled but was never closed is refunded-and-failed by the sweep", async () => {
  const s = await bookingSetup({ refundTimeoutNext: 1 });
  const code = await s.book();
  // Paid the wrong amount: refundAndFail; the refund's answer is lost and the gateway cannot say yet.
  vi.spyOn(s.gateway, "queryRefund").mockResolvedValueOnce({ status: "pending" });
  await handlePaymentNotice(s.deps, await s.notice(code, { amount: PAY_NOW - 1 }), minutes(1));
  const res = await s.reservation(code);
  expect(res).toMatchObject({ status: "paid_pending_confirm", syncState: "failed" });
  const [row] = await s.db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund")));
  expect(row).toMatchObject({ status: "pending", idempotencyKey: expect.stringMatching(/^fail:/) });
  // Settled (e.g. by an earlier run) but the booking was never closed.
  await settleRefundRow(s.db, row, "BANK-R", true, minutes(2));

  expect(await runGatewayReconcile(s.deps, minutes(15))).toMatchObject({ flowsFinished: 1 });
  expect(await s.reservation(code)).toMatchObject({ status: "confirm_failed_refunded", refundedAmount: PAY_NOW - 1 });
  expect(s.gateway.refunds).toHaveLength(1); // nothing refunded twice
  expect(await runGatewayReconcile(s.deps, minutes(30))).toMatchObject({ flowsFinished: 0 });
});

/** A stuck cancellation plus `extra` more pending refund rows on it (staff-modification refunds), all due. */
async function manyPendingRefunds(extra: number) {
  const s = await stuckCancellation();
  for (let n = 1; n <= extra; n++)
    await s.db.insert(payments).values({
      id: `extra-${n}`, reservationId: s.id, kind: "refund", method: s.row.method, amount: 10, status: "pending",
      refundOf: s.row.refundOf, idempotencyKey: `modify:${s.id}:${n}`, createdAt: minutes(2).getTime() + n,
    });
  return s;
}

test("the run stops calling the gateway after 5 consecutive errors, and records that it stopped early", async () => {
  const s = await manyPendingRefunds(6);
  const q = vi.spyOn(s.gateway, "queryRefund").mockResolvedValue({ error: "DOWN" });
  const tx = vi.spyOn(s.gateway, "queryTransaction");
  q.mockClear(); // the stuck cancellation's own query
  const r = await recordJob(s.db, GATEWAY_RECONCILE_JOB, minutes(15), () => runGatewayReconcile(s.deps, minutes(15)));
  expect(r).toMatchObject({ refundsChecked: 5, refundsUnresolved: 5, stoppedEarly: "errors" });
  expect(q).toHaveBeenCalledTimes(5);
  expect(tx).not.toHaveBeenCalled();
  const [run] = await s.db.select().from(jobRuns).where(eq(jobRuns.name, GATEWAY_RECONCILE_JOB));
  expect(run.result).toMatchObject({ stoppedEarly: "errors" });

  // An answer in between resets the count.
  q.mockReset();
  q.mockResolvedValueOnce({ error: "DOWN" }).mockResolvedValueOnce({ error: "DOWN" }).mockResolvedValueOnce({ status: "pending" })
    .mockResolvedValue({ error: "DOWN" });
  const again = await runGatewayReconcile(s.deps, minutes(30));
  expect(again).toMatchObject({ refundsChecked: 7 });
  expect(again.stoppedEarly).toBeUndefined();
});

test("the run stops issuing gateway calls once its wall-clock budget is spent", async () => {
  const s = await manyPendingRefunds(2);
  let t = 0;
  const clock = () => t;
  vi.spyOn(s.gateway, "queryRefund").mockImplementation(async () => { t += 6 * 60_000; return { status: "pending" }; });
  const tx = vi.spyOn(s.gateway, "queryTransaction");
  expect(GATEWAY_RECONCILE_BUDGET_MS).toBeLessThanOrEqual(10 * 60_000);
  expect(await runGatewayReconcile(s.deps, minutes(15), { clock })).toMatchObject({ refundsChecked: 2, stoppedEarly: "deadline" });
  expect(tx).not.toHaveBeenCalled();
});
