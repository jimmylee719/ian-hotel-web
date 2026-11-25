import { expect, test, vi } from "vitest";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { MockChannelManager } from "@/lib/channel/mock";
import { runSyncRetry } from "@/lib/jobs/sync-retry";
import { bookingSetup, minutes, PAY_NOW } from "@/tests/helpers/booking";
import { channelConformance } from "@/tests/conformance/channel";

channelConformance(() => new MockChannelManager(), {
  fixtures: { timingOut: () => new MockChannelManager({ timeoutNext: 1 }) },
});

test("a push that reached the channel but timed out is confirmed by lookup on retry, never pushed twice", async () => {
  const channel = new MockChannelManager({ timeoutNext: 1 });
  const { deps, email, book, reservation, notice } = await bookingSetup({ channel });
  const push = vi.spyOn(channel, "pushReservation");
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(2));
  expect(await reservation(code)).toMatchObject({ status: "paid_pending_confirm", syncState: "pending", syncAttempts: 1, lastSyncError: "TIMEOUT" });
  expect(channel.pushed).toHaveLength(1); // it did land

  expect(await runSyncRetry(deps, minutes(7))).toEqual({ attempted: 1 });
  const atChannel = await channel.lookupReservation(code);
  if (!("found" in atChannel && atChannel.found)) throw new Error("not at the channel");
  expect(atChannel.state).toBe("active");
  expect(await reservation(code)).toMatchObject({
    status: "confirmed", syncState: "synced", lastSyncError: null, smConfirmation: atChannel.smConfirmation,
  });
  expect(push).toHaveBeenCalledTimes(1);
  expect(channel.pushed).toHaveLength(1);
  expect(email.sent).toHaveLength(2); // guest confirmation + staff new booking
});

test("a booking refunded after pushes kept failing is cancelled at the channel if lookup finds it there", async () => {
  // All 7 pushes land but their answers are lost, and lookups are down while the retries run.
  const channel = new MockChannelManager({ timeoutNext: 7 });
  const { deps, gateway, book, reservation, notice } = await bookingSetup({ channel });
  const lookup = vi.spyOn(channel, "lookupReservation").mockResolvedValue({ error: "LOOKUP_DOWN", retryable: true });
  const cancel = vi.spyOn(channel, "cancelReservation");
  const refund = vi.spyOn(gateway, "refund");
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(0));
  for (let i = 1; i <= 6; i++) await runSyncRetry(deps, minutes(5 * i));

  let res = await reservation(code);
  expect(res).toMatchObject({ status: "confirm_failed_refunded", refundedAmount: PAY_NOW, syncState: "pending" });
  expect(refund).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
  expect(channel.pushed.map((p) => p.code)).toEqual([code]); // the channel still holds it

  lookup.mockRestore();
  expect(await runSyncRetry(deps, minutes(40))).toEqual({ attempted: 1 });
  expect(cancel).toHaveBeenCalledWith(code);
  expect(channel.pushed).toEqual([]);
  expect(await channel.lookupReservation(code)).toMatchObject({ found: true, state: "cancelled" });
  res = await reservation(code);
  expect(res).toMatchObject({ status: "confirm_failed_refunded", syncState: "synced", nextSyncAt: null });
  expect(await runSyncRetry(deps, minutes(60))).toEqual({ attempted: 0 });
});

test("a refunded booking the channel never got needs no cancel", async () => {
  const channel = new MockChannelManager({ failNext: 1, retryable: false });
  const { deps, book, reservation, notice } = await bookingSetup({ channel });
  const cancel = vi.spyOn(channel, "cancelReservation");
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(0));
  expect(await reservation(code)).toMatchObject({ status: "confirm_failed_refunded", syncState: "pending" });

  expect(await runSyncRetry(deps, minutes(5))).toEqual({ attempted: 1 });
  expect(cancel).not.toHaveBeenCalled();
  expect(await reservation(code)).toMatchObject({ status: "confirm_failed_refunded", syncState: "synced" });
});
