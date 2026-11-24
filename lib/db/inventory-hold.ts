import { and, eq, inArray, sql } from "drizzle-orm";
import type { ISODate } from "@/lib/domain/dates";
import { runAtomic } from "./atomic";
import { ariDaily } from "./schema";
import type { Db } from "./types";

export type HoldItem = { unitTypeId: string; ratePlanId: string; nights: ISODate[]; rooms: number };

const key = (i: HoldItem, d: ISODate) => and(eq(ariDaily.unitTypeId, i.unitTypeId), eq(ariDaily.ratePlanId, i.ratePlanId), eq(ariDaily.date, d));

/**
 * Decrement local inventory for every night, all-or-nothing.
 * A night that is sold out or stop-sold is driven to -1, which violates the
 * `available >= 0` CHECK and rolls the whole batch back — atomic on D1 too.
 */
export async function holdInventory(db: Db, items: HoldItem[]): Promise<{ ok: true } | { ok: false; error: "SOLD_OUT" }> {
  // Rows are never deleted, so a missing row checked here stays missing.
  for (const i of items) {
    const rows = await db.select({ date: ariDaily.date }).from(ariDaily)
      .where(and(eq(ariDaily.unitTypeId, i.unitTypeId), eq(ariDaily.ratePlanId, i.ratePlanId), inArray(ariDaily.date, i.nights)));
    if (rows.length !== new Set(i.nights).size) return { ok: false, error: "SOLD_OUT" };
  }
  const stmts = items.flatMap((i) =>
    i.nights.map((d) =>
      db.update(ariDaily)
        .set({
          available: sql`CASE WHEN ${ariDaily.available} >= ${i.rooms} AND ${ariDaily.stopSell} = 0 THEN ${ariDaily.available} - ${i.rooms} ELSE -1 END`,
          source: "local",
        })
        .where(key(i, d)),
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
  await runAtomic(db, items.flatMap((i) => i.nights.map((d) =>
    db.update(ariDaily).set({ available: sql`${ariDaily.available} + ${i.rooms}`, source: "local" }).where(key(i, d)))));
}

/** Drizzle and D1 wrap the SQLite error; look through the cause chain. */
function isCheckViolation(e: unknown): boolean {
  for (let cur = e as { message?: string; cause?: unknown } | undefined, n = 0; cur && n < 5; cur = cur.cause as typeof cur, n++)
    if (String(cur.message ?? cur).includes("CHECK constraint failed")) return true;
  return false;
}
