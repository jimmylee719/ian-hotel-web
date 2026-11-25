import type { CancelResult, ChannelManager, ChannelReservation, PushResult } from "./types";

export class MockChannelManager implements ChannelManager {
  pushed: ChannelReservation[] = [];
  private failNext: number;
  private retryable: boolean;
  private seq = 0;

  constructor(opts: { failNext?: number; retryable?: boolean } = {}) {
    this.failNext = opts.failNext ?? 0;
    this.retryable = opts.retryable ?? true;
  }

  private fail(): { ok: false; retryable: boolean; error: string } | null {
    if (this.failNext <= 0) return null;
    this.failNext--;
    return { ok: false, retryable: this.retryable, error: "MOCK_FAILURE" };
  }

  async pushReservation(r: ChannelReservation): Promise<PushResult> {
    return this.upsert(r);
  }

  /** Like a push: the channel's copy is replaced. Not routed through pushReservation, so spies can tell them apart. */
  async modifyReservation(r: ChannelReservation): Promise<PushResult> {
    return this.upsert(r);
  }

  private upsert(r: ChannelReservation): PushResult {
    const f = this.fail();
    if (f) return f;
    this.pushed = [...this.pushed.filter((p) => p.code !== r.code), r];
    return { ok: true, smConfirmation: `SM-${++this.seq}-${r.code}` };
  }

  async cancelReservation(code: string): Promise<CancelResult> {
    const f = this.fail();
    if (f) return f;
    this.pushed = this.pushed.filter((p) => p.code !== code);
    return { ok: true, retryable: false };
  }
}
