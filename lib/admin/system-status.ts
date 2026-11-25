import { and, desc, gte, inArray, isNull, or, sql } from "drizzle-orm";
import journal from "@/drizzle/migrations/meta/_journal.json";
import { jobRuns, paymentEvents, reservations } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { bookingDisabledReason } from "@/lib/runtime/deps";
import type { AppEnv } from "@/lib/runtime/env";

/**
 * What /admin/system shows. It never carries a secret's value: settings are only "set or not", and the three
 * mode variables are echoed only when they hold one of their known values (anything else, which could be a
 * mistyped secret, shows as "unknown value").
 */

/** Vars and secrets reported as set / not set, never by value. */
export const SETTING_NAMES = [
  "BASE_URL", "CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "RESEND_API_KEY", "EMAIL_FROM", "STAFF_EMAILS", "OPS_EMAILS",
  "MOCK_PAYMENT_SECRET", "DEV_STAFF_EMAIL",
] as const satisfies readonly (keyof AppEnv)[];

const KNOWN_MODES = {
  ENVIRONMENT: ["local", "staging", "production"],
  PAYMENT_MODE: ["mock", "sinopac"],
  CHANNEL_MODE: ["mock", "siteminder"],
} as const;
type ModeName = keyof typeof KNOWN_MODES;

export const MODE_UNSET = "（未設定）";
export const MODE_UNKNOWN = "（不明的值）";

export type SystemWarning = "DEV_STAFF_EMAIL_LOCAL_BYPASS" | "DEV_STAFF_EMAIL_SET_OUTSIDE_LOCAL" | "ACCESS_NOT_CONFIGURED" | "MIGRATIONS_BEHIND";

export type SystemStatus = {
  modes: Record<ModeName, string>;
  settings: { name: (typeof SETTING_NAMES)[number]; set: boolean }[];
  accessConfigured: boolean;
  /** Why online booking is off (a reason code), or null when it is on. */
  bookingDisabledReason: string | null;
  lastJobRun: { name: string; startedAt: number; finishedAt: number; result: Record<string, unknown> } | null;
  syncStates: Record<string, number>;
  paymentVerdicts24h: Record<string, number>;
  migrations: { applied: number; latest: string | null; expected: number; expectedLatest: string };
  warnings: SystemWarning[];
};

const isSet = (v: unknown) => typeof v === "string" && v.trim() !== "";

function mode(env: AppEnv, name: ModeName): string {
  const v = env[name]?.trim();
  if (!v) return MODE_UNSET;
  return (KNOWN_MODES[name] as readonly string[]).includes(v) ? v : MODE_UNKNOWN;
}

const DAY = 86_400_000;

/**
 * The system's health at a glance. `propertyIds` limits the booking and payment counts to those properties
 * (payment events that matched no booking have no property and are always counted); omit it for all.
 */
export async function getSystemStatus(
  db: Db, env: AppEnv, o: { now?: Date; propertyIds?: string[] } = {},
): Promise<SystemStatus> {
  const now = o.now ?? new Date();
  const accessConfigured = isSet(env.CF_ACCESS_TEAM_DOMAIN) && isSet(env.CF_ACCESS_AUD);
  const scope = o.propertyIds;

  const [last] = await db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt), desc(jobRuns.id)).limit(1);

  const syncRows = await db.select({ state: reservations.syncState, n: sql<number>`count(*)` }).from(reservations)
    .where(scope ? (scope.length ? inArray(reservations.propertyId, scope) : sql`0`) : undefined)
    .groupBy(reservations.syncState);

  const verdictRows = await db.select({ verdict: paymentEvents.verdict, n: sql<number>`count(*)` }).from(paymentEvents)
    .where(and(
      gte(paymentEvents.at, now.getTime() - DAY),
      scope ? or(isNull(paymentEvents.propertyId), scope.length ? inArray(paymentEvents.propertyId, scope) : sql`0`) : undefined,
    ))
    .groupBy(paymentEvents.verdict);

  const migrations = await migrationState(db);
  const warnings: SystemWarning[] = [];
  // Local: DEV_STAFF_EMAIL is in effect, so Access is bypassed (lib/admin/auth.ts). Elsewhere it is ignored but must not exist.
  if (isSet(env.DEV_STAFF_EMAIL)) warnings.push(env.ENVIRONMENT === "local" ? "DEV_STAFF_EMAIL_LOCAL_BYPASS" : "DEV_STAFF_EMAIL_SET_OUTSIDE_LOCAL");
  if (!accessConfigured && env.ENVIRONMENT !== "local") warnings.push("ACCESS_NOT_CONFIGURED");
  if (migrations.applied < migrations.expected) warnings.push("MIGRATIONS_BEHIND");

  return {
    modes: { ENVIRONMENT: mode(env, "ENVIRONMENT"), PAYMENT_MODE: mode(env, "PAYMENT_MODE"), CHANNEL_MODE: mode(env, "CHANNEL_MODE") },
    settings: SETTING_NAMES.map((name) => ({ name, set: isSet(env[name]) })),
    accessConfigured,
    bookingDisabledReason: bookingDisabledReason(env),
    lastJobRun: last ? { name: last.name, startedAt: last.startedAt, finishedAt: last.finishedAt, result: last.result } : null,
    syncStates: Object.fromEntries(syncRows.map((r) => [r.state, r.n])),
    paymentVerdicts24h: Object.fromEntries(verdictRows.map((r) => [r.verdict, r.n])),
    migrations,
    warnings,
  };
}

/**
 * Applied migrations, from wrangler's `d1_migrations` (D1, local or remote) or drizzle's `__drizzle_migrations`
 * (tests), against the migrations this build ships (drizzle/migrations/meta/_journal.json).
 */
async function migrationState(db: Db): Promise<SystemStatus["migrations"]> {
  const entries = journal.entries;
  const expectedLatest = entries[entries.length - 1].tag;
  const base = { expected: entries.length, expectedLatest };
  const tables = (await db.all<{ name: string }>(
    sql`select name from sqlite_master where type = 'table' and name in ('d1_migrations', '__drizzle_migrations')`,
  )).map((r) => r.name);
  if (tables.includes("d1_migrations")) {
    const [r] = await db.all<{ n: number; latest: string | null }>(
      sql`select count(*) as n, (select name from d1_migrations order by id desc limit 1) as latest from d1_migrations`,
    );
    return { ...base, applied: r.n, latest: r.latest ? r.latest.replace(/\.sql$/, "") : null };
  }
  if (tables.includes("__drizzle_migrations")) {
    const [r] = await db.all<{ n: number; at: number | null }>(
      sql`select count(*) as n, max(created_at) as at from __drizzle_migrations`,
    );
    return { ...base, applied: r.n, latest: entries.find((e) => e.when === Number(r.at))?.tag ?? null };
  }
  return { ...base, applied: 0, latest: null };
}
