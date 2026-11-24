import { expect, test, vi } from "vitest";
import { refundAndFail } from "@/lib/booking/confirm";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { MockChannelManager } from "@/lib/channel/mock";
import type { PushResult } from "@/lib/channel/types";
import { runExpireHolds } from "@/lib/jobs/expire-holds";
import { runSyncRetry } from "@/lib/jobs/sync-retry";
import { bookingSetup, minutes, PAY_NOW } from "@/tests/helpers/booking";
import { rawSqlite, type TestDb } from "@/tests/helpers/test-db";

const tick = () => new Promise((r) => setImmediate(r));

/** Make any UPDATE of next_sync_at on a paid_pending_confirm booking fail, i.e. crash right after the claim. */
const crashAfterClaim = (db: TestDb) => rawSqlite(db).exec(`CREATE TRIGGER boom BEFORE UPDATE OF next_sync_at ON reservations
  WHEN OLD.status = 'paid_pending_confirm' BEGIN SELECT RAISE(ABORT, 'crash'); END`);
/** Make any status change fail, i.e. crash right after the charge is recorded. */
const crashBeforeClaim = (db: TestDb) => rawSqlite(db).exec(`CREATE TRIGGER boom BEFORE UPDATE OF status ON reservations
  BEGIN SELECT RAISE(ABORT, 'crash'); END`);
const recover = (db: TestDb) => rawSqlite(db).exec(`DROP TRIGGER boom`);

test("overlapping retry runs push a booking exactly once", async () => {
  const { deps, channel, book, reservation, notice } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 1, retryable: true }),
  });
  const push = vi.spyOn(channel, "pushReservation");
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(0));
  expect(push).toHaveBeenCalledTimes(1);

  const runs = await Promise.all([runSyncRetry(deps, minutes(5)), runSyncRetry(deps, minutes(5))]);
  expect(push).toHaveBeenCalledTimes(2);
  expect(runs.reduce((s, r) => s + r.attempted, 0)).toBeGreaterThanOrEqual(1);
  expect((await reservation(code)).status).toBe("confirmed");
});

test("a push that succeeds after a refund claimed the booking never confirms it", async () => {
  let release!: (r: PushResult) => void;
  class SlowChannel extends MockChannelManager {
    override pushReservation() {
      return new Promise<PushResult>((resolve) => { release = resolve; });
    }
  }
  const { deps, gateway, book, reservation, notice } = await bookingSetup({ channel: new SlowChannel() });
  const code = await book();
  const handling = handlePaymentNotice(deps, await notice(code), minutes(2));
  while (!release) await tick();
  const { id } = await reservation(code);

  // Another worker gives up and refunds; while the refund is in flight the slow push succeeds.
  const realRefund = gateway.refund.bind(gateway);
  vi.spyOn(gateway, "refund").mockImplementation(async (r) => {
    release({ ok: true, smConfirmation: "SM-LATE" });
    await handling;
    return realRefund(r);
  });
  expect(await refundAndFail(deps, id, "TEST_GIVE_UP", minutes(3), { staffKind: "staff_sync_failed" })).toBe(true);

  const res = await reservation(code);
  expect(res.status).toBe("confirm_failed_refunded");
  expect(res.syncState).toBe("failed");
  expect(res.smConfirmation).toBeNull();
  expect(res.refundedAmount).toBe(PAY_NOW);
});

test("a crash after claiming a late (expired) payment is finished by the retry job", async () => {
  const { db, deps, book, reservation, notice, avail } = await bookingSetup();
  const code = await book();
  await runExpireHolds(deps, minutes(21));
  crashAfterClaim(db);
  await expect(handlePaymentNotice(deps, await notice(code), minutes(22))).rejects.toThrow();
  recover(db);
  expect((await reservation(code)).status).toBe("paid_pending_confirm");

  expect(await runSyncRetry(deps, minutes(22))).toEqual({ attempted: 1 });
  expect((await reservation(code)).status).toBe("confirmed");
  expect(await avail()).toBe(2);
});

test("a crash after claiming a mismatched payment is refunded by the retry job", async () => {
  const { db, deps, gateway, book, reservation, notice, avail } = await bookingSetup();
  const refund = vi.spyOn(gateway, "refund");
  const code = await book();
  crashAfterClaim(db);
  await expect(handlePaymentNotice(deps, await notice(code, { amount: PAY_NOW - 1 }), minutes(2))).rejects.toThrow();
  recover(db);

  expect(await runSyncRetry(deps, minutes(2))).toEqual({ attempted: 1 });
  const res = await reservation(code);
  expect(res.status).toBe("confirm_failed_refunded");
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ providerRef: `REF-${code}`, amount: PAY_NOW - 1 }));
  expect(await avail()).toBe(3);
});

test("a crash right after recording the charge is finished by the provider's resend", async () => {
  const { db, deps, book, reservation, notice } = await bookingSetup();
  const code = await book();
  const n = await notice(code);
  crashBeforeClaim(db);
  await expect(handlePaymentNotice(deps, n, minutes(2))).rejects.toThrow();
  recover(db);
  expect((await reservation(code)).status).toBe("pending_payment");

  expect(await handlePaymentNotice(deps, n, minutes(3))).toEqual({ status: 200, verdict: "duplicate" });
  expect((await reservation(code)).status).toBe("confirmed");
});

test("a crash right after recording the charge, with no resend, is not expired but confirmed by the jobs", async () => {
  const { db, deps, book, reservation, notice, avail } = await bookingSetup();
  const code = await book();
  crashBeforeClaim(db);
  await expect(handlePaymentNotice(deps, await notice(code), minutes(2))).rejects.toThrow();
  recover(db);

  expect(await runExpireHolds(deps, minutes(21))).toEqual({ expired: 0 });
  expect((await reservation(code)).status).toBe("paid_pending_confirm");
  expect(await avail()).toBe(2);
  expect(await runSyncRetry(deps, minutes(21))).toEqual({ attempted: 1 });
  expect((await reservation(code)).status).toBe("confirmed");
});
