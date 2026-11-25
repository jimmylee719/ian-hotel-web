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
/** What the channel holds under a code: asked after a push whose answer was lost (timeout). */
export type LookupResult =
  | { found: true; smConfirmation: string; state: "active" | "cancelled" }
  | { found: false }
  | { error: string; retryable: boolean };

/**
 * SiteMinder (SiteConnect) in production; MockChannelManager until certification.
 * Rules (tests/conformance/channel.ts): pushing a code again gives the same smConfirmation; modify and cancel of an
 * unknown code fail, not retryable; a timeout is retryable; timeoutMs ≤ 60000 (below SYNC_LEASE_MS, so a push
 * never outlives its lease); lookup finds what a push left.
 */
export interface ChannelManager {
  pushReservation(r: ChannelReservation): Promise<PushResult>;
  modifyReservation(r: ChannelReservation): Promise<PushResult>;
  cancelReservation(code: string): Promise<CancelResult>;
  lookupReservation(code: string): Promise<LookupResult>;
  /** How long one call may take before it is abandoned (and reported retryable). */
  readonly timeoutMs: number;
}
