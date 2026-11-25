/**
 * Local dev only: add an owner (active, owner of every property) to the LOCAL D1 (`wrangler --local`).
 *
 *   npx tsx scripts/create-owner.ts <email> <name>
 *
 * Applies the migrations to the local D1 first (so it works on a fresh clone) and refuses when there are no
 * properties yet (run scripts/seed-local.ts first). It never touches a remote database. For production the owner runs the SQL template in docs/DEPLOY.md
 * ("建立第一位 owner") themselves with `wrangler d1 execute --remote`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { firstOwnerSql } from "../lib/admin/staff";

const args = process.argv.slice(2);
if (args.some((a) => a.startsWith("--"))) {
  console.error("create-owner writes to the local D1 only and takes no flags. For production see docs/DEPLOY.md.");
  process.exit(1);
}
const [email, ...nameParts] = args;
const name = nameParts.join(" ");
if (!email || !name) {
  console.error("usage: npx tsx scripts/create-owner.ts <email> <name>");
  process.exit(1);
}

const wrangler = (...a: string[]) => execFileSync("npx", ["wrangler", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

// A fresh clone has no local D1 yet: apply the migrations first (creates it; a no-op when up to date).
wrangler("d1", "migrations", "apply", "nk-booking", "--local");
const [{ results }] = JSON.parse(wrangler("d1", "execute", "nk-booking", "--local", "--json", "--command", "SELECT count(*) AS n FROM properties"));
if (!results[0]?.n) {
  console.error("The local D1 has no properties yet, so the owner would own nothing. Seed it first:\n  npx tsx scripts/seed-local.ts --skip-media\n(that seed already includes owner@local.test), then re-run this script.");
  process.exit(1);
}

const file = path.resolve(".wrangler/create-owner.sql");
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, firstOwnerSql(email, name));
execFileSync("npx", ["wrangler", "d1", "execute", "nk-booking", "--local", "--file", file], { stdio: "inherit" });
console.log(`owner ${email.trim().toLowerCase()} added to the local D1.`);
