import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const LOCALES = ["zh-TW", "en", "ja", "ko"] as const;
export type Locale = (typeof LOCALES)[number];
export type I18n = Record<Locale, string>;

import type { CancelPolicy } from "../domain/cancellation";
export type { CancelPolicy };

const id = () => text("id").primaryKey();
const i18n = (name: string) => text(name, { mode: "json" }).$type<I18n>().notNull();
const bool = (name: string) => integer(name, { mode: "boolean" }).notNull().default(false);
const ms = (name: string) => integer(name).notNull(); // epoch milliseconds

export const properties = sqliteTable("properties", {
  id: id(),
  slug: text("slug").notNull().unique(),
  type: text("type", { enum: ["hotel", "campsite"] }).notNull(),
  name: i18n("name"),
  timezone: text("timezone").notNull(),
  currency: text("currency").notNull(),
  address: i18n("address"),
  phone: text("phone").notNull(),
  email: text("email").notNull(),
  /** Our SiteMinder HotelCode (lib/channel/siteminder/codes.ts): set once, never edited. */
  smPropertyCode: text("sm_property_code").unique(),
  sinopacMerchantId: text("sinopac_merchant_id"),
  /** 'HH:MM' Taipei wall-clock, shown in the pre-arrival email. */
  checkInTime: text("check_in_time").notNull().default("15:00"),
  checkOutTime: text("check_out_time").notNull().default("11:00"),
  /** How to get there, per language (staff-managed; the pre-arrival email shows it). */
  directions: text("directions", { mode: "json" }).$type<I18n>().notNull().default(sql`'{"zh-TW":"","en":"","ja":"","ko":""}'`),
  createdAt: ms("created_at"),
});

export const unitTypes = sqliteTable(
  "unit_types",
  {
    id: id(),
    propertyId: text("property_id").notNull().references(() => properties.id),
    slug: text("slug").notNull(),
    name: i18n("name"),
    description: i18n("description"),
    maxAdults: integer("max_adults").notNull(),
    maxOccupancy: integer("max_occupancy").notNull(),
    bedType: i18n("bed_type"),
    sizeSqm: integer("size_sqm"),
    amenities: text("amenities", { mode: "json" }).$type<string[]>().notNull(),
    /** R2 keys of the room's photos, cover first (staff-managed). Empty = the migrated old-site photos. */
    images: text("images", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Our SiteMinder RoomTypeCode (lib/channel/siteminder/codes.ts): set once, never edited. */
    smRoomCode: text("sm_room_code"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [
    uniqueIndex("unit_types_property_slug").on(t.propertyId, t.slug),
    uniqueIndex("unit_types_property_sm_room_code").on(t.propertyId, t.smRoomCode),
  ],
);

export const units = sqliteTable("units", {
  id: id(),
  propertyId: text("property_id").notNull().references(() => properties.id),
  unitTypeId: text("unit_type_id").notNull().references(() => unitTypes.id),
  label: text("label").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const ratePlans = sqliteTable(
  "rate_plans",
  {
    id: id(),
    propertyId: text("property_id").notNull().references(() => properties.id),
    slug: text("slug").notNull(),
    name: i18n("name"),
    /** Our SiteMinder RatePlanCode (lib/channel/siteminder/codes.ts): set once, never edited. */
    smRatePlanCode: text("sm_rate_plan_code"),
    directOnly: bool("direct_only"),
    paymentMode: text("payment_mode", { enum: ["full", "deposit"] }).notNull(),
    depositPct: integer("deposit_pct").notNull().default(0),
    cancelPolicy: text("cancel_policy", { mode: "json" }).$type<CancelPolicy>().notNull(),
    includesBreakfast: bool("includes_breakfast"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [
    uniqueIndex("rate_plans_property_slug").on(t.propertyId, t.slug),
    uniqueIndex("rate_plans_property_sm_rate_plan_code").on(t.propertyId, t.smRatePlanCode),
  ],
);

/** Daily rates + restrictions per (room type, rate plan). Phase 1: a cache of SiteMinder. */
export const ariDaily = sqliteTable(
  "ari_daily",
  {
    propertyId: text("property_id").notNull().references(() => properties.id),
    unitTypeId: text("unit_type_id").notNull().references(() => unitTypes.id),
    ratePlanId: text("rate_plan_id").notNull().references(() => ratePlans.id),
    date: text("date").notNull(),
    price: integer("price").notNull(),
    minStay: integer("min_stay").notNull().default(1),
    closedToArrival: bool("closed_to_arrival"),
    closedToDeparture: bool("closed_to_departure"),
    stopSell: bool("stop_sell"),
    /** Longest stay arriving on this date (SiteMinder SetMaxLOS); null = no limit. */
    maxStay: integer("max_stay"),
    /** Stay Through (SetForwardMinStay / SetForwardMaxStay): every stay covering this night must be at least / at most this long; null = no limit. */
    minStayThrough: integer("min_stay_through"),
    maxStayThrough: integer("max_stay_through"),
    source: text("source", { enum: ["siteminder", "local"] }).notNull(),
    syncedAt: ms("synced_at"),
    /**
     * The SiteMinder message TimeStamp (epoch ms, lib/channel/siteminder/inbound/ari.ts orderingTs) that last set this
     * night's restrictions / its price: an older message never overwrites a newer one. Null = never set by SiteMinder.
     */
    restrictionsSourceTs: integer("restrictions_source_ts"),
    priceSourceTs: integer("price_source_ts"),
  },
  (t) => [
    primaryKey({ columns: [t.unitTypeId, t.ratePlanId, t.date] }),
    index("ari_property_date").on(t.propertyId, t.date),
  ],
);

/**
 * Sellable rooms per (room type, date) — shared by every rate plan, as in SiteMinder.
 * Phase 1: a cache of SiteMinder, decremented locally by holds.
 */
export const inventoryDaily = sqliteTable(
  "inventory_daily",
  {
    propertyId: text("property_id").notNull().references(() => properties.id),
    unitTypeId: text("unit_type_id").notNull().references(() => unitTypes.id),
    date: text("date").notNull(),
    available: integer("available").notNull(),
    source: text("source", { enum: ["siteminder", "local"] }).notNull(),
    syncedAt: ms("synced_at"),
    /** The SiteMinder message TimeStamp (epoch ms) that last set `available`; see ariDaily.restrictionsSourceTs. */
    sourceTs: integer("source_ts"),
    /**
     * The BookingLimit SiteMinder last sent (diagnosis only). `available` is it minus our rooms SiteMinder has not
     * counted yet (lib/db/ari-sync.ts OUTSTANDING_ROOMS).
     */
    smAvailable: integer("sm_available"),
  },
  (t) => [
    primaryKey({ columns: [t.unitTypeId, t.date] }),
    index("inventory_property_date").on(t.propertyId, t.date),
    // Last line of defence against overselling: a hold that would go negative aborts its transaction.
    check("inventory_available_nonnegative", sql`${t.available} >= 0`),
  ],
);

export const guests = sqliteTable("guests", {
  id: id(),
  propertyId: text("property_id").notNull().references(() => properties.id),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  country: text("country").notNull(),
  locale: text("locale").notNull(),
  createdAt: ms("created_at"),
});

export const reservations = sqliteTable(
  "reservations",
  {
    id: id(),
    propertyId: text("property_id").notNull().references(() => properties.id),
    code: text("code").notNull().unique(),
    guestId: text("guest_id").notNull().references(() => guests.id),
    status: text("status", {
      enum: ["pending_payment", "paid_pending_confirm", "confirmed", "confirm_failed_refunded", "cancelled", "expired"],
    }).notNull(),
    channel: text("channel", { enum: ["direct", "siteminder_ota"] }).notNull(),
    smConfirmation: text("sm_confirmation"),
    checkIn: text("check_in").notNull(),
    checkOut: text("check_out").notNull(),
    adults: integer("adults").notNull(),
    children: integer("children").notNull().default(0),
    locale: text("locale").notNull(),
    quote: text("quote", { mode: "json" }).$type<unknown>().notNull(),
    totalAmount: integer("total_amount").notNull(),
    promoCode: text("promo_code"),
    /**
     * The rate plan's cancellation policy and name AS BOOKED. Editing the plan later never changes them; only a
     * modification onto a different plan replaces them (with that plan's, at modification time). Read through
     * lib/booking/terms.ts, never from `rate_plans`.
     */
    cancelPolicy: text("cancel_policy", { mode: "json" }).$type<CancelPolicy>().notNull().default(sql`'{"rules":[]}'`),
    ratePlanName: text("rate_plan_name", { mode: "json" }).$type<I18n>().notNull().default(sql`'{"zh-TW":"","en":"","ja":"","ko":""}'`),
    syncState: text("sync_state", { enum: ["not_required", "pending", "synced", "failed"] }).notNull(),
    /** Epoch ms when the inventory hold lapses; null = no inventory currently held. */
    holdExpiresAt: integer("hold_expires_at"),
    idempotencyKey: text("idempotency_key").unique(),
    syncAttempts: integer("sync_attempts").notNull().default(0),
    nextSyncAt: integer("next_sync_at"),
    lastSyncError: text("last_sync_error"),
    /** Epoch ms the channel last answered Success to a push or modify of this booking (lib/booking/channel-sync.ts). */
    channelSyncedAt: integer("channel_synced_at"),
    cancelledAt: integer("cancelled_at"),
    /** Epoch ms of the latest payment start (create, or a retry with the same idempotency key). */
    lastChargeStartedAt: integer("last_charge_started_at"),
    /** How many payment attempts were started; attempt n's merchantOrderNo is `<code>-<n>`. */
    chargeAttempt: integer("charge_attempt").notNull().default(0),
    /** Cancellation and failed-booking refunds only; every refund (staff modifications too) is in the money module's `refunded`. */
    refundedAmount: integer("refunded_amount").notNull().default(0),
    /** Lower-cased guest email, for lookups. */
    guestEmailLower: text("guest_email_lower").notNull(),
    createdAt: ms("created_at"),
    updatedAt: ms("updated_at"),
    /**
     * What the front desk must hand back to the guest (front-desk money never goes back through the gateway).
     * Live booking: set by each staff modification to the overpayment its online refund could not cover (0 once
     * a raise uses it up). Cancelled: that owed money plus the cancellation's own desk share, written as the
     * booking turns cancelled. Every desk payout (recordFrontDeskRefund) takes its amount off, so it is always
     * what the desk still owes right now.
     */
    frontDeskRefundDue: integer("front_desk_refund_due").notNull().default(0),
    /**
     * The desk share of a cancellation whose refund intent exists but which has not completed yet: fixed with that
     * intent (every attempt reuses it), copied into frontDeskRefundDue only when the booking turns cancelled, so a
     * cancel that fails and drops its claim never changes what the desk owes. 0 otherwise.
     */
    cancelDeskDue: integer("cancel_desk_due").notNull().default(0),
    /** Epoch ms since when frontDeskRefundDue has been > 0 (set as it rises from 0, kept while > 0); null when 0. */
    deskDueSince: integer("desk_due_since"),
    /** How many staff modifications this booking has had; the n-th one's refund key is `modify:<id>:<n>`. */
    modCount: integer("mod_count").notNull().default(0),
    /**
     * Epoch ms of the first push (new reservation) sent to the channel, set just before the call and never cleared:
     * from then on the channel may hold the booking even without an smConfirmation (an answer lost to a timeout),
     * so a cancel must reach it. Null = never sent: a cancel then sends nothing (lib/booking/channel-sync.ts).
     */
    channelPushedAt: integer("channel_pushed_at"),
    /** Epoch ms of the latest channel hand-off failure (retryable or not); what the dashboard's sync_failed alert dates from. */
    lastSyncAt: integer("last_sync_at"),
  },
  (t) => [
    index("reservations_property_checkin").on(t.propertyId, t.checkIn),
    // The ARI outstanding-rooms query (lib/db/ari-sync.ts outstandingRooms): bookings not yet checked out.
    index("reservations_property_checkout").on(t.propertyId, t.checkOut),
    index("reservations_guest_email_lower").on(t.guestEmailLower),
  ],
);

export const reservationRooms = sqliteTable("reservation_rooms", {
  id: id(),
  reservationId: text("reservation_id").notNull().references(() => reservations.id),
  unitTypeId: text("unit_type_id").notNull().references(() => unitTypes.id),
  ratePlanId: text("rate_plan_id").notNull().references(() => ratePlans.id),
  nightlyPrices: text("nightly_prices", { mode: "json" }).$type<number[]>().notNull(),
}, (t) => [index("reservation_rooms_reservation").on(t.reservationId)]);

/** Never add card number / CVV / expiry columns here (PCI-DSS). */
export const payments = sqliteTable(
  "payments",
  {
    id: id(),
    reservationId: text("reservation_id").notNull().references(() => reservations.id),
    kind: text("kind", { enum: ["charge", "preauth", "capture", "refund", "front_desk"] }).notNull(),
    method: text("method", { enum: ["sinopac_online", "edc", "cash", "transfer"] }).notNull(),
    amount: integer("amount").notNull(),
    status: text("status", { enum: ["pending", "succeeded", "failed"] }).notNull(),
    providerRef: text("provider_ref"),
    authCode: text("auth_code"),
    last4: text("last4"),
    /** For a refund: the id of the charge row it reverses. */
    refundOf: text("refund_of"),
    /**
     * For a refund: what it is for (`cancel:<reservationId>`, `fail:<reservationId>:<chargeId>`,
     * `stray:<providerRef>`). Every attempt at the same refund converges on this one row; it is also
     * the gateway's idempotency key. Null for charges.
     */
    idempotencyKey: text("idempotency_key"),
    createdAt: ms("created_at"),
    /** Front-desk payments: the staff's free-text note (e.g. transfer reference); null otherwise. */
    note: text("note"),
    /**
     * For an online charge: the payment attempt's order number (`<code>-<n>`) when known (the notice carried it, or
     * the gateway reconcile job recorded or matched it), so that job does not ask about that attempt again. Null otherwise.
     */
    merchantOrderNo: text("merchant_order_no"),
    /**
     * For a cancellation's refund intent (`cancel:<id>`): whether the guest is emailed when the cancellation
     * completes. Fixed with the intent (a staff cancel may choose not to), so a completion by refund
     * reconciliation honours it. Null (every other row, and intents from before this column) means yes.
     */
    notifyGuest: integer("notify_guest", { mode: "boolean" }),
    /**
     * For a refund: when it became `succeeded` (epoch ms), which is when the money went back: reports count a
     * refund on this date (a pending refund settled days later by reconciliation belongs to that later day).
     * Set by every path that settles a refund; null while it is pending or failed, and for other kinds.
     */
    settledAt: integer("settled_at"),
  },
  (t) => [
    uniqueIndex("payments_provider_ref_unique").on(t.providerRef), // NULLs never collide
    uniqueIndex("payments_idempotency_key_unique").on(t.idempotencyKey),
  ],
);

/** Full log of every payment-provider callback, for audit and reconciliation. */
export const paymentEvents = sqliteTable(
  "payment_events",
  {
  id: id(),
  /** Null for events that match no reservation (unknown_reservation). */
  propertyId: text("property_id").references(() => properties.id),
  provider: text("provider").notNull(),
  providerRef: text("provider_ref"),
  reservationCode: text("reservation_code"),
  rawBody: text("raw_body").notNull(),
  verdict: text("verdict", {
    enum: ["accepted", "duplicate", "bad_signature", "amount_mismatch", "unknown_reservation", "stray_charge"],
  }).notNull(),
  at: ms("at"),
  },
  (t) => [index("payment_events_property_at").on(t.propertyId, t.at)],
);
export type PaymentEventVerdict = typeof paymentEvents.$inferSelect["verdict"];

export const notifications = sqliteTable(
  "notifications",
  {
    id: id(),
    propertyId: text("property_id").notNull().references(() => properties.id),
    reservationId: text("reservation_id").notNull().references(() => reservations.id),
    kind: text("kind", {
      enum: [
        "booking_confirmed", "booking_failed_refunded", "payment_refunded", "cancelled", "pre_arrival", "booking_modified",
        "staff_new_booking", "staff_sync_failed", "staff_payment_alert",
      ],
    }).notNull(),
    to: text("to").notNull(),
    /** Distinguishes repeat alerts of one kind, e.g. the provider ref of each stray charge. '' = none. */
    ref: text("ref").notNull().default(""),
    status: text("status", { enum: ["sent", "failed"] }).notNull(),
    providerId: text("provider_id"),
    at: ms("at"),
  },
  // The same email is never sent twice.
  (t) => [uniqueIndex("notifications_unique_send").on(t.reservationId, t.kind, t.to, t.ref)],
);
export type NotificationKind = typeof notifications.$inferSelect["kind"];

export const addons = sqliteTable(
  "addons",
  {
    id: id(),
    propertyId: text("property_id").notNull().references(() => properties.id),
    slug: text("slug").notNull(),
    name: i18n("name"),
    price: integer("price").notNull(),
    unit: text("unit", { enum: ["per_stay", "per_night", "per_person_night"] }).notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("addons_property_slug").on(t.propertyId, t.slug)],
);

export const promoCodes = sqliteTable(
  "promo_codes",
  {
    id: id(),
    propertyId: text("property_id").notNull().references(() => properties.id),
    /** Stored trimmed and UPPERCASE (lib/admin/commerce); matched case-insensitively at booking time. */
    code: text("code").notNull(),
    kind: text("kind", { enum: ["percent", "fixed"] }).notNull(),
    value: integer("value").notNull(),
    validFrom: text("valid_from"),
    validTo: text("valid_to"),
    maxUses: integer("max_uses"),
    usedCount: integer("used_count").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("promo_codes_property_code").on(t.propertyId, t.code)],
);

export const staff = sqliteTable(
  "staff",
  {
    id: id(),
    /** Stored trimmed and lowercase (lib/admin/staff); unique case-insensitively. It is the Access identity. */
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role", { enum: ["owner", "manager", "front_desk", "marketing"] }).notNull(),
    propertyIds: text("property_ids", { mode: "json" }).$type<string[]>().notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("staff_email_lower_unique").on(sql`lower(${t.email})`)],
);

export const auditLog = sqliteTable("audit_log", {
  id: id(),
  staffEmail: text("staff_email").notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  before: text("before", { mode: "json" }),
  after: text("after", { mode: "json" }),
  at: ms("at"),
});

/** Staff-only notes on a reservation. Append-only: there is no update or delete path. */
export const reservationNotes = sqliteTable(
  "reservation_notes",
  {
    id: id(),
    reservationId: text("reservation_id").notNull().references(() => reservations.id),
    propertyId: text("property_id").notNull().references(() => properties.id),
    staffEmail: text("staff_email").notNull(),
    body: text("body").notNull(),
    createdAt: ms("created_at"),
  },
  (t) => [index("reservation_notes_reservation").on(t.reservationId, t.createdAt)],
);

const contentTable = (name: string) =>
  sqliteTable(name, {
    id: id(),
    propertyId: text("property_id").notNull().references(() => properties.id),
    slug: text("slug").notNull(),
    title: i18n("title"),
    body: i18n("body"),
    publishedAt: integer("published_at"),
    sortOrder: integer("sort_order").notNull().default(0),
  });

export const contentPages = contentTable("content_pages");
export const news = contentTable("news");
export const faqs = contentTable("faqs");

/** Reserved for phase 2 (membership). */
export const members = sqliteTable("members", {
  id: id(),
  guestId: text("guest_id").notNull().references(() => guests.id),
  tier: text("tier").notNull(),
  points: integer("points").notNull().default(0),
});

/** Fixed-window request counters (lib/api/rate-limit.ts). One row per key, e.g. `create:<ip>`. */
export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  /** Epoch ms at which the current window started. */
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull(),
});

/** One row per cron tick (lib/jobs/cron.ts): its counts, or the error. The cron prunes rows older than 30 days. */
export const jobRuns = sqliteTable(
  "job_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    startedAt: ms("started_at"),
    finishedAt: ms("finished_at"),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index("job_runs_name_started").on(t.name, t.startedAt)],
);

/**
 * Ops alerts sent (lib/ops/alerts.ts): one row per alert key per send, so each key emails ops at most once an hour.
 * Not in `notifications`: that table's rows belong to a reservation (reservation_id NOT NULL REFERENCES
 * reservations), and an ops alert (a cron failing, a reconcile run's mismatches) has none.
 */
export const opsAlerts = sqliteTable(
  "ops_alerts",
  {
    id: id(),
    /** The alert kind, plus `:<scope>` when it has one (e.g. `cron_failed:gateway_reconcile`). */
    key: text("key").notNull(),
    /** floor(at / 1 hour): the unique index stops two concurrent runs from both sending in the same hour. */
    hour: integer("hour").notNull(),
    status: text("status", { enum: ["sent", "failed"] }).notNull(),
    at: ms("at"),
  },
  (t) => [uniqueIndex("ops_alerts_key_hour").on(t.key, t.hour), index("ops_alerts_key_at").on(t.key, t.at)],
);

/**
 * One channel message in flight per hotel (SiteMinder, doc §8.7): a property's row is its channel lease, held by
 * one worker (`holder`) until `until` (epoch ms). Taken and released by lib/booking/channel-sync.ts.
 */
export const channelLeases = sqliteTable("channel_leases", {
  propertyId: text("property_id").primaryKey(),
  holder: text("holder").notNull(),
  until: ms("until"),
});

/**
 * Every ARI message SiteMinder sent us that passed authentication (lib/channel/siteminder/inbound/ari.ts), for
 * /admin/system and the repeated-rejection ops alert. Never the XML itself. Rows older than ARI_LOG_KEEP_MS are pruned.
 */
export const channelAriMessages = sqliteTable(
  "channel_ari_messages",
  {
    id: id(),
    at: ms("at"),
    /** Null when the HotelCode matched no property. */
    propertyId: text("property_id"),
    /** The request root, e.g. OTA_HotelAvailNotifRQ. */
    messageType: text("message_type").notNull(),
    echoToken: text("echo_token"),
    /** Day rows the message expands to (one per day per room type / rate plan). */
    days: integer("days").notNull(),
    outcome: text("outcome", { enum: ["applied", "rejected"] }).notNull(),
    /** The OTA error we answered with (rejected only). */
    errorCode: integer("error_code"),
    errorText: text("error_text"),
    /** Room type / rate plan codes we answered 402 / 249 for. */
    rejectedCodes: text("rejected_codes", { mode: "json" }).$type<{ kind: "room" | "rate"; code: string }[]>().notNull().default(sql`'[]'`),
    /** Day rows not written because a newer message had already set them (ordering). */
    staleRows: integer("stale_rows").notNull().default(0),
    /** Day rows stored with price 0 or availability clamped because a value was unusable (warned, not refused). */
    degradedRows: integer("degraded_rows").notNull().default(0),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [index("channel_ari_messages_at").on(t.at)],
);
