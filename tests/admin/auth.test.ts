import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAuthError, authorize, resolveStaff } from "@/lib/admin/auth";
import type { AppEnv } from "@/lib/runtime/env";
import { staff } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createTestDb, type TestDb } from "../helpers/test-db";
import { AUD, TEAM_DOMAIN, makeSigner, type Signer } from "./jwt-fixture";

const PROD: AppEnv = { ENVIRONMENT: "production", CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD };

let db: TestDb;
let d: Db;
let s: Signer;

beforeEach(async () => {
  db = createTestDb();
  d = db as unknown as Db;
  s = await makeSigner();
  db.insert(staff).values([
    { id: "s1", email: "front@nkhostel.com", name: "Front", role: "front_desk", propertyIds: ["A"], active: true },
    { id: "s2", email: "gone@nkhostel.com", name: "Gone", role: "manager", propertyIds: ["A"], active: false },
  ]).run();
});

const jwtHeaders = (token: string) => new Headers({ "Cf-Access-Jwt-Assertion": token });

describe("resolveStaff", () => {
  it("resolves the staff member named by a valid JWT", async () => {
    const r = await resolveStaff(d, PROD, jwtHeaders(await s.sign()), undefined, s.jwks);
    expect(r).toMatchObject({ ok: true, ctx: { email: "front@nkhostel.com", staff: { id: "s1", role: "front_desk" } } });
  });

  it("ignores the email header: no JWT is 401", async () => {
    const r = await resolveStaff(d, PROD, new Headers({ "Cf-Access-Authenticated-User-Email": "front@nkhostel.com" }), undefined, s.jwks);
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("401s a JWT signed by another key", async () => {
    const attacker = await makeSigner();
    const r = await resolveStaff(d, PROD, jwtHeaders(await attacker.sign()), undefined, s.jwks);
    expect(r).toEqual({ ok: false, status: 401, error: "INVALID" });
  });

  it("403s a valid JWT whose email is not staff", async () => {
    const r = await resolveStaff(d, PROD, jwtHeaders(await s.sign({ email: "stranger@gmail.com" })), undefined, s.jwks);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("403s inactive staff", async () => {
    const r = await resolveStaff(d, PROD, jwtHeaders(await s.sign({ email: "gone@nkhostel.com" })), undefined, s.jwks);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("still requires a JWT in production when DEV_STAFF_EMAIL is set", async () => {
    const r = await resolveStaff(d, { ...PROD, DEV_STAFF_EMAIL: "front@nkhostel.com" }, new Headers(), undefined, s.jwks);
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("uses DEV_STAFF_EMAIL locally, with no Access config", async () => {
    const r = await resolveStaff(d, { ENVIRONMENT: "local", DEV_STAFF_EMAIL: " Front@NKHostel.com " }, new Headers());
    expect(r).toMatchObject({ ok: true, ctx: { email: "front@nkhostel.com", staff: { id: "s1" } } });
  });

  it("still 403s a local DEV_STAFF_EMAIL that is not staff", async () => {
    const r = await resolveStaff(d, { ENVIRONMENT: "local", DEV_STAFF_EMAIL: "nobody@nk.com" }, new Headers());
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("fails closed when CF_ACCESS_AUD is unset", async () => {
    const r = await resolveStaff(d, { ...PROD, CF_ACCESS_AUD: "" }, jwtHeaders(await s.sign()), undefined, s.jwks);
    expect(r).toEqual({ ok: false, status: 401, error: "ACCESS_NOT_CONFIGURED" });
  });

  it("fails closed when CF_ACCESS_TEAM_DOMAIN is unset", async () => {
    const r = await resolveStaff(d, { ...PROD, CF_ACCESS_TEAM_DOMAIN: undefined }, jwtHeaders(await s.sign()), undefined, s.jwks);
    expect(r).toEqual({ ok: false, status: 401, error: "ACCESS_NOT_CONFIGURED" });
  });
});

describe("authorize", () => {
  it("returns the context when the role has the permission", async () => {
    const ctx = await authorize(d, PROD, jwtHeaders(await s.sign()), "reservations.view", "A", undefined, s.jwks);
    expect(ctx.staff.id).toBe("s1");
  });

  it("403s a permission the role lacks", async () => {
    const err = await authorize(d, PROD, jwtHeaders(await s.sign()), "reservations.refund_override", undefined, undefined, s.jwks).catch((e) => e);
    expect(err).toBeInstanceOf(AdminAuthError);
    expect(err.status).toBe(403);
  });

  it("403s a property outside the staff member's scope", async () => {
    const err = await authorize(d, PROD, jwtHeaders(await s.sign()), "reservations.view", "B", undefined, s.jwks).catch((e) => e);
    expect(err).toMatchObject({ status: 403 });
  });

  it("throws 401 when unauthenticated", async () => {
    const err = await authorize(d, PROD, new Headers(), "dashboard.view", undefined, undefined, s.jwks).catch((e) => e);
    expect(err).toMatchObject({ status: 401 });
  });
});

describe("withAdmin", () => {
  it("answers 401 / 403 as JSON and calls the handler only when allowed", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db/client", () => ({ getDb: async () => d }));
    vi.doMock("@/lib/runtime/env", () => ({ appEnv: async () => ({ ENVIRONMENT: "local", DEV_STAFF_EMAIL: "front@nkhostel.com" }) }));
    const { withAdmin } = await import("@/lib/admin/auth");
    const handler = vi.fn(async (ctx: { email: string }) => Response.json({ who: ctx.email }));

    const ok = await withAdmin("reservations.view", handler)(new Request("http://x/admin/api"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ who: "front@nkhostel.com" });

    handler.mockClear();
    const denied = await withAdmin("staff.manage", handler)(new Request("http://x/admin/api"));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: expect.any(String) });
    expect(handler).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/db/client");
    vi.doUnmock("@/lib/runtime/env");
  });
});
