import { expect, test, vi } from "vitest";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { runExpireHolds } from "@/lib/jobs/expire-holds";
import { bookingSetup, minutes, PAY_NOW } from "@/tests/helpers/booking";

test("an unpaid hold expires after 20 minutes and gives the room back", async () => {
  const { deps, book, reservation, avail } = await bookingSetup();
  const code = await book();
  expect(await avail()).toBe(2);
  expect(await runExpireHolds(deps, minutes(19))).toEqual({ expired: 0 });
  expect(await runExpireHolds(deps, minutes(21))).toEqual({ expired: 1 });
  const res = await reservation(code);
  expect(res.status).toBe("expired");
  expect(res.holdExpiresAt).toBeNull();
  expect(await avail()).toBe(3);
  expect(await runExpireHolds(deps, minutes(22))).toEqual({ expired: 0 });
  expect(await avail()).toBe(3);
});

test("a payment after expiry still confirms when the room is free", async () => {
  const { deps, channel, book, reservation, notice, avail } = await bookingSetup();
  const code = await book();
  await runExpireHolds(deps, minutes(21));
  expect(await handlePaymentNotice(deps, await notice(code), minutes(22))).toEqual({ status: 200, verdict: "accepted" });
  expect((await reservation(code)).status).toBe("confirmed");
  expect(channel.pushed).toHaveLength(1);
  expect(await avail()).toBe(2);
});

test("a payment after expiry is refunded when someone else took the room", async () => {
  const { deps, gateway, channel, email, book, reservation, notice, avail } = await bookingSetup({ available: 1 });
  const refund = vi.spyOn(gateway, "refund");
  const code = await book();
  await runExpireHolds(deps, minutes(21));
  expect(await avail()).toBe(1);
  await book({ idempotencyKey: "key-other-abcdef", guest: { firstName: "A", lastName: "B", email: "b@example.com", phone: "1", country: "TW" } }, minutes(21));
  expect(await avail()).toBe(0);

  await handlePaymentNotice(deps, await notice(code), minutes(22));
  const res = await reservation(code);
  expect(res.status).toBe("confirm_failed_refunded");
  expect(res.refundedAmount).toBe(PAY_NOW);
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({ amount: PAY_NOW }));
  expect(channel.pushed).toHaveLength(0);
  expect(await avail()).toBe(0); // the other booking keeps its room
  expect(email.sent.some((e) => e.to === "mei@example.com" && e.subject.includes("could not complete"))).toBe(true);
});
