import { afterEach, expect, test, vi } from "vitest";
import {
  assertConfig, ConfigRefusedError, configRefusal, SINOPAC_HOSTS, SITEMINDER_HOSTS, withConfigGuard,
} from "@/lib/runtime/config-guard";

// The real host lists arrive with the vendor docs (Tasks 3/5). The tests fill them for the duration of each test.
const SM = { production: ["api.siteminder.example"], sandbox: ["sandbox.siteminder.example"] };
const SP = { production: ["pay.sinopac.example"], sandbox: ["sandbox.sinopac.example"] };
function fillLists() {
  SITEMINDER_HOSTS.production.push(...SM.production); SITEMINDER_HOSTS.sandbox.push(...SM.sandbox);
  SINOPAC_HOSTS.production.push(...SP.production); SINOPAC_HOSTS.sandbox.push(...SP.sandbox);
}
afterEach(() => {
  for (const l of [SITEMINDER_HOSTS, SINOPAC_HOSTS]) { l.production.length = 0; l.sandbox.length = 0; }
  vi.restoreAllMocks();
});

test("production with a SiteMinder sandbox URL is refused (brief)", () => {
  fillLists();
  expect(() => assertConfig({ ENVIRONMENT: "production", SITEMINDER_ENDPOINT: "https://sandbox.siteminder.example/pmsxchange" }))
    .toThrow(ConfigRefusedError);
  expect(() => assertConfig({ ENVIRONMENT: "production", SINOPAC_ENDPOINT: "https://sandbox.sinopac.example/api" }))
    .toThrow(/SINOPAC_ENDPOINT/);
});

test("production accepts endpoints on the vendor's production list, and nothing else", () => {
  fillLists();
  const prod = { ENVIRONMENT: "production", SITEMINDER_ENDPOINT: "https://API.siteminder.example/x", SINOPAC_ENDPOINT: "https://pay.sinopac.example/y" };
  expect(() => assertConfig(prod)).not.toThrow();
  expect(configRefusal({ ...prod, SINOPAC_QUERY_ENDPOINT: "https://evil.example/q" })).toMatch(/SINOPAC_QUERY_ENDPOINT/);
  expect(configRefusal({ ...prod, SITEMINDER_ENDPOINT: "http://api.siteminder.example/x" })).toMatch(/https/); // plain http refused
  expect(configRefusal({ ...prod, SITEMINDER_ENDPOINT: "not a url" })).toMatch(/SITEMINDER_ENDPOINT/);
  // A vendor's production host does not count for the other vendor.
  expect(configRefusal({ ENVIRONMENT: "production", SINOPAC_ENDPOINT: "https://api.siteminder.example/" })).not.toBeNull();
});

test("fails closed while the host lists are empty: any configured endpoint is refused outside local", () => {
  expect(configRefusal({ ENVIRONMENT: "production", SITEMINDER_ENDPOINT: "https://anything.example" })).not.toBeNull();
  expect(configRefusal({ ENVIRONMENT: "staging", SINOPAC_ENDPOINT: "https://anything.example" })).not.toBeNull();
  // Nothing configured: nothing to refuse (booking stays off through PAYMENT_MODE / CHANNEL_MODE instead).
  expect(configRefusal({ ENVIRONMENT: "production" })).toBeNull();
  expect(configRefusal({ ENVIRONMENT: "production", SITEMINDER_ENDPOINT: "" })).toBeNull();
});

test("staging refuses production endpoints and accepts only sandbox ones", () => {
  fillLists();
  expect(() => assertConfig({ ENVIRONMENT: "staging", SITEMINDER_ENDPOINT: "https://api.siteminder.example/x" })).toThrow(ConfigRefusedError);
  expect(() => assertConfig({ ENVIRONMENT: "staging", SINOPAC_ENDPOINT: "https://pay.sinopac.example/x" })).toThrow(ConfigRefusedError);
  expect(() => assertConfig({
    ENVIRONMENT: "staging", SITEMINDER_ENDPOINT: "https://sandbox.siteminder.example/x", SINOPAC_ENDPOINT: "https://sandbox.sinopac.example/y",
  })).not.toThrow();
});

test("any mock mode is refused in production and staging (and when ENVIRONMENT is unknown); local allows anything", () => {
  for (const ENVIRONMENT of ["production", "staging", undefined, "prod"]) {
    expect(configRefusal({ ENVIRONMENT, PAYMENT_MODE: "mock" })).toMatch(/MOCK/);
    expect(configRefusal({ ENVIRONMENT, CHANNEL_MODE: "mock" })).toMatch(/MOCK/);
  }
  fillLists();
  expect(configRefusal({
    ENVIRONMENT: "local", PAYMENT_MODE: "mock", CHANNEL_MODE: "mock",
    SITEMINDER_ENDPOINT: "https://api.siteminder.example", SINOPAC_ENDPOINT: "http://localhost:9999",
  })).toBeNull();
});

test("the request guard answers 503 without calling the app when the config is refused", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const app = vi.fn(async () => new Response("ok"));
  const fetch = withConfigGuard(app);
  const refused = await fetch(new Request("https://x.test/"), { ENVIRONMENT: "production", PAYMENT_MODE: "mock" }, {} as never);
  expect(refused.status).toBe(503);
  expect(await refused.text()).not.toContain("mock"); // the reason is logged, not shown
  expect(app).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(expect.stringContaining("MOCK"));
  const ok = await fetch(new Request("https://x.test/"), { ENVIRONMENT: "local", PAYMENT_MODE: "mock" }, {} as never);
  expect(await ok.text()).toBe("ok");
});
