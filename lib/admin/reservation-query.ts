import type { ISODate } from "@/lib/domain/dates";
import type { ReservationFilter, ResStatus } from "./reservations";

export const RES_STATUSES: readonly ResStatus[] = [
  "pending_payment", "paid_pending_confirm", "confirmed", "confirm_failed_refunded", "cancelled", "expired",
];
export const SYNC_STATES = ["not_required", "pending", "synced", "failed"] as const;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : [v ?? ""]).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
const isDate = (s: string): s is ISODate => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** The reservation list's filters as they live in the URL query string (bookmarkable). Unknown values are dropped. */
export function parseReservationQuery(sp: Params): Omit<ReservationFilter, "pageSize"> {
  const q = one(sp.q).trim().slice(0, 100);
  const status = many(sp.status).filter((s): s is ResStatus => (RES_STATUSES as readonly string[]).includes(s));
  const syncState = many(sp.sync).filter((s) => (SYNC_STATES as readonly string[]).includes(s));
  const from = one(sp.from);
  const to = one(sp.to);
  return {
    ...(q ? { q } : {}),
    ...(status.length ? { status } : {}),
    ...(syncState.length ? { syncState } : {}),
    ...(isDate(from) ? { from } : {}),
    ...(isDate(to) ? { to } : {}),
    dateField: one(sp.field) === "createdAt" ? "createdAt" : "checkIn",
    sort: one(sp.sort) === "checkIn" ? "checkIn" : "-createdAt",
    page: Math.max(1, Math.floor(Number(one(sp.page))) || 1),
  };
}

/** The inverse of parseReservationQuery: a query string that reproduces `f` (defaults left out). */
export function reservationQueryString(f: Omit<ReservationFilter, "pageSize">, page = f.page): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.status?.length) p.set("status", f.status.join(","));
  if (f.syncState?.length) p.set("sync", f.syncState.join(","));
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.dateField === "createdAt") p.set("field", "createdAt");
  if (f.sort === "checkIn") p.set("sort", "checkIn");
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return s ? `?${s}` : "";
}
