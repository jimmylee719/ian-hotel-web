import { describe, expect, test } from "vitest";
import type { ChannelManager, ChannelReservation } from "@/lib/channel/types";

/**
 * The rules every ChannelManager must keep, shared by the mock and the real SiteMinder adapter.
 * Not a test file itself: a `*.test.ts` calls it with the adapter under test.
 */
export type ChannelConformanceOptions = {
  fixtures?: {
    /** A reservation the channel accepts, under the given (fresh) code. Default: one room, two nights. */
    reservation?: (code: string) => ChannelReservation;
    /** A manager whose next push times out (rule 3). Required: without it rule 3 fails rather than being skipped. */
    timingOut?: () => ChannelManager;
  };
};

let seq = 0;
/** A code no earlier run used, so a real sandbox never sees the same one twice. */
const freshCode = () => `NK-C${Date.now().toString(36).toUpperCase()}${(++seq).toString(36).toUpperCase()}`;

const defaultReservation = (code: string): ChannelReservation => ({
  code, smPropertyCode: "NK", checkIn: "2026-12-01", checkOut: "2026-12-03",
  rooms: [{ smRoomCode: "MIX", smRatePlanCode: "DIRECT", nightlyPrices: [2000, 2400] }],
  guest: { firstName: "Mei", lastName: "Lin", email: "mei@example.com", phone: "+886900000000" },
  total: 4400, paidAmount: 4400, addons: [],
});

export function channelConformance(make: () => ChannelManager, opts: ChannelConformanceOptions = {}): void {
  const reservation = opts.fixtures?.reservation ?? defaultReservation;

  async function pushed(cm: ChannelManager) {
    const r = reservation(freshCode());
    const p = await cm.pushReservation(r);
    if (!p.ok) throw new Error(`push failed: ${p.error}`);
    return { r, smConfirmation: p.smConfirmation };
  }

  describe("ChannelManager conformance", () => {
    test("1. pushing the same code twice gives the same smConfirmation", async () => {
      const cm = make();
      const { r, smConfirmation } = await pushed(cm);
      expect(await cm.pushReservation(r)).toEqual({ ok: true, smConfirmation });
    });

    test("2. modify and cancel of a known code keep its smConfirmation", async () => {
      const cm = make();
      const { r, smConfirmation } = await pushed(cm);
      expect(await cm.modifyReservation({ ...r, total: r.total + 100 })).toEqual({ ok: true, smConfirmation });
      expect(await cm.cancelReservation(r.code)).toMatchObject({ ok: true });
    });

    test("2. modify and cancel of an unknown code fail, not retryable", async () => {
      const cm = make();
      const r = reservation(freshCode());
      expect(await cm.modifyReservation(r)).toMatchObject({ ok: false, retryable: false });
      expect(await cm.cancelReservation(r.code)).toMatchObject({ ok: false, retryable: false });
    });

    test("3. a timeout is reported as retryable", async () => {
      const timingOut = opts.fixtures?.timingOut;
      if (!timingOut) expect.fail("fixtures.timingOut is required to check rule 3");
      expect(await timingOut().pushReservation(reservation(freshCode()))).toMatchObject({ ok: false, retryable: true });
    });

    test("4. timeoutMs is set and at most 60000", () => {
      const { timeoutMs } = make();
      expect(Number.isFinite(timeoutMs)).toBe(true);
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(60_000);
    });

    test("5. lookupReservation finds a pushed reservation, active, with its smConfirmation", async () => {
      const cm = make();
      const { r, smConfirmation } = await pushed(cm);
      expect(await cm.lookupReservation(r.code)).toEqual({ found: true, smConfirmation, state: "active" });
    });

    test("5. lookupReservation does not find an unknown code, nor a cancelled one as active", async () => {
      const cm = make();
      expect(await cm.lookupReservation(freshCode())).toEqual({ found: false });
      const { r, smConfirmation } = await pushed(cm);
      expect(await cm.cancelReservation(r.code)).toMatchObject({ ok: true });
      expect([{ found: false }, { found: true, smConfirmation, state: "cancelled" }]).toContainEqual(await cm.lookupReservation(r.code));
    });
  });
}
