import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { reservations } from "@/lib/db/schema";
import { bookingSetup, minutes, PAY_NOW } from "@/tests/helpers/booking";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";

test("migration 0023 marks refunded bookings queued for a channel check by the earlier design as pushed", async () => {
  const s = await bookingSetup();
  const queued = await s.book({ idempotencyKey: "key-queued-0001" });
  const plain = await s.book({ idempotencyKey: "key-plain-00002" });
  for (const c of [queued, plain]) await handlePaymentNotice(s.deps, await s.notice(c, { amount: PAY_NOW - 1 }), minutes(1));
  const q = await s.reservation(queued);
  await s.db.update(reservations).set({ syncState: "pending", channelPushedAt: null, updatedAt: 1234 }).where(eq(reservations.id, q.id));

  const sql = readFileSync(path.resolve(__dirname, "../../drizzle/migrations/0023_channel_handoff.sql"), "utf8");
  const backfill = sql.split("--> statement-breakpoint").map((x) => x.trim()).find((x) => x.includes("UPDATE"))!;
  s.db.$client.exec(backfill);
  expect(await s.reservation(queued)).toMatchObject({ channelPushedAt: 1234 });
  expect(await s.reservation(plain)).toMatchObject({ status: "confirm_failed_refunded", syncState: "failed", channelPushedAt: null });
});
