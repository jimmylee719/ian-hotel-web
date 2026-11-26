import { describe, expect, test } from "vitest";
import {
  CHANNEL_MAX_TIMEOUT_MS, CHANNEL_MIN_TIMEOUT_MS, type ChannelManager, type ChannelReservation,
} from "@/lib/channel/types";

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
    // SITEMINDER-OPEN-Q1: re-sending an accepted UniqueID is how we recover after a timeout (there is no lookup).
    test("1. pushing an accepted code again gives the same smConfirmation", async () => {
      const cm = make();
      const { r, smConfirmation } = await pushed(cm);
      expect(await cm.pushReservation(r)).toEqual({ ok: true, smConfirmation });
    });

    test("2. modify and cancel carrying a known code's smConfirmation keep it", async () => {
      const cm = make();
      const { r, smConfirmation } = await pushed(cm);
      expect(await cm.modifyReservation({ ...r, total: r.total + 100 }, smConfirmation)).toEqual({ ok: true, smConfirmation });
      expect(await cm.cancelReservation(r.code, smConfirmation)).toMatchObject({ ok: true });
    });

    test("2. modify and cancel of an unknown code fail, not retryable", async () => {
      const cm = make();
      const r = reservation(freshCode());
      expect(await cm.modifyReservation(r, "SM-UNKNOWN")).toMatchObject({ ok: false, retryable: false });
      expect(await cm.cancelReservation(r.code, "SM-UNKNOWN")).toMatchObject({ ok: false, retryable: false });
    });

    test("2. modify and cancel with another smConfirmation fail, not retryable", async () => {
      const cm = make();
      const { r, smConfirmation } = await pushed(cm);
      const wrong = `${smConfirmation}-X`;
      expect(await cm.modifyReservation({ ...r, total: r.total + 100 }, wrong)).toMatchObject({ ok: false, retryable: false });
      expect(await cm.cancelReservation(r.code, wrong)).toMatchObject({ ok: false, retryable: false });
      if (cm.lookupReservation) expect(await cm.lookupReservation(r.code)).toEqual({ found: true, smConfirmation, state: "active" });
    });

    test("3. a timeout is reported as retryable", async () => {
      const timingOut = opts.fixtures?.timingOut;
      if (!timingOut) expect.fail("fixtures.timingOut is required to check rule 3");
      expect(await timingOut().pushReservation(reservation(freshCode()))).toMatchObject({ ok: false, retryable: true });
    });

    test("4. timeoutMs is within the channel's allowed range (60–120 s)", () => {
      const { timeoutMs } = make();
      expect(Number.isFinite(timeoutMs)).toBe(true);
      expect(timeoutMs).toBeGreaterThanOrEqual(CHANNEL_MIN_TIMEOUT_MS);
      expect(timeoutMs).toBeLessThanOrEqual(CHANNEL_MAX_TIMEOUT_MS);
    });

    // SITEMINDER-OPEN-Q1 / Q10: a cancelled UniqueID is never used again. Our sync never sends after a cancel; the
    // channel must not bring the code back either (a push or modify of it fails, not retryable, or is ignored).
    test("6. a cancelled code never becomes active again", async () => {
      const cm = make();
      const { r, smConfirmation } = await pushed(cm);
      expect(await cm.cancelReservation(r.code, smConfirmation)).toMatchObject({ ok: true });
      const again = await cm.pushReservation(r);
      if (!again.ok) expect(again.retryable).toBe(false);
      else expect(again.smConfirmation).toBe(smConfirmation);
      expect(await cm.modifyReservation({ ...r, total: r.total + 100 }, smConfirmation)).toMatchObject({ ok: false, retryable: false });
      if (cm.lookupReservation)
        expect([{ found: false }, { found: true, smConfirmation, state: "cancelled" }]).toContainEqual(await cm.lookupReservation(r.code));
    });

    // Lookup is optional (SiteMinder has none, doc §8.3). A channel that offers it must keep these.
    test("5. lookupReservation, if offered, finds a pushed reservation, active, with its smConfirmation", async (ctx) => {
      const cm = make();
      if (!cm.lookupReservation) return ctx.skip();
      const { r, smConfirmation } = await pushed(cm);
      expect(await cm.lookupReservation(r.code)).toEqual({ found: true, smConfirmation, state: "active" });
    });

    test("5. lookupReservation, if offered, does not find an unknown code, nor a cancelled one as active", async (ctx) => {
      const cm = make();
      if (!cm.lookupReservation) return ctx.skip();
      expect(await cm.lookupReservation(freshCode())).toEqual({ found: false });
      const { r, smConfirmation } = await pushed(cm);
      expect(await cm.cancelReservation(r.code, smConfirmation)).toMatchObject({ ok: true });
      expect([{ found: false }, { found: true, smConfirmation, state: "cancelled" }]).toContainEqual(await cm.lookupReservation(r.code));
    });
  });
}
