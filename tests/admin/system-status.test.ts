import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { getSystemStatus } from "@/lib/admin/system-status";
import { jobRuns, paymentEvents, properties, reservations, type I18n } from "@/lib/db/schema";
import { runCron } from "@/lib/jobs/cron";
import { bookingSetup, NOW } from "../helpers/booking";

const t = (s: string): I18n => ({ "zh-TW": s, en: s, ja: s, ko: s });
const H = 3_600_000;

/** Every value is a distinct marker string, so any leak shows up in the serialised status. */
const SECRET_ENV = {
  ENVIRONMENT: "production",
  PAYMENT_MODE: "pm-SECRET-0001",
  CHANNEL_MODE: "cm-SECRET-0002",
  MOCK_PAYMENT_SECRET: "mock-SECRET-0003",
  RESEND_API_KEY: "re_KEY-0004",
  EMAIL_FROM: "from-SECRET-0005@x.test",
  STAFF_EMAILS: "staff-SECRET-0006@x.test",
  BASE_URL: "https://base-SECRET-0007.test",
  CF_ACCESS_TEAM_DOMAIN: "team-SECRET-0008.cloudflareaccess.com",
  CF_ACCESS_AUD: "aud-TOKEN-0009",
  DEV_STAFF_EMAIL: "dev-SECRET-0010@x.test",
  SOME_OTHER_TOKEN: "other-TOKEN-0011",
};

describe("getSystemStatus", () => {
  test("never contains a secret value, only whether each one is set", async () => {
    const { db } = await bookingSetup();
    const status = await getSystemStatus(db, SECRET_ENV, { now: NOW });
    const json = JSON.stringify(status);
    for (const v of Object.values(SECRET_ENV).filter((v) => v !== "production")) expect(json).not.toContain(v);
    expect(status.settings).toContainEqual({ name: "RESEND_API_KEY", set: true });
    expect(status.settings).toContainEqual({ name: "MOCK_PAYMENT_SECRET", set: true });
    expect(status.settings).toContainEqual({ name: "CF_ACCESS_AUD", set: true });
    expect(status.accessConfigured).toBe(true);
    // Unknown mode values are not echoed either.
    expect(status.modes).toEqual({ ENVIRONMENT: "production", PAYMENT_MODE: "（不明的值）", CHANNEL_MODE: "（不明的值）" });
    expect(status.warnings).toContain("DEV_STAFF_EMAIL_SET_OUTSIDE_LOCAL");
  });

  test("reports unset settings, modes, sync states, 24h verdicts, the last cron run and migrations", async () => {
    const s = await bookingSetup();
    const { db, propertyId } = s;
    await db.insert(properties).values({
      id: "other", slug: "other", type: "hotel", name: t("o"), timezone: "Asia/Taipei", currency: "TWD", address: t("a"),
      phone: "1", email: "o@x.test", createdAt: 0,
    });
    const code = await s.book();
    await db.update(reservations).set({ syncState: "failed" }).where(eq(reservations.code, code));
    const ev = (id: string, verdict: "accepted" | "bad_signature", at: number, pid: string | null = propertyId) =>
      ({ id, propertyId: pid, provider: "mock", rawBody: "{}", verdict, at });
    await db.insert(paymentEvents).values([
      ev("e1", "accepted", NOW.getTime() - H), ev("e2", "bad_signature", NOW.getTime() - 2 * H),
      ev("e3", "bad_signature", NOW.getTime() - 25 * H), ev("e4", "accepted", NOW.getTime() - H, "other"),
      ev("e5", "bad_signature", NOW.getTime() - H, null),
    ]);
    await db.insert(jobRuns).values([
      { name: "cron", startedAt: NOW.getTime() - 10 * 60_000, finishedAt: NOW.getTime() - 10 * 60_000 + 50, result: { expired: 0 } },
      { name: "cron", startedAt: NOW.getTime() - 5 * 60_000, finishedAt: NOW.getTime() - 5 * 60_000 + 80, result: { expired: 2 } },
    ]);

    const status = await getSystemStatus(db, { ENVIRONMENT: "local", PAYMENT_MODE: "mock", CHANNEL_MODE: "mock" }, { now: NOW, propertyIds: [propertyId] });
    expect(status.modes).toEqual({ ENVIRONMENT: "local", PAYMENT_MODE: "mock", CHANNEL_MODE: "mock" });
    expect(status.accessConfigured).toBe(false);
    expect(status.settings).toContainEqual({ name: "BASE_URL", set: false });
    expect(status.bookingDisabledReason).toBeNull();
    expect(status.syncStates).toEqual(expect.objectContaining({ failed: 1 }));
    // Own property's events, plus events matching no property (unknown reservations); 24 hours only.
    expect(status.paymentVerdicts24h).toEqual({ accepted: 1, bad_signature: 2 });
    expect(status.lastJobRun).toMatchObject({ name: "cron", startedAt: NOW.getTime() - 5 * 60_000, result: { expired: 2 } });
    expect(status.migrations.applied).toBeGreaterThan(0);
    expect(status.migrations.applied).toBe(status.migrations.expected);
    expect(status.migrations.latest).toBe(status.migrations.expectedLatest);
  });
});

describe("cron job_runs", () => {
  test("each cron run adds a job_runs row with its counts; rows older than 30 days are pruned", async () => {
    const { db } = await bookingSetup();
    await db.insert(jobRuns).values({ name: "cron", startedAt: NOW.getTime() - 31 * 24 * H, finishedAt: NOW.getTime() - 31 * 24 * H, result: {} });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCron({ ENVIRONMENT: "local", PAYMENT_MODE: "mock", CHANNEL_MODE: "mock" } as never, NOW, db);
    await runCron({ ENVIRONMENT: "local", PAYMENT_MODE: "mock", CHANNEL_MODE: "mock" } as never, new Date(NOW.getTime() + 300_000), db);
    log.mockRestore();
    const rows = await db.select().from(jobRuns);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "cron", startedAt: NOW.getTime(), result: { expired: 0, attempted: 0, preArrival: 0 } });
    expect(rows[0].finishedAt).toBeGreaterThanOrEqual(rows[0].startedAt);
  });
});
