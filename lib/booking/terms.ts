import type { CancelPolicy, I18n, reservations } from "@/lib/db/schema";

/**
 * The rate plan terms a booking was made under: its cancellation policy and plan name as they were when the guest
 * booked (or when staff last moved it to another plan). Editing a rate plan never changes them, so every reader of
 * an existing booking's cancellation policy or plan name goes through here, never to `rate_plans`.
 */
export function bookingTerms(res: Pick<typeof reservations.$inferSelect, "cancelPolicy" | "ratePlanName">): { cancelPolicy: CancelPolicy; ratePlanName: I18n } {
  return { cancelPolicy: res.cancelPolicy, ratePlanName: res.ratePlanName };
}
