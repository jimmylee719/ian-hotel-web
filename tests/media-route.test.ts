import { afterEach, describe, expect, test, vi } from "vitest";

const CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";

/** The /media route over a fake R2 bucket holding `keys`. */
async function route(keys: string[]) {
  vi.resetModules();
  const MEDIA = {
    get: async (k: string) => (keys.includes(k)
      ? { key: k, body: new Uint8Array([0xff, 0xd8, 0xff]), httpEtag: '"e"', httpMetadata: { contentType: "image/jpeg" } }
      : null),
  };
  vi.doMock("@opennextjs/cloudflare", () => ({ getCloudflareContext: async () => ({ env: { MEDIA } }) }));
  const { GET } = await import("@/app/media/[...key]/route");
  return (key: string) => GET(new Request(`https://x/media/${key}`), { params: Promise.resolve({ key: key.split("/") }) });
}

afterEach(() => vi.doUnmock("@opennextjs/cloudflare"));

describe("/media responses (M-4)", () => {
  test("a served object is nosniff and sandboxed by CSP", async () => {
    const get = await route(["rooms/a.jpg"]);
    const r = await get("rooms/a.jpg");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("image/jpeg");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("Content-Security-Policy")).toBe(CSP);
  });

  test("404s carry the same headers", async () => {
    const get = await route([]);
    for (const key of ["rooms/missing.jpg", "..%2Fsecret"]) {
      const r = await get(key);
      expect(r.status).toBe(404);
      expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(r.headers.get("Content-Security-Policy")).toBe(CSP);
    }
  });
});
