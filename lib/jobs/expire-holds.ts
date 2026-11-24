import { and, eq, lt } from "drizzle-orm";
import { holdItemsFor } from "@/lib/booking/confirm";
import type { Deps } from "@/lib/booking/notify";
import { transition } from "@/lib/booking/state";
import { releaseInventory } from "@/lib/db/inventory-hold";
import { reservations } from "@/lib/db/schema";

/** Expire unpaid reservations whose hold has lapsed and give their rooms back. */
export async function runExpireHolds(deps: Pick<Deps, "db">, now: Date): Promise<{ expired: number }> {
  const { db } = deps;
  const lapsed = await db.select().from(reservations)
    .where(and(eq(reservations.status, "pending_payment"), lt(reservations.holdExpiresAt, now.getTime())));
  let expired = 0;
  for (const res of lapsed) {
    // A payment notice may have claimed it meanwhile; then the transition fails and nothing is released.
    if (!await transition(db, res.id, "pending_payment", "expired", { holdExpiresAt: null }, now)) continue;
    await releaseInventory(db, await holdItemsFor(db, res));
    expired++;
  }
  return { expired };
}
