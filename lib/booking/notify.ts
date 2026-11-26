import { bookingTerms } from "./terms";
import { and, eq, inArray } from "drizzle-orm";
import type { ChannelManager } from "@/lib/channel/types";
import { hasSqliteError } from "@/lib/db/inventory-hold";
import {
  guests, notifications, payments, properties, reservationRooms, reservations, unitTypes,
  type CancelPolicy, type Locale, type NotificationKind,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { EmailData } from "@/lib/email/templates";
import { renderEmail } from "@/lib/email/templates";
import type { Email, EmailSender } from "@/lib/email/types";
import type { Quote } from "@/lib/domain/quote";
import type { PaymentGateway } from "@/lib/payments/types";
import { receivedAmount } from "@/lib/admin/money-metrics";
import { log } from "@/lib/runtime/log";

export type Deps = {
  db: Db;
  gateway: PaymentGateway;
  channel: ChannelManager;
  email: EmailSender;
  staffEmails: string[];
  baseUrl: string;
  /**
   * Keep `work` running after the response (the Worker's ctx.waitUntil), for the channel hand-off a request starts
   * (lib/booking/channel-sync.ts kickChannelSync). Unset (jobs, tests): the hand-off runs inline.
   */
  defer?: (work: Promise<unknown>) => void;
  /** The real clock for channel leases (lib/booking/channel-sync.ts); default Date.now. Tests inject one. */
  clock?: () => number;
};

const STAFF_LOCALE: Locale = "zh-TW";

/**
 * Send an email at most once per (reservation, kind, recipient, ref). The notifications row is written
 * first and its unique index blocks a second send; a failed send is recorded, never thrown.
 * `ref` separates repeat alerts of one kind (e.g. one per stray charge); '' for ordinary emails.
 * Returns "sent", "failed" (the provider refused; recorded, not retried) or "duplicate" (already done).
 */
export async function sendOnce(
  deps: Pick<Deps, "db" | "email">, reservationId: string, kind: NotificationKind, to: string, email: Email, now: Date,
  ref = "",
): Promise<SendResult> {
  const { db } = deps;
  const [r] = await db.select({ propertyId: reservations.propertyId }).from(reservations).where(eq(reservations.id, reservationId));
  if (!r) throw new Error(`Reservation ${reservationId} not found`);
  const id = crypto.randomUUID();
  try {
    await db.insert(notifications).values({ id, propertyId: r.propertyId, reservationId, kind, to, ref, status: "sent", at: now.getTime() });
  } catch (e) {
    if (hasSqliteError(e, "UNIQUE constraint failed")) return "duplicate"; // already sent
    throw e;
  }
  let sent: Awaited<ReturnType<EmailSender["send"]>>;
  try {
    sent = await deps.email.send({ ...email, to });
  } catch (e) {
    sent = { ok: false, error: String(e) };
  }
  await db.update(notifications)
    .set(sent.ok ? { providerId: sent.id } : { status: "failed" })
    .where(eq(notifications.id, id));
  return sent.ok ? "sent" : "failed";
}

export type SendResult = "sent" | "failed" | "duplicate";

/**
 * Email the guest in the reservation's language. Never throws: emails run after state has
 * committed, so a failure is logged and the business flow carries on ("failed" is returned).
 * `ref` as in sendOnce (e.g. the modification number, so each modification emails once).
 */
export async function notifyGuest(
  deps: Deps, reservationId: string, kind: NotificationKind, now: Date, extra: Partial<EmailData> = {}, ref = "",
): Promise<SendResult> {
  try {
    const ctx = await emailContext(deps, reservationId);
    const data = { ...ctx.data, ...extra };
    return await sendOnce(deps, reservationId, kind, ctx.guestEmail, { to: ctx.guestEmail, ...renderEmail(kind, ctx.locale, data) }, now, ref);
  } catch (e) {
    log.error(`notifyGuest ${kind} failed for reservation ${reservationId}`, e);
    return "failed";
  }
}

/** Email every staff address, in zh-TW. Never throws; one address failing does not stop the others. */
export async function notifyStaff(
  deps: Deps, reservationId: string, kind: NotificationKind, now: Date, extra: Partial<EmailData> = {}, ref = "",
): Promise<void> {
  if (deps.staffEmails.length === 0) return;
  let rendered: ReturnType<typeof renderEmail>;
  try {
    const ctx = await emailContext(deps, reservationId, STAFF_LOCALE);
    rendered = renderEmail(kind, STAFF_LOCALE, { ...ctx.data, ...extra });
  } catch (e) {
    log.error(`notifyStaff ${kind} failed for reservation ${reservationId}`, e);
    return;
  }
  for (const to of deps.staffEmails) {
    try {
      await sendOnce(deps, reservationId, kind, to, { to, ...rendered }, now, ref);
    } catch (e) {
      log.error(`notifyStaff ${kind} to ${to} failed for reservation ${reservationId}`, e);
    }
  }
}

/** Everything an email template needs, read from the database. `locale` defaults to the reservation's. */
export async function emailContext(
  deps: Pick<Deps, "db" | "baseUrl">, reservationId: string, locale?: Locale,
): Promise<{ data: EmailData; guestEmail: string; locale: Locale }> {
  const { db } = deps;
  const [res] = await db.select().from(reservations).where(eq(reservations.id, reservationId));
  if (!res) throw new Error(`Reservation ${reservationId} not found`);
  const loc = locale ?? (res.locale as Locale);
  const [property] = await db.select().from(properties).where(eq(properties.id, res.propertyId));
  const [guest] = await db.select({ email: guests.email }).from(guests).where(eq(guests.id, res.guestId));
  const rooms = await db.select({ unitName: unitTypes.name })
    .from(reservationRooms)
    .innerJoin(unitTypes, eq(unitTypes.id, reservationRooms.unitTypeId))
    .where(eq(reservationRooms.reservationId, reservationId));
  const q = res.quote as Quote;
  const base = deps.baseUrl.replace(/\/+$/, "");
  const data: EmailData = {
    hotelName: property.name[loc],
    code: res.code,
    checkIn: res.checkIn,
    checkOut: res.checkOut,
    roomTypeName: rooms[0]?.unitName[loc] ?? "",
    rooms: rooms.length,
    nights: q.nights,
    roomSubtotal: q.roomSubtotal,
    addonSubtotal: q.addonSubtotal,
    discount: q.discount,
    total: q.total,
    paid: await receivedAmount(db, reservationId),
    cancellationText: rooms[0] ? cancellationText(bookingTerms(res).cancelPolicy, loc) : "",
    hotelPhone: property.phone,
    hotelEmail: property.email,
    hotelAddress: property.address[loc],
    manageUrl: `${base}/${loc}/manage/${res.code}`,
    arrival: { checkIn: property.checkInTime, checkOut: property.checkOutTime, directions: property.directions[loc] ?? "" },
    ...(res.refundedAmount > 0 ? { refundAmount: res.refundedAmount } : {}),
    ...(res.status === "cancelled" && res.frontDeskRefundDue > 0 ? { frontDeskRefundDue: res.frontDeskRefundDue } : {}),
  };
  return { data, guestEmail: guest.email, locale: loc };
}

/** The money vocabulary (onlineNet, received, …) lives in lib/admin/money-metrics; re-exported for booking code. */
export { onlineNetAmount, receivedAmount } from "@/lib/admin/money-metrics";

export type ChargeRow = typeof payments.$inferSelect;

/** Succeeded charges with what is still refundable on each (amount minus refunds recorded against it). */
export async function refundableCharges(db: Db, reservationId: string): Promise<(ChargeRow & { remaining: number })[]> {
  const rows = await db.select().from(payments)
    .where(and(eq(payments.reservationId, reservationId), eq(payments.status, "succeeded"), inArray(payments.kind, ["charge", "refund"])));
  const refunded = (id: string) => rows.filter((r) => r.kind === "refund" && r.refundOf === id).reduce((s, r) => s + r.amount, 0);
  return rows.filter((r) => r.kind === "charge").map((c) => ({ ...c, remaining: c.amount - refunded(c.id) }));
}

const CANCEL_COPY: Record<Locale, { rule: (days: number, pct: number) => string; none: string; sep: string }> = {
  "zh-TW": { rule: (d, p) => `入住前 ${d} 天（含）以前取消，退款 ${p}%`, none: "不可退款", sep: "；" },
  en: { rule: (d, p) => `Cancel ${d}+ day${d === 1 ? "" : "s"} before check-in: ${p}% refund`, none: "Non-refundable", sep: "; " },
  ja: { rule: (d, p) => `ご到着日の${d}日前までのキャンセル：${p}%返金`, none: "返金不可", sep: "／" },
  ko: { rule: (d, p) => `체크인 ${d}일 전까지 취소 시 ${p}% 환불`, none: "환불 불가", sep: "; " },
};

export function cancellationText(policy: CancelPolicy, locale: Locale): string {
  const c = CANCEL_COPY[locale];
  const rules = [...policy.rules].sort((a, b) => b.daysBefore - a.daysBefore).filter((r) => r.refundPct > 0);
  return rules.length ? rules.map((r) => c.rule(r.daysBefore, r.refundPct)).join(c.sep) : c.none;
}
