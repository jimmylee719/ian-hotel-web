import { describe, expect, it } from "vitest";
import { verifyAccessJwt } from "@/lib/admin/access-jwt";
import { AUD, ISSUER, TEAM_DOMAIN, makeSigner } from "./jwt-fixture";

describe("verifyAccessJwt", () => {
  it("accepts a valid token and lower-cases the email", async () => {
    const s = await makeSigner();
    const r = await verifyAccessJwt(await s.sign(), { teamDomain: TEAM_DOMAIN, aud: AUD, jwks: s.jwks });
    expect(r).toEqual({ ok: true, email: "front@nkhostel.com" });
  });

  it("accepts a team domain configured with the scheme and a trailing slash", async () => {
    const s = await makeSigner();
    const r = await verifyAccessJwt(await s.sign(), { teamDomain: `${ISSUER}/`, aud: AUD, jwks: s.jwks });
    expect(r.ok).toBe(true);
  });

  it("rejects a wrong audience", async () => {
    const s = await makeSigner();
    const r = await verifyAccessJwt(await s.sign({}, { aud: "other-app" }), { teamDomain: TEAM_DOMAIN, aud: AUD, jwks: s.jwks });
    expect(r).toEqual({ ok: false, error: "WRONG_AUD" });
  });

  it("rejects a wrong issuer", async () => {
    const s = await makeSigner();
    const r = await verifyAccessJwt(await s.sign({}, { iss: "https://evil.cloudflareaccess.com" }), { teamDomain: TEAM_DOMAIN, aud: AUD, jwks: s.jwks });
    expect(r).toEqual({ ok: false, error: "WRONG_ISS" });
  });

  it("rejects an expired token", async () => {
    const s = await makeSigner();
    const past = Math.floor(Date.now() / 1000) - 7200;
    const r = await verifyAccessJwt(await s.sign({}, { iat: past, exp: past + 60 }), { teamDomain: TEAM_DOMAIN, aud: AUD, jwks: s.jwks });
    expect(r).toEqual({ ok: false, error: "EXPIRED" });
  });

  it("honours the injected clock", async () => {
    const s = await makeSigner();
    const token = await s.sign();
    const later = new Date(Date.now() + 2 * 3600_000);
    expect(await verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, aud: AUD, jwks: s.jwks }, later)).toEqual({ ok: false, error: "EXPIRED" });
  });

  it("rejects a token signed by another key", async () => {
    const trusted = await makeSigner();
    const attacker = await makeSigner();
    const r = await verifyAccessJwt(await attacker.sign(), { teamDomain: TEAM_DOMAIN, aud: AUD, jwks: trusted.jwks });
    expect(r).toEqual({ ok: false, error: "INVALID" });
  });

  it("rejects a token without an email claim", async () => {
    const s = await makeSigner();
    const r = await verifyAccessJwt(await s.sign({ email: undefined }), { teamDomain: TEAM_DOMAIN, aud: AUD, jwks: s.jwks });
    expect(r).toEqual({ ok: false, error: "INVALID" });
  });

  it("rejects garbage and the empty string", async () => {
    const s = await makeSigner();
    expect(await verifyAccessJwt("", { teamDomain: TEAM_DOMAIN, aud: AUD, jwks: s.jwks })).toEqual({ ok: false, error: "MISSING" });
    expect(await verifyAccessJwt("not.a.jwt", { teamDomain: TEAM_DOMAIN, aud: AUD, jwks: s.jwks })).toEqual({ ok: false, error: "INVALID" });
  });
});
