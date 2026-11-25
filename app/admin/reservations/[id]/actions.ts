"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/admin/auth";
import { addReservationNote, NoteError } from "@/lib/admin/reservations";
import { getDb } from "@/lib/db/client";

/** Append an internal note. A bad note comes back to the page as `?noteError=<code>`. */
export async function addNoteAction(reservationId: string, formData: FormData): Promise<void> {
  const ctx = await requireStaff("reservations.view");
  let error: string | null = null;
  try {
    await addReservationNote(await getDb(), ctx, reservationId, String(formData.get("body") ?? ""), new Date());
  } catch (e) {
    if (!(e instanceof NoteError)) throw e;
    error = e.code;
  }
  const path = `/admin/reservations/${encodeURIComponent(reservationId)}`;
  if (error) redirect(`${path}?noteError=${error}`);
  revalidatePath(path);
  redirect(path);
}
