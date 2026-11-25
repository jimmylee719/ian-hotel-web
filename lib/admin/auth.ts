import type { JWTVerifyGetKey } from "jose";
import { sql } from "drizzle-orm";
import { headers as requestHeaders } from "next/headers";
import { getDb } from "@/lib/db/client";
import { staff } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { appEnv, type AppEnv } from "@/lib/runtime/env";
import { verifyAccessJwt } from "./access-jwt";
import { can, type Permission, type StaffRow } from "./permissions";

export type StaffContext = { staff: StaffRow; email: string };
export type ResolveResult = { ok: true; ctx: StaffContext } | { ok: false; status: 401 | 403; error: string };

/** A failed admin auth check: 401 = not signed in through Access, 403 = signed in but not allowed. */
export class AdminAuthError extends Error {
  constructor(readonly status: 401 | 403, readonly code: string) {
    super(`admin auth failed: ${status} ${code}`);
    this.name = "AdminAuthError";
  }
}

const JWT_HEADER = "Cf-Access-Jwt-Assertion";

/**
 * Who is making this admin request. The identity comes only from a verified Cloudflare Access JWT;
 * email headers such as `Cf-Access-Authenticated-User-Email` are never trusted. The one exception is
 * local dev (`ENVIRONMENT === "local"` with `DEV_STAFF_EMAIL` set). Missing Access config fails closed (401).
 * `jwks` is for tests; production fetches the team's keys.
 */
export async function resolveStaff(
  db: Db, env: AppEnv, headers: Headers, now: Date = new Date(), jwks?: JWTVerifyGetKey,
): Promise<ResolveResult> {
  let email: string;
  const devEmail = env.DEV_STAFF_EMAIL?.trim().toLowerCase();
  if (env.ENVIRONMENT === "local" && devEmail) {
    email = devEmail;
  } else {
    const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
    const aud = env.CF_ACCESS_AUD?.trim();
    if (!teamDomain || !aud) return { ok: false, status: 401, error: "ACCESS_NOT_CONFIGURED" };
    const r = await verifyAccessJwt(headers.get(JWT_HEADER) ?? "", { teamDomain, aud, jwks }, now);
    if (!r.ok) return { ok: false, status: 401, error: r.error };
    email = r.email;
  }

  const member = await db.select().from(staff).where(sql`lower(${staff.email}) = ${email}`).get();
  if (!member) return { ok: false, status: 403, error: "NOT_STAFF" };
  if (!member.active) return { ok: false, status: 403, error: "STAFF_INACTIVE" };
  return { ok: true, ctx: { staff: member, email } };
}

/** resolveStaff plus the permission (and property) check; throws AdminAuthError. */
export async function authorize(
  db: Db, env: AppEnv, headers: Headers, p: Permission, propertyId?: string, now: Date = new Date(), jwks?: JWTVerifyGetKey,
): Promise<StaffContext> {
  const r = await resolveStaff(db, env, headers, now, jwks);
  if (!r.ok) throw new AdminAuthError(r.status, r.error);
  if (!can(r.ctx.staff, p, propertyId)) throw new AdminAuthError(403, "FORBIDDEN");
  return r.ctx;
}

/** For Server Components and server actions: the signed-in staff member, or AdminAuthError. */
export async function requireStaff(p: Permission, propertyId?: string): Promise<StaffContext> {
  return authorize(await getDb(), await appEnv(), await requestHeaders(), p, propertyId);
}

/**
 * Wrap an admin route handler: 401 / 403 answer `{ error }` as JSON and the handler is not called.
 * Property-scoped checks that depend on the request are the handler's job (`can(ctx.staff, p, propertyId)`).
 */
export function withAdmin<R = unknown>(
  p: Permission,
  handler: (ctx: StaffContext, req: Request, route: R) => Promise<Response>,
): (req: Request, route?: R) => Promise<Response> {
  return async (req, route) => {
    let ctx: StaffContext;
    try {
      ctx = await authorize(await getDb(), await appEnv(), req.headers, p);
    } catch (e) {
      if (e instanceof AdminAuthError) return Response.json({ error: e.code }, { status: e.status });
      throw e;
    }
    // Next.js always passes the route context ({ params }); it is optional only so tests can omit it.
    return handler(ctx, req, route as R);
  };
}
