import { CHANNEL_MIN_TIMEOUT_MS, type CancelResult, type ChannelManager, type ChannelReservation, type LookupResult, type PushResult } from "./types";

type Held = { reservation: ChannelReservation; smConfirmation: string; state: "active" | "cancelled" };

/**
 * An in-memory channel that keeps the ChannelManager rules (tests/conformance/channel.ts), as SiteMinder states them:
 * a code it already holds is not taken again (the same smConfirmation comes back, the held copy is unchanged), and a
 * cancelled code is never reactivated (a push or modify of it fails, not retryable).
 * - `failNext`: the next N push/modify/cancel calls fail (with `retryable`) without reaching the channel.
 * - `timeoutNext`: the next N push/modify/cancel calls reach the channel and take effect, but the answer is
 *   lost: they report a retryable TIMEOUT. `lookupReservation` then shows what landed.
 * Lookups are never failed by either option.
 */
export class MockChannelManager implements ChannelManager {
  readonly timeoutMs = CHANNEL_MIN_TIMEOUT_MS;
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

  /**
   * Idempotent by code: an active code pushed again keeps its smConfirmation and its held copy (SiteMinder ignores
   * a UniqueID it already has, SITEMINDER-OPEN-Q1); a cancelled one is refused, never made active again.
   */
  async pushReservation(r: ChannelReservation): Promise<PushResult> {
    return this.call((): PushResult => {
      const h = this.held.get(r.code);
      if (h?.state === "cancelled") return { ok: false, retryable: false, error: "RESERVATION_CANCELLED" };
      if (h) return { ok: true, smConfirmation: h.smConfirmation };
      const smConfirmation = `SM-${++this.seq}-${r.code}`;
      this.held.set(r.code, { reservation: r, smConfirmation, state: "active" });
      return { ok: true, smConfirmation };
    });
  }

  /** The channel's copy is replaced; only an active, known code. Not routed through pushReservation, so spies can tell them apart. */
  async modifyReservation(r: ChannelReservation, smConfirmation: string): Promise<PushResult> {
    return this.call((): PushResult => {
      const h = this.held.get(r.code);
      const bad = this.refuse(h, smConfirmation);
      if (bad) return bad;
      if (h!.state === "cancelled") return { ok: false, retryable: false, error: "RESERVATION_CANCELLED" };
      h!.reservation = r;
      return { ok: true, smConfirmation };
    });
  }

  /** Idempotent: cancelling a cancelled reservation succeeds; an unknown code or another smConfirmation does not. */
  async cancelReservation(r: ChannelReservation, smConfirmation: string): Promise<CancelResult> {
    return this.call((): CancelResult => {
      const h = this.held.get(r.code);
      const bad = this.refuse(h, smConfirmation);
      if (bad) return bad;
      h!.state = "cancelled";
      h!.reservation = r;
      return { ok: true, retryable: false };
    });
  }

  /** Why a modify or cancel of `h` under `smConfirmation` is refused, or null. */
  private refuse(h: Held | undefined, smConfirmation: string): { ok: false; retryable: false; error: string } | null {
    if (!h) return { ok: false, retryable: false, error: "UNKNOWN_RESERVATION" };
    if (h.smConfirmation !== smConfirmation) return { ok: false, retryable: false, error: "SM_CONFIRMATION_MISMATCH" };
    return null;
  }

  /** Every reservation the channel holds, cancelled ones included. */
  get records(): { code: string; smConfirmation: string; state: "active" | "cancelled" }[] {
    return [...this.held.entries()].map(([code, h]) => ({ code, smConfirmation: h.smConfirmation, state: h.state }));
  }

  async lookupReservation(code: string): Promise<LookupResult> {
    const h = this.held.get(code);
    return h ? { found: true, smConfirmation: h.smConfirmation, state: h.state } : { found: false };
  }
}
