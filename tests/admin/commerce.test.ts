import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import type { StaffContext } from "@/lib/admin/auth";
import {
  createAddon, createPromo, updateAddon, updatePromo, updateProperty, updateRatePlan,
} from "@/lib/admin/commerce";
import { addons, auditLog, promoCodes, properties, ratePlans, reservations, staff, type I18n } from "@/lib/db/schema";
import { bookingInput, bookingSetup, NOW } from "../helpers/booking";
import { createReservation } from "@/lib/booking/create";
import { priceStay } from "@/lib/booking/pricing";
import { emailContext } from "@/lib/booking/notify";

const t = (s: string): I18n => ({ "zh-TW": `${s}-zh`, en: `${s}-en`, ja: `${s}-ja`, ko: `${s}-ko` });

async function setup() {
  const s = await bookingSetup();
  const { db, propertyId } = s;
  const other = "other-property";
  await db.insert(properties).values({
    id: other, slug: "other", type: "hotel", name: t("o"), timezone: "Asia/Taipei", currency: "TWD", address: t("a"),
    phone: "1", email: "o@x.test", createdAt: 0,
  });
  const mk = async (role: "manager" | "front_desk" | "marketing" | "owner", propertyIds = [propertyId]): Promise<StaffContext> => {
    const row = { id: `s-${role}-${propertyIds.join()}`, email: `${role}-${propertyIds.join()}@nk.test`, name: role, role, propertyIds, active: true };
    await db.insert(staff).values(row);
    return { staff: row, email: row.email };
  };
  const [plan] = await db.select().from(ratePlans).where(eq(ratePlans.propertyId, propertyId));
  const audits = (entityId: string) => db.select().from(auditLog).where(eq(auditLog.entityId, entityId));
  return {
    ...s, plan, audits, other,
    owner: await mk("owner"), manager: await mk("manager"), frontDesk: await mk("front_desk"), marketing: await mk("marketing"),
    outsider: await mk("owner", [other]),
  };
}

const addonInput = (over = {}) => ({ slug: "breakfast", name: t("早餐"), price: 250, unit: "per_person_night" as const, active: true, ...over });
const promoInput = (over = {}) => ({ code: "welcome10", kind: "percent" as const, value: 10, validFrom: null, validTo: null, maxUses: null, active: true, ...over });

describe("permissions", () => {
  test("front_desk and marketing are FORBIDDEN on every write; a manager of another property too", async () => {
    const { db, propertyId, plan, frontDesk, marketing, outsider, owner } = await setup();
    const a = await createAddon(db, owner, propertyId, addonInput(), NOW);
    if (!a.ok) throw new Error("setup");
    const p = await createPromo(db, owner, propertyId, promoInput(), NOW);
    if (!p.ok) throw new Error("setup");
    for (const who of [frontDesk, marketing, outsider]) {
      expect(await createAddon(db, who, propertyId, addonInput({ slug: "x" }), NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
      expect(await updateAddon(db, who, a.id, { price: 1 }, NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
      expect(await createPromo(db, who, propertyId, promoInput({ code: "X1" }), NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
      expect(await updatePromo(db, who, p.id, { value: 5 }, NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
      expect(await updateRatePlan(db, who, plan.id, { active: false }, NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
      expect(await updateProperty(db, who, propertyId, { phone: "123" }, NOW)).toEqual({ ok: false, error: "FORBIDDEN" });
    }
    expect((await db.select().from(addons).where(eq(addons.id, a.id)))[0].price).toBe(250);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "addon.update"))).toHaveLength(0);
  });
});

describe("add-ons", () => {
  test("create stores the add-on and audits it; the slug is unique per property", async () => {
    const { db, propertyId, other, owner, outsider, audits } = await setup();
    const r = await createAddon(db, owner, propertyId, addonInput(), NOW);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(await audits(r.id)).toHaveLength(1);
    expect(await createAddon(db, owner, propertyId, addonInput(), NOW)).toEqual({ ok: false, error: "SLUG_TAKEN" });
    // The same slug in another property is fine.
    expect(await createAddon(db, outsider, other, addonInput(), NOW)).toMatchObject({ ok: true });
  });

  test("all four languages are required, price is a positive integer, unit is one of three", async () => {
    const { db, propertyId, owner } = await setup();
    expect(await createAddon(db, owner, propertyId, addonInput({ name: { ...t("x"), ko: " " } }), NOW))
      .toEqual({ ok: false, error: "I18N_INCOMPLETE", field: "name" });
    for (const price of [0, -5, 1.5, "100", null]) {
      expect(await createAddon(db, owner, propertyId, addonInput({ price }), NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "price" });
    }
    expect(await createAddon(db, owner, propertyId, addonInput({ unit: "per_hour" }), NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "unit" });
    expect(await createAddon(db, owner, propertyId, addonInput({ slug: "Bad Slug" }), NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "slug" });
    expect(await db.select().from(addons)).toHaveLength(0);
  });

  test("update changes price/active with before-and-after audit; a taken slug and unknown fields are refused", async () => {
    const { db, propertyId, owner, audits } = await setup();
    const a = await createAddon(db, owner, propertyId, addonInput(), NOW);
    const b = await createAddon(db, owner, propertyId, addonInput({ slug: "spa" }), NOW);
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(await updateAddon(db, owner, a.id, { price: 300, active: false }, NOW)).toEqual({ ok: true });
    const [row] = await db.select().from(addons).where(eq(addons.id, a.id));
    expect(row).toMatchObject({ price: 300, active: false });
    const upd = (await audits(a.id)).find((x) => x.action === "addon.update");
    expect(upd?.before).toEqual({ price: 250, active: true });
    expect(upd?.after).toEqual({ price: 300, active: false });
    expect(await updateAddon(db, owner, b.id, { slug: "breakfast" }, NOW)).toEqual({ ok: false, error: "SLUG_TAKEN" });
    expect(await updateAddon(db, owner, b.id, { propertyId: "x" } as never, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "propertyId" });
    expect(await updateAddon(db, owner, "nope", { price: 1 }, NOW)).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  test("after an edit, createReservation prices with the new add-on price", async () => {
    const { db, propertyId, owner, deps } = await setup();
    const a = await createAddon(db, owner, propertyId, addonInput({ unit: "per_stay", price: 500 }), NOW);
    if (!a.ok) throw new Error("setup");
    const book = async (key: string) => {
      const r = await createReservation(deps, bookingInput({ addons: [{ slug: "breakfast", qty: 1 }], idempotencyKey: key }), NOW);
      if (!r.ok) throw new Error(JSON.stringify(r));
      return (await db.select().from(reservations).where(eq(reservations.code, r.code)))[0].totalAmount;
    };
    expect(await book("key-before-edit-1")).toBe(4000 + 500);
    expect(await updateAddon(db, owner, a.id, { price: 800 }, NOW)).toEqual({ ok: true });
    expect(await book("key-after-edit-1")).toBe(4000 + 800);
    // Switching it off removes it from sale.
    await updateAddon(db, owner, a.id, { active: false }, NOW);
    expect(await createReservation(deps, bookingInput({ addons: [{ slug: "breakfast", qty: 1 }], idempotencyKey: "key-off-edit-xx" }), NOW))
      .toMatchObject({ ok: false, error: "INVALID_INPUT" });
  });
});

describe("promo codes", () => {
  test("the code is stored trimmed and uppercase; the same code in any case is a conflict", async () => {
    const { db, propertyId, owner, other, outsider } = await setup();
    const a = await createPromo(db, owner, propertyId, promoInput({ code: " welcome10 " }), NOW);
    if (!a.ok) throw new Error(JSON.stringify(a));
    expect((await db.select().from(promoCodes).where(eq(promoCodes.id, a.id)))[0].code).toBe("WELCOME10");
    for (const code of ["WELCOME10", "welcome10", "Welcome10"]) {
      expect(await createPromo(db, owner, propertyId, promoInput({ code }), NOW)).toEqual({ ok: false, error: "CODE_TAKEN" });
    }
    // A legacy lower-case row (from before codes were normalised) still blocks the uppercase code.
    await db.insert(promoCodes).values({ id: "legacy", propertyId, code: "spring", kind: "fixed", value: 50, active: true });
    expect(await createPromo(db, owner, propertyId, promoInput({ code: "SPRING" }), NOW)).toEqual({ ok: false, error: "CODE_TAKEN" });
    // Another property may reuse it.
    expect(await createPromo(db, outsider, other, promoInput({ code: "welcome10" }), NOW)).toMatchObject({ ok: true });
  });

  test("renaming onto another code in a different case conflicts; renaming to itself is fine", async () => {
    const { db, propertyId, owner } = await setup();
    const a = await createPromo(db, owner, propertyId, promoInput({ code: "AAA" }), NOW);
    const b = await createPromo(db, owner, propertyId, promoInput({ code: "BBB" }), NOW);
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(await updatePromo(db, owner, b.id, { code: "aaa" }, NOW)).toEqual({ ok: false, error: "CODE_TAKEN" });
    expect(await updatePromo(db, owner, a.id, { code: "aaa" }, NOW)).toEqual({ ok: true });
    expect((await db.select().from(promoCodes).where(eq(promoCodes.id, a.id)))[0].code).toBe("AAA");
  });

  test("pricing finds the code whatever the case the guest types", async () => {
    const { db, propertyId, owner } = await setup();
    await createPromo(db, owner, propertyId, promoInput({ code: "Welcome10" }), NOW);
    for (const typed of ["welcome10", "WELCOME10", " Welcome10 "]) {
      const r = await priceStay(db, { ...bookingInput({ promoCode: typed }) }, NOW);
      expect(r.ok, typed).toBe(true);
    }
  });

  test("percent must be 1..100 and fixed a positive integer", async () => {
    const { db, propertyId, owner } = await setup();
    for (const value of [150, 101, 0, -1, 10.5]) {
      expect(await createPromo(db, owner, propertyId, promoInput({ value }), NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "value" });
    }
    expect(await createPromo(db, owner, propertyId, promoInput({ code: "FULL", value: 100 }), NOW)).toMatchObject({ ok: true });
    expect(await createPromo(db, owner, propertyId, promoInput({ code: "F150", kind: "fixed", value: 150 }), NOW)).toMatchObject({ ok: true });
    expect(await createPromo(db, owner, propertyId, promoInput({ code: "F0", kind: "fixed", value: 0 }), NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "value" });
    expect(await createPromo(db, owner, propertyId, promoInput({ code: "BADKIND", kind: "bogus" }), NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "kind" });
  });

  test("changing kind re-checks the existing value", async () => {
    const { db, propertyId, owner } = await setup();
    const f = await createPromo(db, owner, propertyId, promoInput({ code: "FX", kind: "fixed", value: 500 }), NOW);
    if (!f.ok) throw new Error("setup");
    expect(await updatePromo(db, owner, f.id, { kind: "percent" }, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "value" });
    expect(await updatePromo(db, owner, f.id, { kind: "percent", value: 20 }, NOW)).toEqual({ ok: true });
  });

  test("validFrom must not be after validTo, and dates must be real YYYY-MM-DD", async () => {
    const { db, propertyId, owner } = await setup();
    expect(await createPromo(db, owner, propertyId, promoInput({ validFrom: "2026-12-10", validTo: "2026-12-01" }), NOW))
      .toEqual({ ok: false, error: "INVALID_INPUT", field: "validTo" });
    expect(await createPromo(db, owner, propertyId, promoInput({ validFrom: "2026-02-30" }), NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "validFrom" });
    expect(await createPromo(db, owner, propertyId, promoInput({ validFrom: "12/01/2026" }), NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "validFrom" });
    expect(await createPromo(db, owner, propertyId, promoInput({ validFrom: "2026-12-01", validTo: "2026-12-01" }), NOW)).toMatchObject({ ok: true });
    // An update is checked against the stored other end.
    const p = await createPromo(db, owner, propertyId, promoInput({ code: "RNG", validFrom: "2026-12-01", validTo: "2026-12-31" }), NOW);
    if (!p.ok) throw new Error("setup");
    expect(await updatePromo(db, owner, p.id, { validTo: "2026-11-01" }, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "validTo" });
  });

  test("maxUses blank is unlimited, otherwise a positive integer; usedCount cannot be set", async () => {
    const { db, propertyId, owner } = await setup();
    const p = await createPromo(db, owner, propertyId, promoInput({ maxUses: null }), NOW);
    if (!p.ok) throw new Error("setup");
    expect((await db.select().from(promoCodes).where(eq(promoCodes.id, p.id)))[0].maxUses).toBeNull();
    for (const maxUses of [0, -1, 2.5, "5"]) {
      expect(await updatePromo(db, owner, p.id, { maxUses } as never, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "maxUses" });
    }
    expect(await updatePromo(db, owner, p.id, { maxUses: 50 }, NOW)).toEqual({ ok: true });
    expect(await updatePromo(db, owner, p.id, { usedCount: 0 } as never, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "usedCount" });
    expect(await createPromo(db, owner, propertyId, { ...promoInput({ code: "SNEAKY" }), usedCount: 99 } as never, NOW))
      .toEqual({ ok: false, error: "INVALID_INPUT", field: "usedCount" });
  });

  test("an edit keeps usedCount and audits before/after", async () => {
    const { db, propertyId, owner, audits } = await setup();
    const p = await createPromo(db, owner, propertyId, promoInput(), NOW);
    if (!p.ok) throw new Error("setup");
    await db.update(promoCodes).set({ usedCount: 7 }).where(eq(promoCodes.id, p.id));
    expect(await updatePromo(db, owner, p.id, { value: 15, active: false }, NOW)).toEqual({ ok: true });
    expect((await db.select().from(promoCodes).where(eq(promoCodes.id, p.id)))[0]).toMatchObject({ value: 15, active: false, usedCount: 7 });
    const upd = (await audits(p.id)).find((x) => x.action === "promo.update");
    expect(upd?.before).toEqual({ value: 10, active: true });
    expect(upd?.after).toEqual({ value: 15, active: false });
  });
});

describe("rate plans", () => {
  test("cancelPolicy [{3,50},{1,100}] is refused (closer to check-in must not refund more)", async () => {
    const { db, plan, owner } = await setup();
    const r = await updateRatePlan(db, owner, plan.id, { cancelPolicy: { rules: [{ daysBefore: 3, refundPct: 50 }, { daysBefore: 1, refundPct: 100 }] } }, NOW);
    expect(r).toMatchObject({ ok: false, error: "INVALID_INPUT", field: "cancelPolicy" });
    expect((await db.select().from(ratePlans).where(eq(ratePlans.id, plan.id)))[0].cancelPolicy).toEqual(plan.cancelPolicy);
  });

  test("duplicate daysBefore, pct out of range and non-integers are refused; a good policy is saved and audited", async () => {
    const { db, plan, owner, audits } = await setup();
    for (const rules of [
      [{ daysBefore: 3, refundPct: 100 }, { daysBefore: 3, refundPct: 50 }],
      [{ daysBefore: 3, refundPct: 120 }], [{ daysBefore: -1, refundPct: 10 }], [{ daysBefore: 2.5, refundPct: 10 }], [{ daysBefore: 2, refundPct: 10.5 }],
    ]) {
      expect(await updateRatePlan(db, owner, plan.id, { cancelPolicy: { rules } }, NOW)).toMatchObject({ ok: false, field: "cancelPolicy" });
    }
    const good = { rules: [{ daysBefore: 7, refundPct: 100 }, { daysBefore: 2, refundPct: 50 }] };
    expect(await updateRatePlan(db, owner, plan.id, { cancelPolicy: good }, NOW)).toEqual({ ok: true });
    expect((await db.select().from(ratePlans).where(eq(ratePlans.id, plan.id)))[0].cancelPolicy).toEqual(good);
    const upd = (await audits(plan.id)).find((x) => x.action === "rate_plan.update");
    expect(upd?.before).toEqual({ cancelPolicy: plan.cancelPolicy });
    expect(upd?.after).toEqual({ cancelPolicy: good });
  });

  test("deposit mode needs depositPct 1..99", async () => {
    const { db, plan, owner } = await setup();
    for (const depositPct of [0, 100, -5, 30.5]) {
      expect(await updateRatePlan(db, owner, plan.id, { paymentMode: "deposit", depositPct }, NOW))
        .toEqual({ ok: false, error: "INVALID_INPUT", field: "depositPct" });
    }
    // Switching to deposit without a pct fails against the stored 0; with one it works.
    expect(await updateRatePlan(db, owner, plan.id, { paymentMode: "deposit" }, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "depositPct" });
    expect(await updateRatePlan(db, owner, plan.id, { paymentMode: "deposit", depositPct: 30 }, NOW)).toEqual({ ok: true });
    // Changing only the pct of a deposit plan is checked too.
    expect(await updateRatePlan(db, owner, plan.id, { depositPct: 0 }, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "depositPct" });
    expect(await updateRatePlan(db, owner, plan.id, { paymentMode: "bogus" } as never, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "paymentMode" });
  });

  test("name needs four languages; flags are booleans; smRatePlanCode (and any other field) cannot be set", async () => {
    const { db, plan, owner } = await setup();
    expect(await updateRatePlan(db, owner, plan.id, { name: { ...t("n"), ja: "" } }, NOW)).toEqual({ ok: false, error: "I18N_INCOMPLETE", field: "name" });
    expect(await updateRatePlan(db, owner, plan.id, { includesBreakfast: "yes" } as never, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "includesBreakfast" });
    expect(await updateRatePlan(db, owner, plan.id, { smRatePlanCode: "HACK" } as never, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "smRatePlanCode" });
    expect(await updateRatePlan(db, owner, plan.id, { slug: "x" } as never, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "slug" });
    expect(await updateRatePlan(db, owner, plan.id, { name: t("新"), includesBreakfast: true, directOnly: false, active: false }, NOW)).toEqual({ ok: true });
    expect((await db.select().from(ratePlans).where(eq(ratePlans.id, plan.id)))[0])
      .toMatchObject({ name: t("新"), includesBreakfast: true, directOnly: false, active: false, smRatePlanCode: plan.smRatePlanCode });
  });
});

describe("property settings", () => {
  test("edits name/address/phone/email/times/directions, with audit", async () => {
    const { db, propertyId, owner, audits } = await setup();
    const patch = { name: t("館"), address: t("址"), phone: "+886 2 0000 0000", email: "a@b.test", checkInTime: "14:30", checkOutTime: "10:00", directions: t("路") };
    expect(await updateProperty(db, owner, propertyId, patch, NOW)).toEqual({ ok: true });
    expect((await db.select().from(properties).where(eq(properties.id, propertyId)))[0]).toMatchObject(patch);
    const upd = (await audits(propertyId)).find((x) => x.action === "property.update");
    expect(upd?.after).toEqual(patch);
  });

  test("times must be HH:MM; each I18n field needs four languages; contact fields must look right", async () => {
    const { db, propertyId, owner } = await setup();
    for (const checkInTime of ["3pm", "24:00", "15:60", "9:00", "15:00:00", ""]) {
      expect(await updateProperty(db, owner, propertyId, { checkInTime }, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "checkInTime" });
    }
    expect(await updateProperty(db, owner, propertyId, { directions: { ...t("d"), en: "" } }, NOW)).toEqual({ ok: false, error: "I18N_INCOMPLETE", field: "directions" });
    expect(await updateProperty(db, owner, propertyId, { address: { ...t("d"), ko: " " } }, NOW)).toEqual({ ok: false, error: "I18N_INCOMPLETE", field: "address" });
    expect(await updateProperty(db, owner, propertyId, { email: "nope" }, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "email" });
    expect(await updateProperty(db, owner, propertyId, { phone: "  " }, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: "phone" });
  });

  test("sinopacMerchantId and smPropertyCode are read-only", async () => {
    const { db, propertyId, owner } = await setup();
    for (const f of ["sinopacMerchantId", "smPropertyCode", "slug", "timezone", "currency"]) {
      expect(await updateProperty(db, owner, propertyId, { [f]: "X" } as never, NOW)).toEqual({ ok: false, error: "INVALID_INPUT", field: f });
    }
    expect((await db.select().from(properties).where(eq(properties.id, propertyId)))[0]).toMatchObject({ sinopacMerchantId: null, smPropertyCode: "NKHOSTEL" });
  });

  test("the pre-arrival email uses the saved times and directions", async () => {
    const { db, propertyId, owner, book, deps } = await setup();
    await updateProperty(db, owner, propertyId, { checkInTime: "14:30", checkOutTime: "10:00", directions: t("轉角") }, NOW);
    const code = await book();
    const [res] = await db.select().from(reservations).where(eq(reservations.code, code));
    const { data } = await emailContext(deps, res.id, "en");
    expect(data.arrival).toEqual({ checkIn: "14:30", checkOut: "10:00", directions: "轉角-en" });
  });
});

describe("seed", () => {
  test("the seeded property has the 15:00 / 11:00 defaults and directions", async () => {
    const { db, propertyId } = await setup();
    const [p] = await db.select().from(properties).where(and(eq(properties.id, propertyId)));
    expect(p).toMatchObject({ checkInTime: "15:00", checkOutTime: "11:00" });
    expect(p.directions.en).toContain("Nanjing Sanmin");
  });
});
