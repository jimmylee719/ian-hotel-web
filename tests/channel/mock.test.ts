import { expect, test } from "vitest";
import { MockChannelManager } from "@/lib/channel/mock";
import type { ChannelReservation } from "@/lib/channel/types";

const res: ChannelReservation = {
  code: "NK-TEST01", smPropertyCode: "NK", checkIn: "2026-12-01", checkOut: "2026-12-03",
  rooms: [{ smRoomCode: "MIX", smRatePlanCode: "DIRECT", nightlyPrices: [2000, 2400], roomName: "混合房", ratePlanName: "官網價" }],
  guest: { firstName: "Mei", lastName: "Lin", email: "mei@example.com", phone: "+886900000000" },
  adults: 2, children: 0, currency: "TWD", createdAt: Date.UTC(2026, 10, 20), lastModifiedAt: Date.UTC(2026, 10, 20),
  total: 4400, paidAmount: 4400, discount: 0, addons: [],
};

test("a retryable failure is reported, then the retry succeeds with a confirmation", async () => {
  const cm = new MockChannelManager({ failNext: 1, retryable: true });
  expect(await cm.pushReservation(res)).toEqual({ ok: false, retryable: true, error: "MOCK_FAILURE" });
  const ok = await cm.pushReservation(res);
  expect(ok.ok && ok.smConfirmation).toMatch(/^SM-/);
  expect(cm.pushed).toHaveLength(1);
});

test("cancel removes a pushed reservation", async () => {
  const cm = new MockChannelManager();
  const p = await cm.pushReservation(res);
  expect(await cm.cancelReservation(res, p.ok ? p.smConfirmation : "")).toEqual({ ok: true, retryable: false });
  expect(cm.pushed).toHaveLength(0);
});
