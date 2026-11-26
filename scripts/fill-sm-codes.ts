/**
 * Give every property, room type and rate plan in a REMOTE D1 that still has no SiteMinder code its code
 * (lib/channel/siteminder/codes.ts planSmCodes). Migration 0024 fills every row whose code clashes with no other
 * row's; this covers the rest (rows whose slugs map to the same code get a numeric suffix). Never changes a code.
 *
 *   npx tsx scripts/fill-sm-codes.ts --env preview            # dry run: writes .wrangler/fill-sm-codes.sql only
 *   npx tsx scripts/fill-sm-codes.ts --env production --apply # runs it with `wrangler d1 execute DB --remote`
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { planSmCodes, smCodeUpdatesSql } from "../lib/channel/siteminder/codes";

const ENVS = ["preview", "staging", "production"];

function query<T>(env: string, sql: string): T[] {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--env", env, "--remote", "--json", "--command", sql], { encoding: "utf8" });
  return (JSON.parse(out) as { results: T[] }[])[0].results;
}

function main() {
  const env = process.argv[process.argv.indexOf("--env") + 1];
  if (!process.argv.includes("--env") || !ENVS.includes(env)) throw new Error(`pass --env ${ENVS.join("|")}`);
  type Row = { id: string; slug: string; code: string | null; propertyId: string };
  const plan = planSmCodes({
    properties: query<Row>(env, "SELECT id, slug, sm_property_code AS code FROM properties"),
    unitTypes: query<Row>(env, "SELECT id, slug, sm_room_code AS code, property_id AS propertyId FROM unit_types"),
    ratePlans: query<Row>(env, "SELECT id, slug, sm_rate_plan_code AS code, property_id AS propertyId FROM rate_plans"),
  });
  if (plan.length === 0) return console.log("every row already has its code; nothing to do");
  for (const u of plan) console.log(`${u.table} ${u.id} → ${u.code}`);
  const file = path.resolve(".wrangler/fill-sm-codes.sql");
  writeFileSync(file, smCodeUpdatesSql(plan).join("\n"));
  console.log(`${plan.length} UPDATEs in ${path.relative(process.cwd(), file)}`);
  if (!process.argv.includes("--apply")) return console.log("dry run; pass --apply to write them");
  execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--env", env, "--remote", "--file", file], { stdio: "inherit" });
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
