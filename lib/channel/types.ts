import type { ISODate } from "@/lib/domain/dates";

/** One day of availability/rates/restrictions as SiteMinder sends it. Omitted fields are unchanged. */
export type AriUpdate = {
  smRoomCode: string;
  smRatePlanCode: string;
  date: ISODate;
  available?: number;
  price?: number;
  minStay?: number;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
};

export type ChannelReservation = {
  code: string;
  smPropertyCode: string;
  checkIn: ISODate;
  checkOut: ISODate;
  rooms: { smRoomCode: string; smRatePlanCode: string; nightlyPrices: number[] }[];
  guest: { firstName: string; lastName: string; email: string; phone: string };
  total: number;
  paidAmount: number;
  addons: { name: string; amount: number }[];
  promoCode?: string;
};

export type PushResult = { ok: true; smConfirmation: string } | { ok: false; retryable: boolean; error: string };
export type CancelResult = { ok: boolean; retryable: boolean; error?: string };
/** What the channel holds under a code. Only channels that can be asked offer it (SiteMinder cannot: doc §8.3). */
export type LookupResult =
  | { found: true; smConfirmation: string; state: "active" | "cancelled" }
  | { found: false }
  | { error: string; retryable: boolean };

/** The allowed range of one channel call's timeout: SiteMinder asks for 60–120 s (doc §8.12, [ERR-G]). */
export const CHANNEL_MIN_TIMEOUT_MS = 60_000;
export const CHANNEL_MAX_TIMEOUT_MS = 120_000;

/**
 * SiteMinder (SiteConnect) in production; MockChannelManager until certification.
 * Rules (tests/conformance/channel.ts): pushing an accepted code again gives the same smConfirmation (how a push
 * whose answer was lost is recovered: SITEMINDER-OPEN-Q1); modify and cancel carry that smConfirmation, and fail
 * (not retryable) for an unknown code or a smConfirmation that does not match it; a cancelled code never becomes
 * active again; a timeout is retryable; CHANNEL_MIN_TIMEOUT_MS ≤ timeoutMs ≤ CHANNEL_MAX_TIMEOUT_MS (one call per
 * property lease, and SYNC_LEASE_MS is set above the maximum, so a call ends before another worker may take the
 * lease); lookup, where offered, finds what a push left.
 * The caller (lib/booking/channel-sync.ts) keeps the ordering rules: one call in flight per property, a modify or
 * cancel only after the push succeeded, nothing after a cancel succeeded, nothing at all for a never-pushed booking.
 */
export interface ChannelManager {
  pushReservation(r: ChannelReservation): Promise<PushResult>;
  /** Replace the channel's copy of `r.code`; `smConfirmation` is the one its push returned. */
  modifyReservation(r: ChannelReservation, smConfirmation: string): Promise<PushResult>;
  /** Cancel `code`; `smConfirmation` is the one its push returned. */
  cancelReservation(code: string, smConfirmation: string): Promise<CancelResult>;
  /** Optional: SiteMinder has no lookup (doc §8.3). The mock offers one, for the channel reconcile job. */
  lookupReservation?(code: string): Promise<LookupResult>;
  /** How long one call may take before it is abandoned (and reported retryable). */
  readonly timeoutMs: number;
  /** True only for the stand-in used while no channel is configured: the sync sends nothing and waits. */
  readonly disabled?: boolean;
}
