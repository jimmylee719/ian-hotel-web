import { and, eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { MockChannelManager } from "@/lib/channel/mock";
import { payments } from "@/lib/db/schema";
import { runSyncRetry } from "@/lib/jobs/sync-retry";
import { bookingSetup, minutes } from "@/tests/helpers/booking";

test("a retryable failure leaves the booking confirmed with its push pending, and the retry job pushes it 5 minutes later", async () => {
  const { deps, channel, email, book, reservation, notice } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 1, retryable: true }),
  });
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(2));

  let res = await reservation(code);
  expect(res.status).toBe("confirmed");
  expect(res.syncState).toBe("pending");
  expect(res.syncAttempts).toBe(1);
  expect(res.nextSyncAt).toBe(minutes(7).getTime());
  expect(res.lastSyncError).toBe("MOCK_FAILURE");
  expect(email.sent).toHaveLength(2); // the guest's confirmation and staff's new-booking email went out at once

  expect(await runSyncRetry(deps, minutes(6))).toEqual({ attempted: 0 });
  expect(await runSyncRetry(deps, minutes(7))).toEqual({ attempted: 1 });
  res = await reservation(code);
  expect(res.status).toBe("confirmed");
  expect(res.syncState).toBe("synced");
  expect(channel.pushed).toHaveLength(1);
  expect(email.sent).toHaveLength(2);
});

test("a hand-off that keeps failing never refunds the guest or releases the rooms", async () => {
  const { db, deps, gateway, channel, book, reservation, notice, avail } = await bookingSetup({
    channel: new MockChannelManager({ failNext: 50, retryable: true }),
  });
  const refund = vi.spyOn(gateway, "refund");
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(0));
  for (let i = 1; i <= 10; i++) await runSyncRetry(deps, minutes(60 * i));

  const res = await reservation(code);
  expect(res).toMatchObject({ status: "confirmed", syncState: "pending", syncAttempts: 11, refundedAmount: 0 });
  expect(refund).not.toHaveBeenCalled();
  expect(await db.select().from(payments).where(and(eq(payments.reservationId, res.id), eq(payments.kind, "refund")))).toEqual([]);
  expect(channel.pushed).toHaveLength(0);
  expect(await avail()).toBe(2);
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
