import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type JWTVerifyGetKey } from "jose";

export const TEAM_DOMAIN = "nkhostel.cloudflareaccess.com";
export const ISSUER = `https://${TEAM_DOMAIN}`;
export const AUD = "test-aud-123";

export type Signer = { jwks: JWTVerifyGetKey; sign: (claims?: Record<string, unknown>, opts?: SignOpts) => Promise<string> };
type SignOpts = { aud?: string; iss?: string; exp?: number; iat?: number };

/** A local RS256 key and its JWKS, standing in for Cloudflare Access's /cdn-cgi/access/certs. */
export async function makeSigner(kid = "k1"): Promise<Signer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return { jwks: createLocalJWKSet({ keys: [jwk] }), sign: (claims, opts) => signWith(privateKey, kid, claims, opts) };
}

async function signWith(key: CryptoKey, kid: string, claims: Record<string, unknown> = {}, opts: SignOpts = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: "Front@NKHostel.com", ...claims })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt(opts.iat ?? now)
    .setExpirationTime(opts.exp ?? now + 3600)
    .sign(key);
}
