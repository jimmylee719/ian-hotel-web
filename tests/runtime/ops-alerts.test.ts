import { eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { jobRuns, opsAlerts } from "@/lib/db/schema";
import { MockEmailSender } from "@/lib/email/mock";
import { CRON_GATEWAY_RECONCILE, CRON_JOB, GATEWAY_RECONCILE_JOB, CRON_EVERY_5_MIN, recordJob, runCronTrigger } from "@/lib/jobs/cron";
import { CHANNEL_RECONCILE_JOB } from "@/lib/jobs/reconcile-channel";
import { CRON_FAILURE_STREAK, notifyOps, OPS_ALERT_WINDOW_MS, reconcileAlertDetail, type OpsDeps } from "@/lib/ops/alerts";
import { buildOpsDeps } from "@/lib/runtime/deps";
import { REDACTED } from "@/lib/runtime/redact";
import { createTestDb } from "@/tests/helpers/test-db";

const NOW = new Date("2026-11-28T02:00:00Z");
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

function ops(o: Partial<OpsDeps> = {}) {
  const email = new MockEmailSender();
  const deps: OpsDeps = { db: createTestDb(), email, opsEmails: ["ops@nk.test", "dev@nk.test"], environment: "production", ...o };
  return { ...deps, email: (o.email ?? email) as MockEmailSender, deps };
}

afterEach(() => vi.restoreAllMocks());

test("the same alert twice within an hour sends one email (brief); after an hour it sends again", async () => {
  const { deps, email } = ops({ opsEmails: ["ops@nk.test"] });
  expect(await notifyOps(deps, { kind: "cron_failed", detail: "boom" }, NOW)).toBe("sent");
  expect(await notifyOps(deps, { kind: "cron_failed", detail: "boom again" }, at(59))).toBe("duplicate");
  expect(email.sent).toHaveLength(1);
  expect(await notifyOps(deps, { kind: "cron_failed", detail: "still" }, new Date(NOW.getTime() + OPS_ALERT_WINDOW_MS))).toBe("sent");
  expect(email.sent).toHaveLength(2);
});

test("each kind (and scope) has its own hourly limit; every OPS_EMAILS address gets the email", async () => {
  const { deps, email } = ops();
  await notifyOps(deps, { kind: "cron_failed", scope: CRON_JOB, detail: "a" }, NOW);
  await notifyOps(deps, { kind: "cron_failed", scope: GATEWAY_RECONCILE_JOB, detail: "b" }, NOW);
  await notifyOps(deps, { kind: "reconcile_mismatch", scope: CHANNEL_RECONCILE_JOB, detail: "c" }, NOW);
  await notifyOps(deps, { kind: "ari_unknown_code", detail: "d" }, NOW);
  expect(email.sent).toHaveLength(8);
  expect(email.sent.map((e) => e.to).sort()).toEqual([...Array(4).fill("dev@nk.test"), ...Array(4).fill("ops@nk.test")]);
  expect(email.sent[0].subject).toContain("production");
  expect(email.sent[0].subject).toContain("cron_failed");
});

test("the detail goes through redact before it is emailed", async () => {
  const { deps, email } = ops({ opsEmails: ["ops@nk.test"] });
  await notifyOps(deps, { kind: "reconcile_mismatch", detail: "card 4111 1111 1111 1111 token=abc <b>" }, NOW);
  const [e] = email.sent;
  for (const body of [e.text, e.html]) {
    expect(body).not.toContain("4111");
    expect(body).not.toContain("abc");
    expect(body).toContain(REDACTED);
  }
  expect(e.html).toContain("&lt;b&gt;");
});

test("without OPS_EMAILS it logs and does nothing", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { deps, email, db } = ops({ opsEmails: [] });
  expect(await notifyOps(deps, { kind: "cron_failed", detail: "boom token=x" }, NOW)).toBe("no_recipients");
  expect(email.sent).toHaveLength(0);
  expect(await db.select().from(opsAlerts)).toHaveLength(0);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("OPS_EMAILS"));
  expect(warn.mock.calls.flat().join(" ")).not.toContain("token=x");
});

test("a refused send is recorded failed and still counts for the hour (no retry storm); notifyOps never throws", async () => {
  const { deps, email, db } = ops({ opsEmails: ["ops@nk.test"] });
  email.failNext = 1;
  expect(await notifyOps(deps, { kind: "cron_failed", detail: "x" }, NOW)).toBe("failed");
  expect((await db.select().from(opsAlerts))[0].status).toBe("failed");
  expect(await notifyOps(deps, { kind: "cron_failed", detail: "x" }, at(10))).toBe("duplicate");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const broken = { ...deps, db: { select: () => { throw new Error("db down"); } } } as unknown as OpsDeps;
  expect(await notifyOps(broken, { kind: "cron_failed", detail: "x" }, NOW)).toBe("failed");
  expect(error).toHaveBeenCalled();
});

test(`a cron job failing ${CRON_FAILURE_STREAK} times in a row emails ops once; a success in between resets the streak`, async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { deps, email, db } = ops({ opsEmails: ["ops@nk.test"] });
  const fail = async () => { throw new Error("gateway down: Authorization: Bearer sk_1"); };
  await recordJob(db, GATEWAY_RECONCILE_JOB, at(0), fail, deps);
  await recordJob(db, GATEWAY_RECONCILE_JOB, at(15), fail, deps);
  await recordJob(db, GATEWAY_RECONCILE_JOB, at(30), async () => ({ ok: 1 }), deps);
  await recordJob(db, GATEWAY_RECONCILE_JOB, at(45), fail, deps);
  await recordJob(db, GATEWAY_RECONCILE_JOB, at(60), fail, deps);
  expect(email.sent).toHaveLength(0);
  await recordJob(db, GATEWAY_RECONCILE_JOB, at(75), fail, deps);
  expect(email.sent).toHaveLength(1);
  expect(email.sent[0].subject).toContain(GATEWAY_RECONCILE_JOB);
  expect(email.sent[0].text).not.toContain("sk_1");
  // Another job's failures are counted separately.
  await recordJob(db, CHANNEL_RECONCILE_JOB, at(76), fail, deps);
  await recordJob(db, GATEWAY_RECONCILE_JOB, at(90), fail, deps); // same job, within the hour: no second email
  expect(email.sent).toHaveLength(1);
});

test("a refused config skips the cron, records it in job_runs and alerts ops (all three triggers)", async () => {
  const db = createTestDb();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const env = { ENVIRONMENT: "production", PAYMENT_MODE: "mock", CHANNEL_MODE: "mock", OPS_EMAILS: "ops@nk.test", BASE_URL: "https://nk.test" } as never;
  await runCronTrigger(env, CRON_EVERY_5_MIN, at(0), db);
  await runCronTrigger(env, CRON_GATEWAY_RECONCILE, at(1), db);
  const rows = await db.select().from(jobRuns).orderBy(jobRuns.startedAt);
  expect(rows.map((r) => [r.name, r.result])).toEqual([
    [CRON_JOB, { skipped: "CONFIG_REFUSED", error: expect.stringContaining("MOCK_MODE_REFUSED") }],
    [GATEWAY_RECONCILE_JOB, { skipped: "CONFIG_REFUSED", error: expect.stringContaining("MOCK_MODE_REFUSED") }],
  ]);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("CONFIG_REFUSED"));
  const alerts = await db.select().from(opsAlerts).where(eq(opsAlerts.key, "config_refused"));
  expect(alerts).toHaveLength(1); // once an hour, not once per trigger
  log.mockRestore();
});

test("reconcile outcomes that alert staff also alert ops; a clean run does not", () => {
  expect(reconcileAlertDetail(CHANNEL_RECONCILE_JOB, { checked: 3, repushed: 0, cancelled: 0, lookupErrors: 0, failed: 0, mismatches: [] })).toBeNull();
  expect(reconcileAlertDetail(CHANNEL_RECONCILE_JOB, {
    checked: 3, repushed: 0, cancelled: 0, lookupErrors: 0, failed: 0,
    mismatches: [{ propertyId: "p", reservationId: "r", code: "NK-ABC123", local: "S1", channel: "S2", channelState: "active" }],
  })).toContain("NK-ABC123");
  expect(reconcileAlertDetail(CHANNEL_RECONCILE_JOB, { checked: 3, repushed: 0, cancelled: 0, lookupErrors: 0, failed: 1, mismatches: [] })).toMatch(/failed=1/);
  expect(reconcileAlertDetail(CHANNEL_RECONCILE_JOB, { checked: 3, repushed: 0, cancelled: 0, lookupErrors: 2, failed: 0, mismatches: [] })).toMatch(/lookupErrors=2/);
  const g = { refundsChecked: 1, refundsSettled: 0, refundsFailed: 0, refundsUnresolved: 1, flowsFinished: 0, flowsFailed: 0, chargesChecked: 0, chargesApplied: 0 };
  expect(reconcileAlertDetail(GATEWAY_RECONCILE_JOB, g)).toBeNull(); // unresolved stays on the dashboard
  expect(reconcileAlertDetail(GATEWAY_RECONCILE_JOB, { ...g, refundsFailed: 1 })).toMatch(/refundsFailed=1/);
  expect(reconcileAlertDetail(GATEWAY_RECONCILE_JOB, { ...g, flowsFailed: 2 })).toMatch(/flowsFailed=2/);
  expect(reconcileAlertDetail(GATEWAY_RECONCILE_JOB, { skipped: "CHANNEL_MODE_NOT_SET" })).toBeNull();
});

test("buildOpsDeps reads OPS_EMAILS (comma-separated) and ENVIRONMENT", () => {
  const d = buildOpsDeps({ OPS_EMAILS: " a@x.com, b@x.com ,,", ENVIRONMENT: "staging" }, createTestDb());
  expect(d.opsEmails).toEqual(["a@x.com", "b@x.com"]);
  expect(d.environment).toBe("staging");
  expect(buildOpsDeps({}, createTestDb()).opsEmails).toEqual([]);
});
