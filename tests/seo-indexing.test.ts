import { expect, test } from "vitest";
import { withNoindexHeader } from "@/lib/runtime/noindex";
import { isIndexable, NOINDEX, robotsFor, SITE_URL } from "@/lib/seo";

test("only production is indexable; preview, staging, local, unset and mistyped are not", () => {
  expect(isIndexable({ ENVIRONMENT: "production" })).toBe(true);
  expect(isIndexable({ ENVIRONMENT: " production " })).toBe(true); // trimmed, as config-guard does
  for (const ENVIRONMENT of ["preview", "staging", "local", undefined, "", "Production", "prod"])
    expect(isIndexable({ ENVIRONMENT }), String(ENVIRONMENT)).toBe(false);
  expect(NOINDEX).toEqual({ index: false, follow: false });
});

test("robots.txt: production is unchanged (crawl all but /api and /dev, with the sitemap); every other copy disallows all", () => {
  expect(robotsFor({ ENVIRONMENT: "production" })).toEqual({
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/dev/"] }],
    sitemap: new URL("/sitemap.xml", SITE_URL).toString(),
  });
  for (const ENVIRONMENT of ["preview", "staging", "local", undefined])
    expect(robotsFor({ ENVIRONMENT })).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
});

test("X-Robots-Tag: noindex, nofollow on every response outside production; production responses untouched", async () => {
  const app = withNoindexHeader<{ ENVIRONMENT?: string }, unknown>(async () => new Response("hi", { headers: { "content-type": "text/html" } }));
  const prod = await app(new Request("https://x.test/"), { ENVIRONMENT: "production" }, {});
  expect(prod.headers.get("x-robots-tag")).toBeNull();
  for (const ENVIRONMENT of ["preview", "staging", "local", undefined]) {
    const r = await app(new Request("https://x.test/"), { ENVIRONMENT }, {});
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await r.text()).toBe("hi");
  }
  // A response with immutable headers (straight from fetch) is copied, keeping status and body.
  const frozen = withNoindexHeader<{ ENVIRONMENT?: string }, unknown>(async () => {
    const r = new Response("gone", { status: 404 });
    Object.defineProperty(r, "headers", { value: new Proxy(new Headers(), { get: (t, k) => (k === "set" ? () => { throw new TypeError("immutable"); } : Reflect.get(t, k)) }) });
    return r;
  });
  const copied = await frozen(new Request("https://x.test/"), { ENVIRONMENT: "preview" }, {});
  expect(copied.status).toBe(404);
  expect(copied.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(await copied.text()).toBe("gone");
});
