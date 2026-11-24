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

/** SiteMinder (SiteConnect) in production; MockChannelManager until certification. */
export interface ChannelManager {
  pushReservation(r: ChannelReservation): Promise<PushResult>;
  modifyReservation(r: ChannelReservation): Promise<PushResult>;
  cancelReservation(code: string): Promise<CancelResult>;
}
