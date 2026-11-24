import { and, eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { MockChannelManager } from "@/lib/channel/mock";
import { payments } from "@/lib/db/schema";
import { runSyncRetry } from "@/lib/jobs/sync-retry";
import { bookingSetup, minutes, PAY_NOW, STAFF } from "@/tests/helpers/booking";

test("a retryable failure leaves the booking pending, and the retry job confirms it 5 minutes later", async () => {
  const { deps, channel, email, book, reservation, notice } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 1, retryable: true }),
  });
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(2));

  let res = await reservation(code);
  expect(res.status).toBe("paid_pending_confirm");
  expect(res.syncState).toBe("pending");
  expect(res.syncAttempts).toBe(1);
  expect(res.nextSyncAt).toBe(minutes(7).getTime());
  expect(res.lastSyncError).toBe("MOCK_FAILURE");
  expect(email.sent).toHaveLength(0);

  expect(await runSyncRetry(deps, minutes(6))).toEqual({ attempted: 0 });
  expect(await runSyncRetry(deps, minutes(7))).toEqual({ attempted: 1 });
  res = await reservation(code);
  expect(res.status).toBe("confirmed");
  expect(res.syncState).toBe("synced");
  expect(channel.pushed).toHaveLength(1);
  expect(email.sent).toHaveLength(2);
});

test("after the 6th failed retry the booking is refunded", async () => {
  const { db, deps, gateway, channel, email, book, reservation, notice, avail } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 7, retryable: true }),
  });
  const refund = vi.spyOn(gateway, "refund");
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(0));

  for (let i = 1; i <= 5; i++) {
    expect(await runSyncRetry(deps, minutes(5 * i))).toEqual({ attempted: 1 });
    const res = await reservation(code);
    expect([res.status, res.syncState, res.syncAttempts]).toEqual(["paid_pending_confirm", "pending", i + 1]);
  }
  expect(refund).not.toHaveBeenCalled();

  expect(await runSyncRetry(deps, minutes(30))).toEqual({ attempted: 1 });
  const res = await reservation(code);
  expect(res.status).toBe("confirm_failed_refunded");
  expect(res.syncState).toBe("failed");
  expect(res.refundedAmount).toBe(PAY_NOW);
  expect(refund).toHaveBeenCalledTimes(1);
  expect(channel.pushed).toHaveLength(0);
  expect(await avail()).toBe(3);
  // The refund intent went pending → succeeded under its own idempotency key.
  const rows = await db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund")));
  expect(rows).toMatchObject([{ status: "succeeded", amount: PAY_NOW, providerRef: gateway.refunds[0].refundRef }]);
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: rows[0].id }));
  expect(email.sent.map((e) => e.to).sort()).toEqual(["mei@example.com", STAFF]);

  expect(await runSyncRetry(deps, minutes(60))).toEqual({ attempted: 0 });
});

test("the retry job handles at most 20 bookings per run", async () => {
  const { deps, book, notice } = await bookingSetup({
    available: 30,
    channel: new MockChannelManager({ failNext: 25, retryable: true }),
  });
  for (let i = 0; i < 25; i++) {
    const code = await book({ idempotencyKey: `key-batch-${String(i).padStart(4, "0")}` });
    await handlePaymentNotice(deps, await notice(code), minutes(0));
  }
  expect(await runSyncRetry(deps, minutes(5))).toEqual({ attempted: 20 });
  expect(await runSyncRetry(deps, minutes(5))).toEqual({ attempted: 5 });
});
