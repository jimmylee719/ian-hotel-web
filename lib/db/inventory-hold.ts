import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { ISODate } from "@/lib/domain/dates";
import { runAtomic, type Runnable } from "./atomic";
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
 * Build the all-or-nothing decrement statements for a hold, to run in a `runAtomic` batch
 * (alone, or together with other writes). Returns null when a night has no inventory row.
 * A night that is sold out or stop-sold for the plan is driven to -1, which violates the
 * `available >= 0` CHECK and rolls the whole batch back — atomic on D1 too.
 * `guard`, when given, is added to every statement's WHERE: while it is false the statements change nothing
 * (and so never trip the CHECK), which lets a guarded batch skip its hold as a whole.
 */
export async function holdStatements(db: Db, items: HoldItem[], guard?: SQL): Promise<Runnable[] | null> {
  assertValid(items);
  // Rows are never deleted, so a missing row checked here stays missing.
  for (const i of items) {
    const rows = await db.select({ date: inventoryDaily.date }).from(inventoryDaily)
      .where(and(eq(inventoryDaily.unitTypeId, i.unitTypeId), inArray(inventoryDaily.date, i.nights)));
    if (rows.length !== new Set(i.nights).size) return null;
  }
  return items.flatMap((i) =>
    i.nights.map((d) =>
      db.update(inventoryDaily)
        .set({
          available: sql`CASE WHEN ${inventoryDaily.available} >= ${i.rooms} AND NOT EXISTS (
            SELECT 1 FROM ${ariDaily} WHERE ${ariDaily.unitTypeId} = ${i.unitTypeId}
              AND ${ariDaily.ratePlanId} = ${i.ratePlanId} AND ${ariDaily.date} = ${d} AND ${ariDaily.stopSell} = 1
          ) THEN ${inventoryDaily.available} - ${i.rooms} ELSE -1 END`,
          source: "local",
        })
        .where(and(invKey(i, d), guard)),
    ),
  );
}

/** Decrement inventory for every night, all-or-nothing. */
export async function holdInventory(db: Db, items: HoldItem[]): Promise<{ ok: true } | { ok: false; error: "SOLD_OUT" }> {
  const stmts = await holdStatements(db, items);
  if (!stmts) return { ok: false, error: "SOLD_OUT" };
  try {
    await runAtomic(db, stmts);
    return { ok: true };
  } catch (e) {
    if (isCheckViolation(e)) return { ok: false, error: "SOLD_OUT" };
    throw e;
  }
}

export async function releaseInventory(db: Db, items: HoldItem[]): Promise<void> {
  await runAtomic(db, releaseStatements(db, items));
}

/** The increment statements that give a hold back, to run in a `runAtomic` batch; `guard` as in holdStatements. */
export function releaseStatements(db: Db, items: HoldItem[], guard?: SQL): Runnable[] {
  assertValid(items);
  return items.flatMap((i) => i.nights.map((d) =>
    db.update(inventoryDaily).set({ available: sql`${inventoryDaily.available} + ${i.rooms}`, source: "local" })
      .where(and(invKey(i, d), guard))));
}

/** Drizzle and D1 wrap the SQLite error; look through the cause chain. */
export function hasSqliteError(e: unknown, text: string): boolean {
  for (let cur = e as { message?: string; cause?: unknown } | undefined, n = 0; cur && n < 5; cur = cur.cause as typeof cur, n++)
    if (String(cur.message ?? cur).includes(text)) return true;
  return false;
}

export const isCheckViolation = (e: unknown) => hasSqliteError(e, "CHECK constraint failed");
