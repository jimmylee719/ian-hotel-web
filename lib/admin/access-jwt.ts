import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

export type AccessJwtError = "MISSING" | "INVALID" | "EXPIRED" | "WRONG_AUD" | "WRONG_ISS";
export type AccessJwtResult = { ok: true; email: string } | { ok: false; error: AccessJwtError };
export type AccessJwtConfig = { teamDomain: string; aud: string; jwks?: JWTVerifyGetKey };

/** `https://<team>.cloudflareaccess.com`, whether or not the configured domain has the scheme or a trailing slash. */
export function accessIssuer(teamDomain: string): string {
  return `https://${teamDomain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "")}`;
}

// One remote key set per issuer per isolate: jose caches the fetched keys and refetches on an unknown kid.
const remoteSets = new Map<string, JWTVerifyGetKey>();
function remoteJwks(issuer: string): JWTVerifyGetKey {
  let set = remoteSets.get(issuer);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    remoteSets.set(issuer, set);
  }
  return set;
}

/**
 * Verify a Cloudflare Access application token (`Cf-Access-Jwt-Assertion`): RS256 signature against the
 * team's JWKS, `iss` = the team domain, `aud` = the application's AUD tag, and `exp` against `now`.
 * The identity is the token's `email` claim, lower-cased. Tests pass a local `jwks`.
 */
export async function verifyAccessJwt(token: string, cfg: AccessJwtConfig, now: Date = new Date()): Promise<AccessJwtResult> {
  if (!token) return { ok: false, error: "MISSING" };
  const issuer = accessIssuer(cfg.teamDomain);
  try {
    const { payload } = await jwtVerify(token, cfg.jwks ?? remoteJwks(issuer), {
      algorithms: ["RS256"],
      issuer,
      audience: cfg.aud,
      requiredClaims: ["exp"],
      currentDate: now,
    });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email) return { ok: false, error: "INVALID" };
    return { ok: true, email };
  } catch (e) {
    if (e instanceof errors.JWTExpired) return { ok: false, error: "EXPIRED" };
    if (e instanceof errors.JWTClaimValidationFailed) {
      if (e.claim === "aud") return { ok: false, error: "WRONG_AUD" };
      if (e.claim === "iss") return { ok: false, error: "WRONG_ISS" };
    }
    // Bad signature, unknown key, malformed token, a JWKS fetch failure: all just "not valid".
    return { ok: false, error: "INVALID" };
  }
}
