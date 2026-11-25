import type { CancelResult, ChannelManager, ChannelReservation, LookupResult, PushResult } from "./types";

type Held = { reservation: ChannelReservation; smConfirmation: string; state: "active" | "cancelled" };

/**
 * An in-memory channel that keeps the ChannelManager rules (tests/conformance/channel.ts).
 * - `failNext`: the next N push/modify/cancel calls fail (with `retryable`) without reaching the channel.
 * - `timeoutNext`: the next N push/modify/cancel calls reach the channel and take effect, but the answer is
 *   lost: they report a retryable TIMEOUT. `lookupReservation` then shows what landed.
 * Lookups are never failed by either option.
 */
export class MockChannelManager implements ChannelManager {
  readonly timeoutMs = 30_000;
  private held = new Map<string, Held>();
  private failNext: number;
  private timeoutNext: number;
  private retryable: boolean;
  private seq = 0;

  constructor(opts: { failNext?: number; retryable?: boolean; timeoutNext?: number } = {}) {
    this.failNext = opts.failNext ?? 0;
    this.retryable = opts.retryable ?? true;
    this.timeoutNext = opts.timeoutNext ?? 0;
  }

  /** The reservations active at the channel (cancelled ones are gone). */
  get pushed(): ChannelReservation[] {
    return [...this.held.values()].filter((h) => h.state === "active").map((h) => h.reservation);
  }

  /** Run `apply` as one channel call, subject to failNext (not applied) and timeoutNext (applied, answer lost). */
  private call<T extends PushResult | CancelResult>(apply: () => T): T | { ok: false; retryable: boolean; error: string } {
    if (this.failNext > 0) {
      this.failNext--;
      return { ok: false, retryable: this.retryable, error: "MOCK_FAILURE" };
    }
    const r = apply();
    if (this.timeoutNext > 0) {
      this.timeoutNext--;
      return { ok: false, retryable: true, error: "TIMEOUT" };
    }
    return r;
  }

  /** Idempotent by code: a code pushed again keeps its smConfirmation (and is active again). */
  async pushReservation(r: ChannelReservation): Promise<PushResult> {
    return this.call(() => {
      const smConfirmation = this.held.get(r.code)?.smConfirmation ?? `SM-${++this.seq}-${r.code}`;
      this.held.delete(r.code); // re-inserted last, as the newest
      this.held.set(r.code, { reservation: r, smConfirmation, state: "active" });
      return { ok: true, smConfirmation };
    });
  }

  /** The channel's copy is replaced; only an active, known code. Not routed through pushReservation, so spies can tell them apart. */
  async modifyReservation(r: ChannelReservation): Promise<PushResult> {
    return this.call((): PushResult => {
      const h = this.held.get(r.code);
      if (!h) return { ok: false, retryable: false, error: "UNKNOWN_RESERVATION" };
      if (h.state === "cancelled") return { ok: false, retryable: false, error: "RESERVATION_CANCELLED" };
      h.reservation = r;
      return { ok: true, smConfirmation: h.smConfirmation };
    });
  }

  /** Idempotent: cancelling a cancelled reservation succeeds; an unknown code does not. */
  async cancelReservation(code: string): Promise<CancelResult> {
    return this.call((): CancelResult => {
      const h = this.held.get(code);
      if (!h) return { ok: false, retryable: false, error: "UNKNOWN_RESERVATION" };
      h.state = "cancelled";
      return { ok: true, retryable: false };
    });
  }

  async lookupReservation(code: string): Promise<LookupResult> {
    const h = this.held.get(code);
    return h ? { found: true, smConfirmation: h.smConfirmation, state: h.state } : { found: false };
  }
}
