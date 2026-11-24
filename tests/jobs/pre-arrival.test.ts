import { expect, test } from "vitest";
import { handlePaymentNotice } from "@/lib/booking/payment-notice";
import { runPreArrival } from "@/lib/jobs/pre-arrival";
import { bookingSetup, NOW } from "@/tests/helpers/booking";

async function confirmed(over: Parameters<Awaited<ReturnType<typeof bookingSetup>>["book"]>[0] = {}) {
  const s = await bookingSetup();
  const code = await s.book(over);
  await handlePaymentNotice(s.deps, await s.notice(code), NOW);
  s.email.sent.length = 0;
  return { ...s, code };
}

const at = (iso: string) => new Date(iso);

test("sends on Taipei today + 3, in the guest's language, with directions, check-in time and contact details", async () => {
  const { deps, email } = await confirmed({ locale: "ja" });
  expect(await runPreArrival(deps, at("2026-11-28T02:00:00Z"))).toEqual({ sent: 1 });
  expect(email.sent).toHaveLength(1);
  const m = email.sent[0];
  expect(m.to).toBe("mei@example.com");
  expect(m.subject).toContain("ご到着のご案内");
  expect(m.text).toContain("15:00"); // check-in time
  expect(m.text).toContain("南京三民"); // how to get there
  expect(m.text).toMatch(/\+?\d[\d\- ]{6,}/); // hotel phone
  expect(m.text).toContain("https://hotel.test/ja/manage/");
});

test("uses the Taipei calendar day, not UTC", async () => {
  const { deps, email } = await confirmed();
  // 2026-11-27 15:59 UTC is still 11-27 in Taipei (check-in would be 11-30)
  expect(await runPreArrival(deps, at("2026-11-27T15:59:00Z"))).toEqual({ sent: 0 });
  // 16:00 UTC is 2026-11-28 00:00 in Taipei: check-in is exactly 3 days away
  expect(await runPreArrival(deps, at("2026-11-27T16:00:00Z"))).toEqual({ sent: 1 });
  expect(await runPreArrival(deps, at("2026-11-28T15:59:00Z"))).toEqual({ sent: 0 }); // same Taipei day, already sent
  expect(await runPreArrival(deps, at("2026-11-28T16:00:00Z"))).toEqual({ sent: 0 }); // next day: 2 days away
  expect(email.sent).toHaveLength(1);
});

test("only confirmed bookings get the email", async () => {
  const { deps, email, db, code } = await confirmed();
  const { reservations } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  await db.update(reservations).set({ status: "cancelled" }).where(eq(reservations.code, code));
  expect(await runPreArrival(deps, at("2026-11-28T02:00:00Z"))).toEqual({ sent: 0 });
  expect(email.sent).toHaveLength(0);
});

test("a failed send is not counted and not retried", async () => {
  const { deps, email } = await confirmed();
  email.failNext = 1;
  expect(await runPreArrival(deps, at("2026-11-28T02:00:00Z"))).toEqual({ sent: 0 });
  expect(await runPreArrival(deps, at("2026-11-28T02:05:00Z"))).toEqual({ sent: 0 });
  expect(email.sent).toHaveLength(0);
});
