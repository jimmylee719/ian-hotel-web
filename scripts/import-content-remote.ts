/**
 * Import the migrated site content (content/old-site.json; photos are keys of objects already in R2) into a
 * REMOTE D1: staging by default, production only when asked for explicitly.
 *
 *   npm run content:import-remote                                          # dry run against staging
 *   npm run content:import-remote -- --apply                               # write to staging
 *   npm run content:import-remote -- --env production                      # dry run against production
 *   npm run content:import-remote -- --env production --apply --yes       # write to production
 *
 * Insert-only (lib/content/import-remote.ts): room fields are filled only where blank, pages / FAQs / news are
 * inserted only when their slug is missing, so staff edits are never overwritten and re-running is harmless.
 * A dry run writes the SQL to .wrangler/ and lists what it would write; it never contacts Cloudflare. Only
 * --apply runs `wrangler d1 execute DB --env <env> --remote --file <sql>`.
 * Upload the photos first (`npm run media:variants -- --remote`, plus the originals): rooms point at those keys.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { oldSiteContent } from "../lib/content/old-site";
import { parseImportArgs, planContentImport, wranglerExecuteArgs } from "../lib/content/import-remote";

function main() {
  const args = parseImportArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`import-content-remote: ${args.error}`);
    process.exit(2);
  }
  const plan = planContentImport(oldSiteContent(), { propertySlug: "nk-hostel", now: Date.now(), newId: () => crypto.randomUUID() });
  const file = path.resolve(`.wrangler/import-content-${args.env}.sql`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, plan.statements.join("\n") + "\n");

  console.log(`${args.apply ? "APPLY" : "DRY RUN"} — env ${args.env} (remote D1), ${plan.statements.length} statements in ${file}`);
  console.log("Would write (each only where missing or blank; existing rows and staff edits are left alone):");
  for (const line of plan.summary) console.log(`  - ${line}`);
  console.log(`R2 keys referenced (must already be in the ${args.env} bucket): ${plan.imageKeys.length}`);
  if (!args.apply) {
    console.log(`Nothing written. To write: --env ${args.env} --apply${args.env === "production" ? " --yes" : ""}`);
    return;
  }
  execFileSync("npx", wranglerExecuteArgs(args.env, file), { stdio: "inherit" });
}

main();
