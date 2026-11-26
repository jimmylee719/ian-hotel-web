/**
 * Run after `opennextjs-cloudflare build` (npm run deploy, deploy:staging, deploy:preview): fails the deploy when a
 * build-time prerender could carry env-dependent output into another environment.
 * - No localised page ([locale]), /dev page or robots.txt may be prerendered: they read the Worker's env at request
 *   time (lib/runtime/request-env.ts), and a prerender would bake the build machine's top-level wrangler vars
 *   (ENVIRONMENT "local", PAYMENT_MODE "mock") into the HTML.
 * - No cached page in .open-next/cache may contain the 測試用 labels or a noindex tag.
 *
 *   npx tsx scripts/check-prerender.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { routing } from "../i18n/routing";

/** Paths that must never be prerendered. */
export function isEnvDependentRoute(route: string): boolean {
  const locales = routing.locales.map((l) => l.replace(/[-]/g, "\\-")).join("|");
  return new RegExp(`^/(${locales}|\\[locale\\])(/|$)`).test(route) || route.startsWith("/dev/") || route === "/robots.txt";
}

/** Markers of env-dependent output that must not appear in a cached (build-time) page. */
export const BAKED_MARKERS = ["test-banner", "test-note", "測試版網站", "noindex, nofollow"];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function main() {
  const problems: string[] = [];
  const manifestFile = path.resolve(".next/prerender-manifest.json");
  if (!existsSync(manifestFile)) throw new Error("no .next/prerender-manifest.json: run the build first");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { routes: Record<string, unknown>; dynamicRoutes: Record<string, unknown> };
  for (const route of [...Object.keys(manifest.routes), ...Object.keys(manifest.dynamicRoutes ?? {})])
    if (isEnvDependentRoute(route)) problems.push(`prerendered: ${route}`);
  for (const file of walk(path.resolve(".open-next/cache")).filter((f) => f.endsWith(".cache"))) {
    const text = readFileSync(file, "utf8");
    for (const m of BAKED_MARKERS) if (text.includes(m)) problems.push(`${path.relative(process.cwd(), file)} contains "${m}"`);
  }
  if (problems.length) {
    console.error(`check-prerender: env-dependent output was prerendered:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`check-prerender: ok (${Object.keys(manifest.routes).length} prerendered routes, none env-dependent)`);
}

if (process.argv[1]?.endsWith("check-prerender.ts")) main();
