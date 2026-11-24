import { z } from "zod";
import { getProperty } from "@/lib/content-repo";
import { LOCALES } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { nightsBetween } from "@/lib/booking-search";
import { todayInTaipei } from "@/lib/domain/dates";
import type { EmailSender } from "@/lib/email/types";

/** Group / long-stay inquiry from /groups, emailed to the front desk. Nothing is stored. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const inquirySchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(200),
  phone: z.string().trim().max(40).default(""),
  groupSize: z.coerce.number().int().min(1).max(200),
  checkIn: isoDate,
  checkOut: isoDate,
  message: z.string().trim().max(4000).default(""),
  locale: z.enum(LOCALES),
  honeypot: z.string().default(""),
});

export type InquiryInput = z.input<typeof inquirySchema>;
export type InquiryResult = { ok: true } | { ok: false; error: "VALIDATION"; fields: string[] } | { ok: false; error: "SEND_FAILED" };

export type InquiryDeps = { db: Db; email: EmailSender; staffEmails: string[] };

const MAX_INQUIRY_NIGHTS = 365;
function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export async function submitInquiry(deps: InquiryDeps, input: InquiryInput, now: Date): Promise<InquiryResult> {
  // Bots fill every field; people never see this one. Pretend it worked.
  if (typeof input?.honeypot === "string" && input.honeypot.trim() !== "") return { ok: true };

  const parsed = inquirySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "VALIDATION", fields: [...new Set(parsed.error.issues.map((i) => String(i.path[0])))] };
  const q = parsed.data;

  // Group stays may run past the 30-night booking cap, so this is not parseStay.
  const fields: string[] = [];
  const nights = nightsBetween(q.checkIn, q.checkOut);
  if (!isRealDate(q.checkIn) || q.checkIn < todayInTaipei(now)) fields.push("checkIn");
  if (!isRealDate(q.checkOut) || nights < 1 || nights > MAX_INQUIRY_NIGHTS) fields.push("checkOut");
  if (fields.length) return { ok: false, error: "VALIDATION", fields };

  const to = deps.staffEmails.length ? deps.staffEmails : [(await getProperty(deps.db, "nk-hostel"))?.email].filter((e): e is string => !!e);

  const rows: [string, string][] = [
    ["Name", q.name],
    ["Email", q.email],
    ["Phone", q.phone || "-"],
    ["Group size", String(q.groupSize)],
    ["Check-in", q.checkIn],
    ["Check-out", q.checkOut],
    ["Language", q.locale],
  ];
  const subject = `[Group inquiry] ${q.name}, ${q.groupSize} guests, ${q.checkIn} to ${q.checkOut}`;
  const text = `${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${q.message}\n\nReply to this email to answer the guest directly.`;
  const html = `<table>${rows.map(([k, v]) => `<tr><th align="left">${k}</th><td>${escapeHtml(v)}</td></tr>`).join("")}</table>
<p style="white-space:pre-wrap">${escapeHtml(q.message)}</p>
<p>Reply to this email to answer the guest directly.</p>`;

  for (const addr of to) {
    const res = await deps.email.send({ to: addr, subject, text, html, replyTo: q.email });
    if (!res.ok) return { ok: false, error: "SEND_FAILED" };
  }
  return { ok: true };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
