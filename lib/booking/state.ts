import { and, eq, type SQL } from "drizzle-orm";
import { reservations } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

export type Reservation = typeof reservations.$inferSelect;
export type ResStatus = Reservation["status"];

const ALLOWED: Record<ResStatus, readonly ResStatus[]> = {
  pending_payment: ["paid_pending_confirm", "expired"],
  // Paid after the hold lapsed: confirm if inventory can be re-held, otherwise refund.
  expired: ["paid_pending_confirm", "confirm_failed_refunded"],
  paid_pending_confirm: ["confirmed", "confirm_failed_refunded"],
  confirmed: ["cancelled"],
  confirm_failed_refunded: [],
  cancelled: [],
};

/** Columns to set alongside the status change: values, or SQL expressions over the row. */
export type ReservationPatch = { [K in keyof Reservation]?: Reservation[K] | SQL };

export function canTransition(from: ResStatus, to: ResStatus): boolean {
  return ALLOWED[from].includes(to);
}

/**
 * Move a reservation from `from` to `to` with an optimistic lock (`WHERE status = from`).
 * Returns false if the transition is not allowed or the status was already changed by someone else.
 * `patch` values may be SQL expressions over the row (read as it was before this UPDATE).
 * `guard` adds an extra condition to the same UPDATE (e.g. "not claimed by a refund").
 */
export async function transition(
  db: Db, reservationId: string, from: ResStatus, to: ResStatus, patch: ReservationPatch, now: Date, guard?: SQL,
): Promise<boolean> {
  if (!canTransition(from, to)) return false;
  const rows = await db.update(reservations)
    .set({ ...patch, id: undefined, status: to, updatedAt: now.getTime() }) // undefined = column left unchanged
    .where(and(eq(reservations.id, reservationId), eq(reservations.status, from), guard))
    .returning({ id: reservations.id });
  return rows.length === 1;
}
