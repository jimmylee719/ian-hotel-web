import { and, eq, inArray, sql } from "drizzle-orm";
import type { ISODate } from "@/lib/domain/dates";
import { runAtomic } from "./atomic";
import { ariDaily, inventoryDaily } from "./schema";
import type { Db } from "./types";

/** Inventory is per room type; the rate plan is only used to honour its stop-sell. */
export type HoldItem = { unitTypeId: string; ratePlanId: string; nights: ISODate[]; rooms: number };

/** Programming errors, not sold-out: rooms must be a positive integer and nights unique. */
function assertValid(items: HoldItem[]): void {
  for (const i of items)
    if (!Number.isInteger(i.rooms) || i.rooms <= 0 || new Set(i.nights).size !== i.nights.length) throw new Error("INVALID_HOLD");
}

const invKey = (i: HoldItem, d: ISODate) => and(eq(inventoryDaily.unitTypeId, i.unitTypeId), eq(inventoryDaily.date, d));

/**
 * Decrement inventory for every night, all-or-nothing.
 * A night that is sold out or stop-sold for the plan is driven to -1, which violates the
 * `available >= 0` CHECK and rolls the whole batch back — atomic on D1 too.
 */
export async function holdInventory(db: Db, items: HoldItem[]): Promise<{ ok: true } | { ok: false; error: "SOLD_OUT" }> {
  assertValid(items);
  // Rows are never deleted, so a missing row checked here stays missing.
  for (const i of items) {
    const rows = await db.select({ date: inventoryDaily.date }).from(inventoryDaily)
      .where(and(eq(inventoryDaily.unitTypeId, i.unitTypeId), inArray(inventoryDaily.date, i.nights)));
    if (rows.length !== new Set(i.nights).size) return { ok: false, error: "SOLD_OUT" };
  }
  const stmts = items.flatMap((i) =>
    i.nights.map((d) =>
      db.update(inventoryDaily)
        .set({
          available: sql`CASE WHEN ${inventoryDaily.available} >= ${i.rooms} AND NOT EXISTS (
            SELECT 1 FROM ${ariDaily} WHERE ${ariDaily.unitTypeId} = ${i.unitTypeId}
              AND ${ariDaily.ratePlanId} = ${i.ratePlanId} AND ${ariDaily.date} = ${d} AND ${ariDaily.stopSell} = 1
          ) THEN ${inventoryDaily.available} - ${i.rooms} ELSE -1 END`,
          source: "local",
        })
        .where(invKey(i, d)),
    ),
  );
  try {
    await runAtomic(db, stmts);
    return { ok: true };
  } catch (e) {
    if (isCheckViolation(e)) return { ok: false, error: "SOLD_OUT" };
    throw e;
  }
}

export async function releaseInventory(db: Db, items: HoldItem[]): Promise<void> {
  assertValid(items);
  await runAtomic(db, items.flatMap((i) => i.nights.map((d) =>
    db.update(inventoryDaily).set({ available: sql`${inventoryDaily.available} + ${i.rooms}`, source: "local" }).where(invKey(i, d)))));
}

/** Drizzle and D1 wrap the SQLite error; look through the cause chain. */
function isCheckViolation(e: unknown): boolean {
  for (let cur = e as { message?: string; cause?: unknown } | undefined, n = 0; cur && n < 5; cur = cur.cause as typeof cur, n++)
    if (String(cur.message ?? cur).includes("CHECK constraint failed")) return true;
  return false;
}
