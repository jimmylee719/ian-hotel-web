import { and, eq, inArray } from "drizzle-orm";
import { syncWithChannel, type SyncOutcome } from "@/lib/booking/channel-sync";
import type { Deps } from "@/lib/booking/notify";
import type { Reservation } from "@/lib/booking/state";
import { reservations } from "@/lib/db/schema";
import { recordAudit } from "./audit";
import type { StaffContext } from "./auth";
import { can } from "./permissions";

/**
 * A direct booking whose channel copy is not up to date: confirmed or cancelled here, its hand-off still pending
 * (queued or retrying) or stopped (failed). The admin reservation page shows 「尚未同步到 SiteMinder」 for it.
 */
export function unsyncedWithChannel(r: { channel: string; status: string; syncState: string }): boolean {
  return r.channel === "direct" && (r.status === "confirmed" || r.status === "cancelled")
    && (r.syncState === "pending" || r.syncState === "failed");
}

export type RetryChannelSyncResult =
  | { ok: true; syncState: Reservation["syncState"]; outcome: SyncOutcome }
  | { ok: false; error: "FORBIDDEN" | "NOT_FOUND" | "NOT_UNSYNCED" };

/**
 * Staff's manual retry of a booking's channel hand-off (needs `reservations.modify` at its property; another
 * property's booking is NOT_FOUND). Only an unsynced one (unsyncedWithChannel) — never a synced one, so nothing is
 * ever sent after a cancel went through. Makes it due now with a fresh failure count (a stopped one starts again),
 * audits it, and runs it at once; the result is the booking's syncState afterwards (synced, or still pending/failed
 * with its new lastSyncError; pending also when another call held the property — the retry job then sends it).
 */
export async function retryChannelSync(
  deps: Deps, ctx: StaffContext, reservationId: string, now: Date,
): Promise<RetryChannelSyncResult> {
  const { db } = deps;
  if (!can(ctx.staff, "reservations.modify")) return { ok: false, error: "FORBIDDEN" };
  const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  if (!res || !can(ctx.staff, "reservations.modify", res.propertyId)) return { ok: false, error: "NOT_FOUND" };
  if (!unsyncedWithChannel(res)) return { ok: false, error: "NOT_UNSYNCED" };

  const [armed] = await db.update(reservations)
    .set({ syncState: "pending", syncAttempts: 0, nextSyncAt: now.getTime() })
    .where(and(eq(reservations.id, res.id), eq(reservations.status, res.status), inArray(reservations.syncState, ["pending", "failed"])))
    .returning({ id: reservations.id });
  if (!armed) return { ok: false, error: "NOT_UNSYNCED" };
  await recordAudit(db, ctx, {
    action: "reservation.channel_retry", entity: "reservation", entityId: res.id,
    before: { syncState: res.syncState, syncAttempts: res.syncAttempts, lastSyncError: res.lastSyncError }, after: { syncState: "pending" },
  }, now);
  const outcome = await syncWithChannel(deps, res.id, now);
  const [after] = await db.select({ syncState: reservations.syncState }).from(reservations).where(eq(reservations.id, res.id));
  return { ok: true, syncState: after.syncState, outcome };
}
