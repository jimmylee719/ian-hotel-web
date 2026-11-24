import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

const cfg = JSON.parse(readFileSync(path.resolve(__dirname, "../../wrangler.jsonc"), "utf8")
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"));

test("the worker entry is worker.ts and it runs every 5 minutes", () => {
  expect(cfg.main).toBe("worker.ts");
  expect(cfg.triggers.crons).toEqual(["*/5 * * * *"]);
});

test("local/preview vars use the mock payment and channel modes", () => {
  expect(cfg.vars).toMatchObject({ PAYMENT_MODE: "mock", CHANNEL_MODE: "mock" });
});

test("production is a separate env that never sets PAYMENT_MODE=mock (/dev/pay would mark bookings paid)", () => {
  const prod = cfg.env.production;
  expect(prod).toBeTruthy();
  expect(prod.vars ?? {}).not.toHaveProperty("PAYMENT_MODE");
  expect(JSON.stringify(prod.vars ?? {})).not.toContain("mock");
  // Wrangler does not inherit bindings or triggers into an env, so each must be repeated.
  expect(prod.main ?? cfg.main).toBe("worker.ts");
  expect(prod.triggers.crons).toEqual(["*/5 * * * *"]);
  expect(prod.d1_databases[0]).toMatchObject({ binding: "DB", database_name: "nk-booking" });
  expect(prod.r2_buckets[0]).toMatchObject({ binding: "MEDIA", bucket_name: "nk-media" });
  expect(prod.services[0].binding).toBe("WORKER_SELF_REFERENCE");
  expect(prod.services[0].service).toBe(prod.name);
  expect(prod.name).not.toBe(cfg.name); // deploying the default env can never overwrite production
});

test("deploy and preview fetch the fonts first, and deploy targets production", () => {
  const { scripts } = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));
  expect(scripts.deploy).toMatch(/^tsx scripts\/fetch-fonts\.ts && /);
  expect(scripts.preview).toMatch(/^tsx scripts\/fetch-fonts\.ts && /);
  expect(scripts.deploy).toContain("--env production");
});
