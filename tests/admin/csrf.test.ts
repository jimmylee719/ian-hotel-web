import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { staff } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createTestDb } from "../helpers/test-db";

const SELF = "https://www.nkhostel.com";
const URL_ = `${SELF}/api/admin/commerce/promos`;
const PROMO = JSON.stringify({ code: "X", kind: "percent", value: 100 });

let d: Db;

beforeEach(() => {
  const db = createTestDb();
  d = db as unknown as Db;
  db.insert(staff).values({ id: "s1", email: "boss@nkhostel.com", name: "Boss", role: "owner", propertyIds: ["A"], active: true }).run();
  vi.resetModules();
  vi.doMock("@/lib/db/client", () => ({ getDb: async () => d }));
  vi.doMock("@/lib/runtime/env", () => ({ appEnv: async () => ({ ENVIRONMENT: "local", DEV_STAFF_EMAIL: "boss@nkhostel.com" }) }));
});

afterEach(() => {
  vi.doUnmock("@/lib/db/client");
  vi.doUnmock("@/lib/runtime/env");
  vi.doUnmock("next/headers");
});

/** A withAdmin route whose handler parses a JSON body, as the promo route does. */
async function jsonRoute() {
  const { withAdmin } = await import("@/lib/admin/auth");
  const { jsonBody } = await import("@/lib/admin/content-api");
  const handler = vi.fn(async (_ctx: unknown, req: Request) => Response.json({ body: await jsonBody(req) }));
  return { route: withAdmin("commerce.edit", handler), handler };
}

const post = (headers: Record<string, string>, body: BodyInit = PROMO, method = "POST") =>
  new Request(URL_, { method, headers, body });

describe("withAdmin: cross-site requests (I-1)", () => {
  it("a same-origin JSON POST goes through", async () => {
    const { route, handler } = await jsonRoute();
    const r = await route(post({ Origin: SELF, "Content-Type": "application/json" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ body: { code: "X", kind: "percent", value: 100 } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("Sec-Fetch-Site: same-origin is enough without an Origin header", async () => {
    const { route } = await jsonRoute();
    const r = await route(post({ "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json; charset=utf-8" }));
    expect(r.status).toBe(200);
  });

  it("a cross-site Origin is 403 CSRF_REJECTED and the handler never runs", async () => {
    const { route, handler } = await jsonRoute();
    const r = await route(post({ Origin: "https://evil.example", "Content-Type": "application/json" }));
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "CSRF_REJECTED" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("Sec-Fetch-Site cross-site or same-site with a foreign Origin is rejected", async () => {
    const { route, handler } = await jsonRoute();
    for (const site of ["cross-site", "same-site", "none"]) {
      const r = await route(post({ "Sec-Fetch-Site": site, Origin: "https://shop.nkhostel.com", "Content-Type": "application/json" }));
      expect(r.status).toBe(403);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("a state-changing request with neither header is rejected (PATCH, DELETE too)", async () => {
    const { route, handler } = await jsonRoute();
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const r = await route(post({ "Content-Type": "application/json" }, PROMO, method));
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ error: "CSRF_REJECTED" });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("GET and HEAD need no Origin", async () => {
    const { withAdmin } = await import("@/lib/admin/auth");
    const route = withAdmin("dashboard.view", async () => Response.json({ ok: true }));
    expect((await route(new Request(URL_))).status).toBe(200);
    expect((await route(new Request(URL_, { method: "HEAD" }))).status).toBe(200);
  });

  it("a text/plain POST (what a cross-site form can send) is 415, even from the same origin", async () => {
    const { route } = await jsonRoute();
    const r = await route(post({ Origin: SELF, "Content-Type": "text/plain" }));
    expect(r.status).toBe(415);
    expect(await r.json()).toMatchObject({ error: "UNSUPPORTED_MEDIA_TYPE" });
    const none = await route(new Request(URL_, { method: "POST", headers: { Origin: SELF }, body: new Blob([PROMO]) }));
    expect(none.status).toBe(415);
  });

  it("a multipart upload needs no JSON type but still needs the same origin", async () => {
    const { withAdmin } = await import("@/lib/admin/auth");
    const handler = vi.fn(async (_c: unknown, req: Request) => Response.json({ got: (await req.formData()).get("target") }));
    const route = withAdmin("content.edit", handler);
    const form = () => { const f = new FormData(); f.set("target", "news"); return f; };
    const ok = await route(new Request(URL_, { method: "POST", headers: { Origin: SELF }, body: form() }));
    expect(await ok.json()).toEqual({ got: "news" });
    const evil = await route(new Request(URL_, { method: "POST", headers: { Origin: "https://evil.example" }, body: form() }));
    expect(evil.status).toBe(403);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("admin server actions: requireStaffForAction (I-1)", () => {
  const withHeaders = (h: Record<string, string>) =>
    vi.doMock("next/headers", () => ({ headers: async () => new Headers(h), cookies: async () => ({ set() {} }) }));

  it("a same-origin action resolves the staff member", async () => {
    withHeaders({ Origin: SELF, Host: "www.nkhostel.com", "X-Forwarded-Proto": "https" });
    const { requireStaffForAction } = await import("@/lib/admin/auth");
    await expect(requireStaffForAction("dashboard.view")).resolves.toMatchObject({ email: "boss@nkhostel.com" });
  });

  it("Sec-Fetch-Site: same-origin is accepted", async () => {
    withHeaders({ "Sec-Fetch-Site": "same-origin", Host: "www.nkhostel.com" });
    const { requireStaffForAction } = await import("@/lib/admin/auth");
    await expect(requireStaffForAction("dashboard.view")).resolves.toMatchObject({ email: "boss@nkhostel.com" });
  });

  it("a cross-site action, or one with neither header, throws 403 CSRF_REJECTED", async () => {
    withHeaders({ Origin: "https://evil.example", Host: "www.nkhostel.com" });
    const { requireStaffForAction, AdminAuthError } = await import("@/lib/admin/auth");
    await expect(requireStaffForAction("dashboard.view")).rejects.toMatchObject({ status: 403, code: "CSRF_REJECTED" });
    await expect(requireStaffForAction("dashboard.view")).rejects.toBeInstanceOf(AdminAuthError);

    vi.resetModules();
    withHeaders({ Host: "www.nkhostel.com" });
    const again = await import("@/lib/admin/auth");
    await expect(again.requireStaffForAction("dashboard.view")).rejects.toMatchObject({ status: 403, code: "CSRF_REJECTED" });
  });
});
