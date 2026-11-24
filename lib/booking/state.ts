import { and, eq } from "drizzle-orm";
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

export function canTransition(from: ResStatus, to: ResStatus): boolean {
  return ALLOWED[from].includes(to);
}

/**
 * Move a reservation from `from` to `to` with an optimistic lock (`WHERE status = from`).
 * Returns false if the transition is not allowed or the status was already changed by someone else.
 */
export async function transition(
  db: Db, reservationId: string, from: ResStatus, to: ResStatus, patch: Partial<Reservation>, now: Date,
): Promise<boolean> {
  if (!canTransition(from, to)) return false;
  const rows = await db.update(reservations)
    .set({ ...patch, id: undefined, status: to, updatedAt: now.getTime() }) // undefined = column left unchanged
    .where(and(eq(reservations.id, reservationId), eq(reservations.status, from)))
    .returning({ id: reservations.id });
  return rows.length === 1;
}
