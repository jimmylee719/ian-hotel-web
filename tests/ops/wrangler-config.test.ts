import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { CRON_CHANNEL_RECONCILE, CRON_EVERY_5_MIN, CRON_GATEWAY_RECONCILE } from "@/lib/jobs/cron";

/** The 5-minute cron, the 15-minute gateway reconcile and the daily (04:00 Taipei) channel reconcile. */
const CRONS = [CRON_EVERY_5_MIN, CRON_GATEWAY_RECONCILE, CRON_CHANNEL_RECONCILE];

const cfg = JSON.parse(readFileSync(path.resolve(__dirname, "../../wrangler.jsonc"), "utf8")
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"));

test("the worker entry is worker.ts and it runs every 5 and 15 minutes and daily at 04:00 Taipei", () => {
  expect(cfg.main).toBe("worker.ts");
  expect(CRONS).toEqual(["*/5 * * * *", "*/15 * * * *", "0 20 * * *"]);
  expect(cfg.triggers.crons).toEqual(CRONS);
});

test("local/preview vars use the mock payment and channel modes", () => {
  expect(cfg.vars).toMatchObject({ PAYMENT_MODE: "mock", CHANNEL_MODE: "mock", ENVIRONMENT: "local" });
});

test("neither env is published on workers.dev", () => {
  expect(cfg.workers_dev).toBe(false);
  expect(cfg.env.production.workers_dev).toBe(false);
});

test("production is a separate env that never sets PAYMENT_MODE=mock (/dev/pay would mark bookings paid)", () => {
  const prod = cfg.env.production;
  expect(prod).toBeTruthy();
  expect(prod.vars.ENVIRONMENT).toBe("production");
  expect(prod.vars).not.toHaveProperty("PAYMENT_MODE");
  expect(prod.vars).not.toHaveProperty("CHANNEL_MODE");
  expect(JSON.stringify(prod.vars ?? {})).not.toContain("mock");
  // Wrangler does not inherit bindings or triggers into an env, so each must be repeated.
  expect(prod.main ?? cfg.main).toBe("worker.ts");
  expect(prod.triggers.crons).toEqual(CRONS);
  expect(prod.d1_databases[0]).toMatchObject({ binding: "DB", database_name: "nk-booking" });
  expect(prod.r2_buckets[0]).toMatchObject({ binding: "MEDIA", bucket_name: "nk-media" });
  expect(prod.images).toEqual({ binding: "IMAGES" }); // photo upload variants (lib/admin/uploads.ts)
  expect(prod.services[0].binding).toBe("WORKER_SELF_REFERENCE");
  expect(prod.services[0].service).toBe(prod.name);
  expect(prod.name).not.toBe(cfg.name); // deploying the default env can never overwrite production
});

test("deploy runs the tests and the type check, then fetches the fonts, before building; preview fetches the fonts first", () => {
  const { scripts } = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));
  // tsc fails on unknown translation keys (global.d.ts types next-intl's messages), so a missing key blocks a deploy.
  expect(scripts.deploy).toMatch(/^vitest run && tsc --noEmit && tsx scripts\/fetch-fonts\.ts && opennextjs-cloudflare build /);
  expect(scripts.preview).toMatch(/^tsx scripts\/fetch-fonts\.ts && /);
  expect(scripts.deploy).toContain("--env production");
});

test("staging is its own env: own Worker, D1 and bucket, the same crons, ENVIRONMENT=staging, no mock modes", () => {
  const stg = cfg.env.staging;
  const prod = cfg.env.production;
  expect(stg).toBeTruthy();
  expect(stg.workers_dev).toBe(false);
  expect(stg.vars.ENVIRONMENT).toBe("staging");
  expect(stg.vars).not.toHaveProperty("PAYMENT_MODE");
  expect(stg.vars).not.toHaveProperty("CHANNEL_MODE");
  expect(JSON.stringify(stg.vars)).not.toContain("mock");
  expect(stg.vars).toMatchObject({ CF_ACCESS_TEAM_DOMAIN: "", CF_ACCESS_AUD: "" });
  expect(stg.main ?? cfg.main).toBe("worker.ts");
  expect(stg.triggers.crons).toEqual(CRONS);
  expect(stg.name).not.toBe(cfg.name);
  expect(stg.name).not.toBe(prod.name);
  expect(stg.services[0]).toEqual({ binding: "WORKER_SELF_REFERENCE", service: stg.name });
  expect(stg.d1_databases[0]).toMatchObject({ binding: "DB", database_name: "nk-booking-staging", migrations_dir: "drizzle/migrations" });
  expect(stg.d1_databases[0].database_id).not.toBe(prod.d1_databases[0].database_id);
  expect(stg.r2_buckets[0].binding).toBe("MEDIA");
  expect(stg.r2_buckets[0].bucket_name).not.toBe(prod.r2_buckets[0].bucket_name);
  expect(stg.images).toEqual({ binding: "IMAGES" });
  expect(stg.assets).toEqual(prod.assets);
});

test("deploy:staging mirrors deploy but targets --env staging", () => {
  const { scripts } = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));
  expect(scripts["deploy:staging"]).toBe(scripts.deploy.replaceAll("--env production", "--env staging"));
});

test("preview is the labelled test site: mock modes only, its own BASE_URL, only the 5-minute cron, admin locked", () => {
  const pv = cfg.env.preview;
  expect(pv.name).toBe("nk-booking-preview");
  expect(pv.workers_dev).toBe(true);
  expect(pv.vars).toEqual({
    ENVIRONMENT: "preview", PAYMENT_MODE: "mock", CHANNEL_MODE: "mock",
    BASE_URL: "https://nk-booking-preview.cardboard-vinyl.workers.dev", CF_ACCESS_TEAM_DOMAIN: "", CF_ACCESS_AUD: "",
  });
  // Booking is open (no BOOKING_OPEN "false"); no staff bypass, no staff list, no vendor setting, no secret in vars.
  for (const name of ["BOOKING_OPEN", "DEV_STAFF_EMAIL", "STAFF_EMAILS", "MOCK_PAYMENT_SECRET", "RESEND_API_KEY"])
    expect(pv.vars).not.toHaveProperty(name);
  expect(Object.keys(pv.vars).some((k) => /^(SITEMINDER|SINOPAC)_/.test(k))).toBe(false);
  expect(pv.triggers.crons).toEqual([CRON_EVERY_5_MIN]); // unpaid holds expire; no reconcile jobs
  expect(pv.services[0]).toEqual({ binding: "WORKER_SELF_REFERENCE", service: pv.name }); // /dev/pay posts its notice through it
  expect(pv.d1_databases[0]).toMatchObject({ binding: "DB", database_name: "nk-booking-preview" });
  expect(pv.d1_databases[0].database_id).not.toBe(cfg.env.production.d1_databases[0].database_id);
});
