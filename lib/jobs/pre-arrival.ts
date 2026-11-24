import { and, eq } from "drizzle-orm";
import { notifyGuest, type Deps } from "@/lib/booking/notify";
import { reservations } from "@/lib/db/schema";
import { addDaysISO, todayInTaipei } from "@/lib/domain/dates";

/** Guests are emailed this many days (Taipei calendar) before check-in. */
export const PRE_ARRIVAL_DAYS = 3;

/**
 * Send the pre-arrival email (directions, check-in time, contact details) for every confirmed booking
 * checking in on Taipei today + 3, in the guest's language. `sendOnce` records each send, so running
 * every 5 minutes all day still sends once. `sent` counts emails actually delivered by this run.
 */
export async function runPreArrival(deps: Deps, now: Date): Promise<{ sent: number }> {
  const checkIn = addDaysISO(todayInTaipei(now), PRE_ARRIVAL_DAYS);
  const due = await deps.db.select({ id: reservations.id }).from(reservations)
    .where(and(eq(reservations.status, "confirmed"), eq(reservations.checkIn, checkIn)));
  let sent = 0;
  for (const { id } of due) {
    if (await notifyGuest(deps, id, "pre_arrival", now) === "sent") sent++;
  }
  return { sent };
}
