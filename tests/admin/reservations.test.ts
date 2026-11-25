import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { AdminAuthError, type StaffContext } from "@/lib/admin/auth";
import { addReservationNote, getReservationDetail, listReservations, NoteError } from "@/lib/admin/reservations";
import {
  auditLog, guests, notifications, paymentEvents, payments, properties, ratePlans, reservationNotes, reservationRooms,
  reservations, staff, unitTypes,
} from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import type { Db } from "@/lib/db/types";
import { createTestDb } from "../helpers/test-db";

const NOW = new Date("2026-11-24T02:00:00Z");
const T = (n: number) => NOW.getTime() + n * 60_000;

async function setup() {
  const tdb = createTestDb();
  const db = tdb as unknown as Db;
  const { propertyId } = await seedNk(tdb);
  const [{ id: unitTypeId }] = await db.select({ id: unitTypes.id }).from(unitTypes).where(eq(unitTypes.slug, "mixed-cube"));
  const [{ id: ratePlanId }] = await db.select({ id: ratePlans.id }).from(ratePlans).limit(1);
  const otherId = "prop-other";
  await db.insert(properties).values({
    id: otherId, slug: "other", type: "hotel", name: { "zh-TW": "他館", en: "O", ja: "O", ko: "O" },
    timezone: "Asia/Taipei", currency: "TWD", address: { "zh-TW": "a", en: "a", ja: "a", ko: "a" }, phone: "1", email: "o@x.com", createdAt: 0,
  });
  let n = 0;
  const res = async (
    id: string, o: { code?: string; first?: string; last?: string; email?: string; phone?: string; pid?: string } & Partial<typeof reservations.$inferInsert> = {},
  ) => {
    const { code, first, last, email, phone, pid = propertyId, ...over } = o;
    const gid = `g${++n}`;
    const mail = email ?? `${id}@x.com`;
    await db.insert(guests).values({ id: gid, propertyId: pid, firstName: first ?? "Mei", lastName: last ?? `L${n}`, email: mail, phone: phone ?? "0912-000-111", country: "TW", locale: "en", createdAt: 0 });
    await db.insert(reservations).values({
      id, propertyId: pid, code: code ?? `C-${id}`, guestId: gid, status: "confirmed", channel: "direct",
      checkIn: "2026-12-01", checkOut: "2026-12-03", adults: 2, children: 0, locale: "en", quote: { total: 4000 }, totalAmount: 4000,
      syncState: "synced", guestEmailLower: mail.toLowerCase(), createdAt: T(n), updatedAt: T(n), ...over,
    });
    await db.insert(reservationRooms).values({ id: `${id}-r`, reservationId: id, unitTypeId, ratePlanId, nightlyPrices: [2000, 2000] });
  };
  const pay = (id: string, reservationId: string, kind: "charge" | "refund" | "front_desk", amount: number, createdAt: number, status: "succeeded" | "pending" | "failed" = "succeeded") =>
    db.insert(payments).values({ id, reservationId, kind, method: "edc", amount, status, createdAt, last4: "4242", authCode: "A1" });
  const staffRow = { id: "s1", email: "fd@nk.com", name: "FD", role: "front_desk" as const, propertyIds: [propertyId], active: true };
  await db.insert(staff).values(staffRow);
  const ctx: StaffContext = { staff: staffRow, email: staffRow.email };
  return { db, tdb, propertyId, otherId, res, pay, ctx, staffRow, unitTypeId };
}

const base = { page: 1, pageSize: 20 };

describe("listReservations", () => {
  it("finds a code case-insensitively, and by last name, email and phone", async () => {
    const { db, propertyId, res } = await setup();
    await res("a", { code: "NK-ABC234", last: "Chen", email: "Amy.Wu@Example.com", phone: "0933-555-777" });
    await res("b", { code: "NK-ZZZ999", last: "Lin" });
    const ids = async (q: string) => (await listReservations(db, propertyId, { ...base, q })).rows.map((r) => r.id);
    expect(await ids("nk-abc")).toEqual(["a"]);
    expect(await ids("CHEN")).toEqual(["a"]);
    expect(await ids("amy.wu@example")).toEqual(["a"]);
    expect(await ids("555-777")).toEqual(["a"]);
    expect(await ids("Mei Lin")).toEqual(["b"]);
    expect(await ids("nobody")).toEqual([]);
  });

  it("treats % and _ in the search as literal characters", async () => {
    const { db, propertyId, res } = await setup();
    await res("a", { code: "NK-ABC234" });
    await res("b", { code: "NK-A_C234", last: "Under_score" });
    const ids = async (q: string) => (await listReservations(db, propertyId, { ...base, q })).rows.map((r) => r.id);
    expect(await ids("%")).toEqual([]);
    expect(await ids("A_C")).toEqual(["b"]);
    expect(await ids("N%C")).toEqual([]);
  });

  it("filters by status plus a check-in range (inclusive), and by sync state", async () => {
    const { db, propertyId, res } = await setup();
    await res("in", { checkIn: "2026-12-05", checkOut: "2026-12-06" });
    await res("edge", { checkIn: "2026-12-10", checkOut: "2026-12-11" });
    await res("early", { checkIn: "2026-11-30", checkOut: "2026-12-01" });
    await res("late", { checkIn: "2026-12-11", checkOut: "2026-12-12" });
    await res("cx", { checkIn: "2026-12-06", checkOut: "2026-12-07", status: "cancelled" });
    await res("fail", { checkIn: "2026-12-07", checkOut: "2026-12-08", syncState: "failed" });
    const f = { ...base, status: ["confirmed" as const], from: "2026-12-01", to: "2026-12-10", dateField: "checkIn" as const, sort: "checkIn" as const };
    expect((await listReservations(db, propertyId, f)).rows.map((r) => r.id)).toEqual(["in", "fail", "edge"]);
    expect((await listReservations(db, propertyId, { ...f, syncState: ["failed"] })).rows.map((r) => r.id)).toEqual(["fail"]);
  });

  it("filters by created-at date in Taipei time", async () => {
    const { db, propertyId, res } = await setup();
    await res("a", { createdAt: Date.parse("2026-11-23T15:59:00Z") }); // 11-23 23:59 Taipei
    await res("b", { createdAt: Date.parse("2026-11-23T16:00:00Z") }); // 11-24 00:00 Taipei
    await res("c", { createdAt: Date.parse("2026-11-24T15:59:00Z") }); // 11-24 23:59 Taipei
    await res("d", { createdAt: Date.parse("2026-11-24T16:00:00Z") }); // 11-25 00:00 Taipei
    const r = await listReservations(db, propertyId, { ...base, dateField: "createdAt", from: "2026-11-24", to: "2026-11-24" });
    expect(r.rows.map((x) => x.id).sort()).toEqual(["b", "c"]);
  });

  it("never shows another property's reservations, in rows or total", async () => {
    const { db, propertyId, otherId, res } = await setup();
    await res("mine");
    await res("theirs", { pid: otherId, code: "NK-ABC234" });
    const all = await listReservations(db, propertyId, base);
    expect(all.rows.map((r) => r.id)).toEqual(["mine"]);
    expect(all.total).toBe(1);
    expect((await listReservations(db, propertyId, { ...base, q: "nk-abc" })).total).toBe(0);
  });

  it("computes nights, room name, and money columns (balanceDue = total - net received)", async () => {
    const { db, propertyId, res, pay } = await setup();
    await res("a", { totalAmount: 4000 });
    await pay("p1", "a", "charge", 2000, T(1));
    await pay("p2", "a", "front_desk", 1500, T(2));
    await pay("p3", "a", "refund", 500, T(3));
    await pay("p4", "a", "charge", 999, T(4), "failed");
    await pay("p5", "a", "charge", 999, T(5), "pending");
    const [row] = (await listReservations(db, propertyId, base)).rows;
    expect(row).toMatchObject({
      id: "a", code: "C-a", status: "confirmed", syncState: "synced", checkIn: "2026-12-01", checkOut: "2026-12-03", nights: 2,
      roomName: "男.女混合雙人旅艙", guestName: "Mei L1", total: 4000, paid: 3000, refunded: 500, balanceDue: 1000,
    });
    expect(typeof row.createdAt).toBe("number");
  });

  it("sorts and paginates", async () => {
    const { db, propertyId, res } = await setup();
    await res("a", { checkIn: "2026-12-03", checkOut: "2026-12-04" });
    await res("b", { checkIn: "2026-12-01", checkOut: "2026-12-02" });
    await res("c", { checkIn: "2026-12-02", checkOut: "2026-12-03" });
    expect((await listReservations(db, propertyId, { ...base, sort: "checkIn" })).rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect((await listReservations(db, propertyId, base)).rows.map((r) => r.id)).toEqual(["c", "b", "a"]); // newest first by default
    const p2 = await listReservations(db, propertyId, { page: 2, pageSize: 2, sort: "checkIn" });
    expect(p2.rows.map((r) => r.id)).toEqual(["a"]);
    expect(p2).toMatchObject({ total: 3, page: 2, pageCount: 2 });
  });
});

describe("getReservationDetail", () => {
  it("returns null for another property's reservation or an unknown id", async () => {
    const { db, propertyId, otherId, res } = await setup();
    await res("theirs", { pid: otherId });
    expect(await getReservationDetail(db, propertyId, "theirs")).toBeNull();
    expect(await getReservationDetail(db, propertyId, "nope")).toBeNull();
    expect(await getReservationDetail(db, otherId, "theirs")).not.toBeNull();
  });

  it("merges payments, events, notifications and audit into one time-ordered timeline, without raw bodies", async () => {
    const { db, propertyId, otherId, res, pay, ctx } = await setup();
    await res("a", { code: "NK-ABC234", quote: { total: 4000, nights: 2 } });
    await res("b", { code: "NK-OTHER1" });
    const SECRET = "card=4111111111111111&sig=SECRETSIG";
    await pay("p1", "a", "charge", 4000, T(10));
    await pay("pb", "b", "charge", 100, T(11));
    await db.insert(paymentEvents).values([
      { id: "e1", propertyId, provider: "sinopac", providerRef: "REF1", reservationCode: "NK-ABC234", rawBody: SECRET, verdict: "accepted", at: T(5) },
      { id: "e2", propertyId, provider: "sinopac", providerRef: "REF2", reservationCode: "NK-OTHER1", rawBody: "x", verdict: "accepted", at: T(6) },
      { id: "e3", propertyId: otherId, provider: "sinopac", providerRef: "REF3", reservationCode: "NK-ABC234", rawBody: "x", verdict: "accepted", at: T(7) },
    ]);
    await db.insert(notifications).values([
      { id: "n1", propertyId, reservationId: "a", kind: "booking_confirmed", to: "g@x.com", status: "sent", at: T(20) },
      { id: "n2", propertyId, reservationId: "b", kind: "booking_confirmed", to: "g@x.com", status: "sent", at: T(21) },
    ]);
    await db.insert(auditLog).values([
      { id: "u1", staffEmail: "fd@nk.com", action: "reservation.cancel", entity: "reservation", entityId: "a", at: T(30) },
      { id: "u2", staffEmail: "fd@nk.com", action: "payment.front_desk", entity: "payment", entityId: "p1", at: T(25) },
      { id: "u3", staffEmail: "fd@nk.com", action: "reservation.cancel", entity: "reservation", entityId: "b", at: T(31) },
      { id: "u4", staffEmail: "fd@nk.com", action: "payment.front_desk", entity: "payment", entityId: "pb", at: T(32) },
    ]);
    await addReservationNote(db, ctx, "a", "  call guest back  ", new Date(T(15)));

    const d = (await getReservationDetail(db, propertyId, "a"))!;
    expect(d.timeline.map((t) => `${t.type}:${t.id}`)).toEqual([
      "event:e1", "payment:p1", expect.stringMatching(/^note:/), "notification:n1", "audit:u2", "audit:u1",
    ]);
    expect(d.timeline.map((t) => t.at)).toEqual([...d.timeline.map((t) => t.at)].sort((x, y) => x - y));
    expect(d.events).toHaveLength(1);
    expect(d.events[0]).toMatchObject({ id: "e1", verdict: "accepted", bodyLength: SECRET.length });
    expect(JSON.stringify(d)).not.toContain("SECRETSIG");
    expect(JSON.stringify(d)).not.toContain("rawBody");
    expect(d.payments[0]).toMatchObject({ kind: "charge", method: "edc", status: "succeeded", amount: 4000, last4: "4242", authCode: "A1" });
    expect(d.payments[0]).toHaveProperty("idempotencyKey");
    expect(d.notes[0]).toMatchObject({ body: "call guest back", staffEmail: "fd@nk.com" });
    expect(d.quote).toEqual({ total: 4000, nights: 2 });
    expect(d.rooms[0]).toMatchObject({ unitTypeName: "男.女混合雙人旅艙" });
    expect(d.guest).toMatchObject({ name: "Mei L1", email: "a@x.com" });
  });

  it("reports money: paid, refunded, balance due", async () => {
    const { db, propertyId, res, pay } = await setup();
    await res("a", { totalAmount: 4000 });
    await pay("p1", "a", "charge", 3000, T(1));
    await pay("p2", "a", "refund", 1000, T(2));
    const d = (await getReservationDetail(db, propertyId, "a"))!;
    expect(d.money).toEqual({ paid: 2000, refunded: 1000, balanceDue: 2000, grossReceived: 3000 });
  });

  it("shows the same paid and balanceDue as the list row, including for a closed booking", async () => {
    const { db, propertyId, res, pay } = await setup();
    await res("open", { totalAmount: 4000 });
    await pay("p1", "open", "charge", 3000, T(1));
    await pay("p2", "open", "refund", 1000, T(2));
    await res("closed", { totalAmount: 4000, status: "cancelled" });
    await pay("p3", "closed", "charge", 4000, T(3));
    await pay("p4", "closed", "refund", 4000, T(4));
    const rows = new Map((await listReservations(db, propertyId, base)).rows.map((r) => [r.id, r]));
    for (const id of ["open", "closed"]) {
      const d = (await getReservationDetail(db, propertyId, id))!;
      expect({ paid: rows.get(id)!.paid, refunded: rows.get(id)!.refunded, balanceDue: rows.get(id)!.balanceDue })
        .toEqual({ paid: d.money.paid, refunded: d.money.refunded, balanceDue: d.money.balanceDue });
    }
    expect(rows.get("open")!.balanceDue).toBe(2000);
    expect(rows.get("closed")!.balanceDue).toBeNull();
  });
});

describe("addReservationNote", () => {
  it("rejects empty, whitespace-only and over-long bodies, writing nothing", async () => {
    const { db, tdb, res, ctx } = await setup();
    await res("a");
    for (const body of ["", "   \n ", "x".repeat(2001)]) {
      await expect(addReservationNote(db, ctx, "a", body, NOW)).rejects.toBeInstanceOf(NoteError);
    }
    expect(tdb.select().from(reservationNotes).all()).toHaveLength(0);
    expect(tdb.select().from(auditLog).all()).toHaveLength(0);
    await expect(addReservationNote(db, ctx, "a", "x".repeat(2000), NOW)).resolves.toBeDefined();
  });

  it("trims, stores the note with its audit row, and shows it in the timeline", async () => {
    const { db, tdb, res, ctx, propertyId } = await setup();
    await res("a");
    const note = await addReservationNote(db, ctx, "a", "  VIP \n ", NOW);
    expect(note).toMatchObject({ reservationId: "a", propertyId, staffEmail: "fd@nk.com", body: "VIP", createdAt: NOW.getTime() });
    const logs = tdb.select().from(auditLog).all();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: "reservation.note", entity: "reservation_note", entityId: note.id, staffEmail: "fd@nk.com", at: NOW.getTime() });
    const d = (await getReservationDetail(db, propertyId, "a"))!;
    expect(d.timeline.filter((t) => t.type === "note")).toHaveLength(1);
    expect(d.timeline.filter((t) => t.type === "audit")).toHaveLength(0); // the note's own audit row is not shown twice
    expect(d.audit).toHaveLength(1);
  });

  it("requires reservations.view at that reservation's property", async () => {
    const { db, tdb, res, ctx, staffRow, otherId } = await setup();
    await res("a");
    await res("theirs", { pid: otherId });
    const marketing: StaffContext = { staff: { ...staffRow, role: "marketing" }, email: "m@nk.com" };
    await expect(addReservationNote(db, marketing, "a", "hi", NOW)).rejects.toBeInstanceOf(AdminAuthError);
    await expect(addReservationNote(db, ctx, "theirs", "hi", NOW)).rejects.toBeInstanceOf(AdminAuthError);
    await expect(addReservationNote(db, ctx, "missing", "hi", NOW)).rejects.toBeInstanceOf(NoteError);
    expect(tdb.select().from(reservationNotes).all()).toHaveLength(0);
  });

  it("is append-only: the module exposes no way to edit or delete a note", async () => {
    const mod = await import("@/lib/admin/reservations");
    expect(Object.keys(mod).filter((k) => /update|edit|delete|remove/i.test(k))).toEqual([]);
  });
});
