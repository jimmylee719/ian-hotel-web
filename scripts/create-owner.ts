/**
 * Local dev only: add an owner (active, owner of every property) to the LOCAL D1 (`wrangler --local`).
 *
 *   npx tsx scripts/create-owner.ts <email> <name>
 *
 * It never touches a remote database. For production the owner runs the SQL template in docs/DEPLOY.md
 * ("建立第一位 owner") themselves with `wrangler d1 execute --remote`.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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

const file = path.resolve(".wrangler/create-owner.sql");
writeFileSync(file, firstOwnerSql(email, name));
execFileSync("npx", ["wrangler", "d1", "execute", "nk-booking", "--local", "--file", file], { stdio: "inherit" });
console.log(`owner ${email.trim().toLowerCase()} added to the local D1 (if any property exists; run scripts/seed-local.ts first).`);
