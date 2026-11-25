import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { guests, payments, reservations } from "@/lib/db/schema";
import { seedNk } from "@/lib/db/seed-nk";
import { createTestDb, rawSqlite } from "../helpers/test-db";

const dir = path.resolve(__dirname, "../../drizzle/migrations");

test("the settled_at migration dates refunds already succeeded by their createdAt, and only those (M-6)", async () => {
  const db = createTestDb();
  const { propertyId } = await seedNk(db);
  await db.insert(guests).values({ id: "g", propertyId, firstName: "M", lastName: "L", email: "m@x.com", phone: "1", country: "TW", locale: "en", createdAt: 0 });
  await db.insert(reservations).values({
    id: "r", propertyId, code: "C-r", guestId: "g", status: "cancelled", channel: "direct", checkIn: "2026-12-10", checkOut: "2026-12-11",
    adults: 1, children: 0, locale: "en", quote: {}, totalAmount: 1000, syncState: "synced", guestEmailLower: "m@x.com", createdAt: 0, updatedAt: 0,
  });
  const row = (id: string, kind: "charge" | "refund", status: "succeeded" | "pending" | "failed") =>
    ({ id, reservationId: "r", kind, method: "sinopac_online" as const, amount: 100, status, createdAt: 1000 + id.length });
  await db.insert(payments).values([row("ok", "refund", "succeeded"), row("wait", "refund", "pending"), row("no", "refund", "failed"), row("chg", "charge", "succeeded")]);
  // As they were before the column existed.
  rawSqlite(db).exec("update payments set settled_at = null");

  const file = readdirSync(dir).find((f) => /^0021_.*\.sql$/.test(f))!;
  const [, ...data] = readFileSync(path.join(dir, file), "utf8").split("--> statement-breakpoint");
  for (const stmt of data) rawSqlite(db).exec(stmt);

  const at = async (id: string) => (await db.select().from(payments).where(eq(payments.id, id)))[0].settledAt;
  expect(await at("ok")).toBe(1002);
  expect(await at("wait")).toBeNull();
  expect(await at("no")).toBeNull();
  expect(await at("chg")).toBeNull();
});
