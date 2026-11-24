import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const LOCALES = ["zh-TW", "en", "ja", "ko"] as const;
export type Locale = (typeof LOCALES)[number];
export type I18n = Record<Locale, string>;

export type CancelPolicy = { rules: { daysBefore: number; refundPct: number }[] };

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
  smPropertyCode: text("sm_property_code"),
  sinopacMerchantId: text("sinopac_merchant_id"),
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
    sortOrder: integer("sort_order").notNull().default(0),
    smRoomCode: text("sm_room_code"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("unit_types_property_slug").on(t.propertyId, t.slug)],
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
    smRatePlanCode: text("sm_rate_plan_code"),
    directOnly: bool("direct_only"),
    paymentMode: text("payment_mode", { enum: ["full", "deposit"] }).notNull(),
    depositPct: integer("deposit_pct").notNull().default(0),
    cancelPolicy: text("cancel_policy", { mode: "json" }).$type<CancelPolicy>().notNull(),
    includesBreakfast: bool("includes_breakfast"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("rate_plans_property_slug").on(t.propertyId, t.slug)],
);

/** Daily availability/rates/restrictions. Phase 1: a cache of SiteMinder. */
export const ariDaily = sqliteTable(
  "ari_daily",
  {
    propertyId: text("property_id").notNull().references(() => properties.id),
    unitTypeId: text("unit_type_id").notNull().references(() => unitTypes.id),
    ratePlanId: text("rate_plan_id").notNull().references(() => ratePlans.id),
    date: text("date").notNull(),
    available: integer("available").notNull().default(0),
    price: integer("price").notNull().default(0),
    minStay: integer("min_stay").notNull().default(1),
    closedToArrival: bool("closed_to_arrival"),
    closedToDeparture: bool("closed_to_departure"),
    stopSell: bool("stop_sell"),
    source: text("source", { enum: ["siteminder", "local"] }).notNull(),
    syncedAt: ms("synced_at"),
  },
  (t) => [
    primaryKey({ columns: [t.unitTypeId, t.ratePlanId, t.date] }),
    index("ari_property_date").on(t.propertyId, t.date),
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
      enum: ["pending_payment", "paid_pending_confirm", "confirmed", "confirm_failed_refunded", "cancelled"],
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
    syncState: text("sync_state", { enum: ["not_required", "pending", "synced", "failed"] }).notNull(),
    createdAt: ms("created_at"),
    updatedAt: ms("updated_at"),
  },
  (t) => [index("reservations_property_checkin").on(t.propertyId, t.checkIn)],
);

export const reservationRooms = sqliteTable("reservation_rooms", {
  id: id(),
  reservationId: text("reservation_id").notNull().references(() => reservations.id),
  unitTypeId: text("unit_type_id").notNull().references(() => unitTypes.id),
  ratePlanId: text("rate_plan_id").notNull().references(() => ratePlans.id),
  nightlyPrices: text("nightly_prices", { mode: "json" }).$type<number[]>().notNull(),
});

/** Never add card number / CVV / expiry columns here (PCI-DSS). */
export const payments = sqliteTable("payments", {
  id: id(),
  reservationId: text("reservation_id").notNull().references(() => reservations.id),
  kind: text("kind", { enum: ["charge", "preauth", "capture", "refund", "front_desk"] }).notNull(),
  method: text("method", { enum: ["sinopac_online", "edc", "cash", "transfer"] }).notNull(),
  amount: integer("amount").notNull(),
  status: text("status", { enum: ["pending", "succeeded", "failed"] }).notNull(),
  providerRef: text("provider_ref"),
  authCode: text("auth_code"),
  last4: text("last4"),
  createdAt: ms("created_at"),
});

export const addons = sqliteTable("addons", {
  id: id(),
  propertyId: text("property_id").notNull().references(() => properties.id),
  slug: text("slug").notNull(),
  name: i18n("name"),
  price: integer("price").notNull(),
  unit: text("unit", { enum: ["per_stay", "per_night", "per_person_night"] }).notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const promoCodes = sqliteTable(
  "promo_codes",
  {
    id: id(),
    propertyId: text("property_id").notNull().references(() => properties.id),
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

export const staff = sqliteTable("staff", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: text("role", { enum: ["owner", "manager", "front_desk", "marketing"] }).notNull(),
  propertyIds: text("property_ids", { mode: "json" }).$type<string[]>().notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

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
