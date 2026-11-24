import { and, eq, lt } from "drizzle-orm";
import { holdItemsFor } from "@/lib/booking/confirm";
import { paidAmount, type Deps } from "@/lib/booking/notify";
import { transition } from "@/lib/booking/state";
import { releaseInventory } from "@/lib/db/inventory-hold";
import { reservations } from "@/lib/db/schema";

/**
 * Expire unpaid reservations whose hold has lapsed and give their rooms back.
 * A lapsed reservation that already holds money (its notice handler died after recording the charge)
 * is not expired: it moves to paid_pending_confirm, rooms still held, for the retry job to finish.
 */
export async function runExpireHolds(deps: Pick<Deps, "db">, now: Date): Promise<{ expired: number }> {
  const { db } = deps;
  const lapsed = await db.select().from(reservations)
    .where(and(eq(reservations.status, "pending_payment"), lt(reservations.holdExpiresAt, now.getTime())));
  let expired = 0;
  for (const res of lapsed) {
    if (await paidAmount(db, res.id) > 0) {
      await transition(db, res.id, "pending_payment", "paid_pending_confirm",
        { syncState: "pending", nextSyncAt: now.getTime(), lastSyncError: null }, now);
      continue;
    }
    // A payment notice may have claimed it meanwhile; then the transition fails and nothing is released.
    if (!await transition(db, res.id, "pending_payment", "expired", { holdExpiresAt: null }, now)) continue;
    await releaseInventory(db, await holdItemsFor(db, res));
    expired++;
  }
  return { expired };
}
