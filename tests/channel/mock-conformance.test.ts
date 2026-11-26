import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import type { ChannelManager } from "@/lib/channel/types";
import { syncWithChannel } from "@/lib/booking/channel-sync";
import { refundAndFail } from "@/lib/booking/confirm";
import { cancelReservation } from "@/lib/booking/manage";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { reservations } from "@/lib/db/schema";
import { toChannelReservation } from "@/lib/booking/to-channel";
import { MockChannelManager } from "@/lib/channel/mock";
import { runSyncRetry } from "@/lib/jobs/sync-retry";
import { bookingSetup, minutes, PAY_NOW } from "@/tests/helpers/booking";
import { channelConformance } from "@/tests/conformance/channel";

channelConformance(() => new MockChannelManager(), {
  fixtures: { timingOut: () => new MockChannelManager({ timeoutNext: 1 }) },
});

/** The mock with its lookup taken away: the suite must hold for a channel that has none (SiteMinder, doc §8.3). */
const withoutLookup = (cm: MockChannelManager): ChannelManager => ({
  timeoutMs: cm.timeoutMs,
  pushReservation: cm.pushReservation.bind(cm),
  modifyReservation: cm.modifyReservation.bind(cm),
  cancelReservation: cm.cancelReservation.bind(cm),
});
describe("without lookup", () => {
  channelConformance(() => withoutLookup(new MockChannelManager()), {
    fixtures: { timingOut: () => withoutLookup(new MockChannelManager({ timeoutNext: 1 })) },
  });
});

test("a push that reached the channel but timed out is recovered by sending the same code again; modify and cancel then carry its smConfirmation", async () => {
  const channel = new MockChannelManager({ timeoutNext: 1 });
  const { db, deps, email, book, reservation, notice } = await bookingSetup({ channel });
  const push = vi.spyOn(channel, "pushReservation");
  const code = await book();
  await handlePaymentNotice(deps, await notice(code), minutes(2));
  expect(await reservation(code)).toMatchObject({ status: "confirmed", syncState: "pending", syncAttempts: 1, lastSyncError: "TIMEOUT", smConfirmation: null });
  expect(channel.pushed).toHaveLength(1); // it did land

  expect(await runSyncRetry(deps, minutes(7))).toEqual({ attempted: 1 });
  const [held] = channel.records;
  expect(held).toMatchObject({ code, state: "active" });
  expect(await reservation(code)).toMatchObject({
    status: "confirmed", syncState: "synced", lastSyncError: null, smConfirmation: held.smConfirmation,
  });
  expect(push).toHaveBeenCalledTimes(2); // the same code again: the channel answers with what it holds
  expect(channel.pushed).toHaveLength(1);
  expect(email.sent).toHaveLength(2); // guest confirmation + staff new booking, at payment time

  // A later staff modification's sync, then a guest cancel: both name the same channel record.
  const modify = vi.spyOn(channel, "modifyReservation");
  const cancel = vi.spyOn(channel, "cancelReservation");
  const { id } = await reservation(code);
  await db.update(reservations).set({ syncState: "pending", nextSyncAt: null }).where(eq(reservations.id, id));
  await syncWithChannel(deps, id, minutes(8));
  expect(modify).toHaveBeenCalledWith(expect.objectContaining({ code }), held.smConfirmation);
  expect(await reservation(code)).toMatchObject({ syncState: "synced", smConfirmation: held.smConfirmation });
  expect(await cancelReservation(deps, code, "mei@example.com", minutes(9))).toMatchObject({ ok: true });
  expect(cancel).toHaveBeenCalledWith(code, held.smConfirmation);
  expect(await reservation(code)).toMatchObject({ status: "cancelled", syncState: "synced" });
  expect(channel.records).toEqual([{ code, smConfirmation: held.smConfirmation, state: "cancelled" }]);
});

test("a booking the earlier design refunded after push attempts is sent again, then cancelled at the channel", async () => {
  const channel = new MockChannelManager();
  const { db, deps, book, reservation, notice } = await bookingSetup({ channel });
  const code = await book();
  // Left as the earlier design could: paid_pending_confirm with push attempts made, one of which landed.
  await db.$client.exec(`CREATE TRIGGER boom BEFORE UPDATE OF next_sync_at ON reservations
    WHEN OLD.status = 'paid_pending_confirm' BEGIN SELECT RAISE(ABORT, 'crash'); END`);
  await expect(handlePaymentNotice(deps, await notice(code), minutes(0))).rejects.toThrow();
  db.$client.exec("DROP TRIGGER boom");
  const { id } = await reservation(code);
  await db.update(reservations).set({ syncAttempts: 2 }).where(eq(reservations.id, id));
  await channel.pushReservation(await toChannelReservation(db, id));
  expect(await refundAndFail(deps, id, "TIMEOUT", minutes(30), { guestKind: "booking_failed_refunded", staffKind: "staff_sync_failed" })).toBe(true);
  expect(await reservation(code)).toMatchObject({ status: "confirm_failed_refunded", refundedAmount: PAY_NOW, syncState: "pending" });

  const cancel = vi.spyOn(channel, "cancelReservation");
  expect(await runSyncRetry(deps, minutes(30))).toEqual({ attempted: 1 });
  expect(cancel).toHaveBeenCalledWith(code, channel.records[0].smConfirmation);
  expect(channel.records).toMatchObject([{ code, state: "cancelled" }]);
  expect(await reservation(code)).toMatchObject({ status: "confirm_failed_refunded", syncState: "synced", nextSyncAt: null, lastSyncError: "TIMEOUT" });
  expect(await runSyncRetry(deps, minutes(60))).toEqual({ attempted: 0 });
});

test("a booking refunded before any push (amount mismatch) keeps syncState failed and is not checked at the channel", async () => {
  const channel = new MockChannelManager();
  const { deps, book, reservation, notice } = await bookingSetup({ channel });
  const lookup = vi.spyOn(channel, "lookupReservation");
  const push = vi.spyOn(channel, "pushReservation");
  const code = await book();
  await handlePaymentNotice(deps, await notice(code, { amount: PAY_NOW - 1 }), minutes(0));
  expect(await reservation(code)).toMatchObject({ status: "confirm_failed_refunded", syncState: "failed", nextSyncAt: null });

  expect(await runSyncRetry(deps, minutes(10))).toEqual({ attempted: 0 });
  expect(push).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
});
