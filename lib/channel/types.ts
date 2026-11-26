import type { ISODate } from "@/lib/domain/dates";

/**
 * One day of availability/rates/restrictions as SiteMinder sends it (lib/db/ari-sync.ts). Omitted fields are
 * unchanged. Availability is per room type and needs no rate plan (doc §4.1); price and restrictions need one.
 */
export type AriUpdate = {
  smRoomCode: string;
  smRatePlanCode?: string;
  date: ISODate;
  available?: number;
  price?: number;
  minStay?: number;
  /** null clears the limit (SetMaxLOS / SetForwardMaxStay without Time). */
  maxStay?: number | null;
  minStayThrough?: number | null;
  maxStayThrough?: number | null;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
};

/**
 * A booking as the channel receives it (SiteMinder: OTA_HotelResNotifRQ, docs/integrations/siteminder.md §3.3, §8.8).
 * Everything comes from our own booking data (lib/booking/to-channel.ts). Amounts are whole units of `currency`.
 */
export type ChannelReservation = {
  code: string;
  smPropertyCode: string;
  checkIn: ISODate;
  checkOut: ISODate;
  /**
   * One per booked room. `nightlyPrices` are the prices as booked, before `discount`; the names are the zh-TW
   * (front desk / PMS language) room type and rate plan names, as Rooms and Rates lists them.
   */
  rooms: { smRoomCode: string; smRatePlanCode: string; nightlyPrices: number[]; roomName: string; ratePlanName: string }[];
  /** The guest who booked: both the booker (Customer) and the primary guest. We hold no other person. */
  guest: { firstName: string; lastName: string; email: string; phone: string };
  /** Guests of the whole booking (adults ≥ 1). The booking holds no children's ages. */
  adults: number;
  children: number;
  /** ISO 4217 (properties.currency). */
  currency: string;
  /** Epoch ms the booking was made (CreateDateTime). */
  createdAt: number;
  /** Epoch ms of the booking's latest change: its cancellation for a cancelled one (LastModifyDateTime). */
  lastModifiedAt: number;
  /** What the guest pays in all: rooms − discount + add-ons. */
  total: number;
  paidAmount: number;
  /** Promo discount taken off the rooms (0 = none); `total` already reflects it. */
  discount: number;
  /** `code`: our stable code for the add-on (from its slug); `name` in the PMS language. */
  addons: { code: string; name: string; amount: number }[];
  promoCode?: string;
  /** The guest's own requests, if any. (Our booking form collects none today; staff notes are never sent.) */
  specialRequests?: string;
};

/**
 * Why a channel call failed, as the adapter saw it (structured, so callers never parse `error` text):
 * - "ota": the channel answered with OTA Errors (`type` / `code` as sent; `code` may be absent);
 * - "soap_fault": a SOAP Fault (`code` is not set: faults carry text codes);
 * - "http": a non-2xx HTTP status without an OTA answer (`httpStatus`);
 * - "timeout" / "network": no answer at all; "bad_response": an answer we could not read;
 * - "config": not sent, our own configuration or data is incomplete;
 * - "confirmation_mismatch": sent and applied, but the channel answered for another reservation id.
 * `echoToken` is the request's, for tracing it with the channel.
 */
export type ChannelErrorDetail = {
  kind: "ota" | "soap_fault" | "http" | "timeout" | "network" | "bad_response" | "config" | "confirmation_mismatch";
  httpStatus?: number;
  /** The channel's Retry-After, in ms (HTTP 408 / 425 / 429 / 5xx): the next attempt waits this long instead of the backoff. */
  retryAfterMs?: number;
  type?: number;
  code?: number;
  echoToken?: string;
};

export type ChannelFailure = { ok: false; retryable: boolean; error: string; detail?: ChannelErrorDetail };
export type PushResult = { ok: true; smConfirmation: string } | ChannelFailure;
export type CancelResult = { ok: true; retryable: false } | ChannelFailure;
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
  /**
   * Cancel `r.code`; `smConfirmation` is the one its push returned. The whole booking is sent: SiteMinder
   * overwrites its copy with every Modify and Cancel (doc §3.1).
   */
  cancelReservation(r: ChannelReservation, smConfirmation: string): Promise<CancelResult>;
  /** Optional: SiteMinder has no lookup (doc §8.3). The mock offers one, for the channel reconcile job. */
  lookupReservation?(code: string): Promise<LookupResult>;
  /** How long one call may take before it is abandoned (and reported retryable). */
  readonly timeoutMs: number;
  /** True only for the stand-in used while no channel is configured: the sync sends nothing and waits. */
  readonly disabled?: boolean;
}
