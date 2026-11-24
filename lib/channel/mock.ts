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
    const f = this.fail();
    if (f) return f;
    this.pushed = [...this.pushed.filter((p) => p.code !== r.code), r];
    return { ok: true, smConfirmation: `SM-${++this.seq}-${r.code}` };
  }

  async modifyReservation(r: ChannelReservation): Promise<PushResult> {
    return this.pushReservation(r);
  }

  async cancelReservation(code: string): Promise<CancelResult> {
    const f = this.fail();
    if (f) return f;
    this.pushed = this.pushed.filter((p) => p.code !== code);
    return { ok: true, retryable: false };
  }
}
