import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { BAKED_MARKERS, isEnvDependentRoute } from "@/scripts/check-prerender";

// A build-time prerender reads the build machine's top-level wrangler vars (ENVIRONMENT "local", PAYMENT_MODE "mock"),
// so any env-dependent page that is prerendered would ship the 測試用 banner and noindex to production.

const ROOT = path.resolve(__dirname, "../..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const rendered = [...walk(path.join(ROOT, "app/[locale]")), ...walk(path.join(ROOT, "app/dev")), path.join(ROOT, "app/robots.ts")]
  .filter((f) => /\.(tsx|ts)$/.test(f));

test("the [locale] layout forces request-time rendering and has no generateStaticParams", () => {
  const layout = readFileSync(path.join(ROOT, "app/[locale]/layout.tsx"), "utf8");
  expect(layout).toMatch(/^export const dynamic = "force-dynamic";$/m);
  expect(layout).not.toMatch(/export (async )?function generateStaticParams|generateStaticParams *=/);
});

test("every page under app/[locale] and app/dev, and robots.txt, is force-dynamic", () => {
  const pages = rendered.filter((f) => /[/\\](page\.tsx|robots\.ts)$/.test(f));
  expect(pages.length).toBeGreaterThan(20);
  for (const f of pages) expect(readFileSync(f, "utf8"), path.relative(ROOT, f)).toMatch(/^export const dynamic = "force-dynamic";$/m);
  for (const f of rendered) expect(readFileSync(f, "utf8"), path.relative(ROOT, f)).not.toMatch(/export (async )?function generateStaticParams|generateStaticParams *=/);
});

test("rendered code reads the env through requestEnv (connection() first), never appEnv() directly", () => {
  for (const f of rendered) expect(readFileSync(f, "utf8"), path.relative(ROOT, f)).not.toMatch(/\bappEnv\(/);
});

test("requestEnv awaits next/server connection() before reading the env", async () => {
  vi.resetModules();
  const order: string[] = [];
  vi.doMock("next/server", () => ({ connection: async () => { order.push("connection"); } }));
  vi.doMock("@/lib/runtime/env", async (orig) => ({
    ...(await orig<typeof import("@/lib/runtime/env")>()),
    appEnv: async () => { order.push("appEnv"); return { ENVIRONMENT: "production" }; },
  }));
  const { requestEnv, bookingEnabled } = await import("@/lib/runtime/request-env");
  expect(await requestEnv()).toEqual({ ENVIRONMENT: "production" });
  expect(await bookingEnabled()).toBe(false);
  expect(order).toEqual(["connection", "appEnv", "connection", "appEnv"]);
  vi.doUnmock("next/server");
  vi.doUnmock("@/lib/runtime/env");
});

test("scripts/check-prerender.ts flags localised, /dev and robots routes and the baked markers", () => {
  for (const r of ["/zh-TW", "/en/reviews", "/ja/manage", "/ko", "/[locale]", "/[locale]/reviews", "/dev/pay/x", "/robots.txt"])
    expect(isEnvDependentRoute(r), r).toBe(true);
  for (const r of ["/_not-found", "/favicon.ico", "/sitemap.xml", "/english"]) expect(isEnvDependentRoute(r), r).toBe(false);
  expect(BAKED_MARKERS).toEqual(expect.arrayContaining(["test-banner", "test-note", "noindex, nofollow"]));
  const { scripts } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const k of ["deploy", "deploy:staging", "deploy:preview"])
    expect(scripts[k], k).toMatch(/opennextjs-cloudflare build --env \w+ && tsx scripts\/check-prerender\.ts && /);
});
