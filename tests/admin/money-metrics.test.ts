import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  countsAsReceived, displayMoney, EMPTY_METRICS, moneyOf, receivedOf, receivedSum, summarizeMoney, type MoneyMetrics,
} from "@/lib/admin/money-metrics";
import { payments } from "@/lib/db/schema";
import { bookingSetup } from "@/tests/helpers/booking";

const m: MoneyMetrics = { onlineNet: 2000, frontDeskNet: 0, received: 2000, grossReceived: 3000, refunded: 1000 };

describe("displayMoney", () => {
  it.each(["pending_payment", "paid_pending_confirm", "confirmed"])("%s: net paid and the balance still owed", (status) => {
    expect(displayMoney(status, 4000, m)).toEqual({ paid: 2000, refunded: 1000, balanceDue: 2000 });
  });

  it.each(["cancelled", "expired", "confirm_failed_refunded"])("%s: balanceDue is null, amounts unchanged", (status) => {
    expect(displayMoney(status, 4000, m)).toEqual({ paid: 2000, refunded: 1000, balanceDue: null });
  });

  it("keeps an overpayment as a negative balance on an open booking", () => {
    expect(displayMoney("confirmed", 1000, { ...EMPTY_METRICS, onlineNet: 1500, received: 1500, grossReceived: 1500 }).balanceDue).toBe(-500);
  });
});

describe("summarizeMoney", () => {
  it("splits online and front-desk money; received is net, grossReceived before refunds", () => {
    expect(summarizeMoney([
      { kind: "charge", amount: 3000 }, { kind: "refund", amount: 1000 }, { kind: "front_desk", amount: 500 },
    ])).toEqual({ onlineNet: 2000, frontDeskNet: 500, received: 2500, grossReceived: 3500, refunded: 1000 });
  });

  it("a refund paid out at the desk comes off the desk's net, not the online net", () => {
    expect(summarizeMoney([
      { kind: "charge", amount: 3000 }, { kind: "front_desk", amount: 7000 }, { kind: "refund", amount: 3000, method: "sinopac_online" },
      { kind: "refund", amount: 2000, method: "cash" },
    ])).toEqual({ onlineNet: 0, frontDeskNet: 5000, received: 5000, grossReceived: 10000, refunded: 5000 });
  });
});

it("the SQL aggregate agrees with the TS fold: charges, refunds, front desk, voids, pending, failed and preauth rows", async () => {
  const s = await bookingSetup();
  const code = await s.book();
  const { id } = await s.reservation(code);
  const row = (kind: "charge" | "preauth" | "capture" | "refund" | "front_desk", status: "succeeded" | "pending" | "failed", amount: number, desk = kind === "front_desk") =>
    ({ id: crypto.randomUUID(), reservationId: id, kind, status, amount, method: desk ? "cash" as const : "sinopac_online" as const, createdAt: 1 });
  await s.db.insert(payments).values([
    row("charge", "succeeded", 4000), row("charge", "failed", 4000), row("refund", "succeeded", 700), row("refund", "pending", 300),
    row("front_desk", "succeeded", 1200), row("front_desk", "failed", 900) /* voided */, row("preauth", "succeeded", 5000),
    row("capture", "succeeded", 5000), row("refund", "succeeded", 200, true) /* paid out at the desk */,
  ]);
  const ts = await moneyOf(s.db, id);
  expect(ts).toEqual({ onlineNet: 3300, frontDeskNet: 1000, received: 4300, grossReceived: 5200, refunded: 900 });
  const [agg] = await s.db.select({ v: receivedSum }).from(payments).where(and(eq(payments.reservationId, id), countsAsReceived));
  const [scalar] = await s.db.select({ v: receivedOf(id) }).from(payments).limit(1);
  expect(Number(agg.v)).toBe(ts.received);
  expect(Number(scalar.v)).toBe(ts.received);
});
