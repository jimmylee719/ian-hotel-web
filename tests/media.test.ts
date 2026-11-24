import { afterEach, describe, expect, test, vi } from "vitest";
import { findMedia, mediaSrcSet, mediaUrl, originalOfVariant, variantKey } from "@/lib/media";

describe("media URLs", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("by default (no env flags) a width request uses a WebP variant", () => {
    vi.stubEnv("NEXT_PUBLIC_CF_IMAGES", "");
    expect(mediaUrl("rooms/rooms_76.jpg", 400)).toBe("/media/_w480/rooms/rooms_76.jpg.webp");
    expect(mediaUrl("rooms/rooms_76.jpg", 600)).toBe("/media/_w800/rooms/rooms_76.jpg.webp");
    expect(mediaUrl("rooms/rooms_76.jpg", 2000)).toBe("/media/_w1100/rooms/rooms_76.jpg.webp");
    expect(mediaSrcSet("rooms/rooms_131.jpg", 790)).toBe("/media/_w480/rooms/rooms_131.jpg.webp 480w, /media/_w800/rooms/rooms_131.jpg.webp 790w");
  });

  test("without a width the original is served", () => {
    expect(mediaUrl("rooms/rooms_76.jpg")).toBe("/media/rooms/rooms_76.jpg");
    expect(mediaUrl("/rooms/rooms_76.jpg")).toBe("/media/rooms/rooms_76.jpg");
  });

  test("NEXT_PUBLIC_CF_IMAGES=1 switches to Cloudflare Images", () => {
    vi.stubEnv("NEXT_PUBLIC_CF_IMAGES", "1");
    expect(mediaUrl("rooms/rooms_76.jpg", 800)).toBe("/cdn-cgi/image/width=800,quality=80,format=auto/media/rooms/rooms_76.jpg");
    expect(mediaSrcSet("rooms/rooms_76.jpg", 1100)).toContain("/cdn-cgi/image/width=480,");
  });

  test("variant keys map back to their original", () => {
    expect(variantKey("rooms/rooms_76.jpg", 800)).toBe("_w800/rooms/rooms_76.jpg.webp");
    expect(originalOfVariant("_w800/rooms/rooms_76.jpg.webp")).toBe("rooms/rooms_76.jpg");
    expect(originalOfVariant("rooms/rooms_76.jpg")).toBeNull();
  });
});

describe("findMedia (the /media route lookup)", () => {
  const bucket = (keys: string[]) => {
    const get = vi.fn(async (k: string) => (keys.includes(k) ? { key: k } : null));
    return { get };
  };

  test("serves an existing variant as is", async () => {
    const b = bucket(["_w800/rooms/rooms_76.jpg.webp", "rooms/rooms_76.jpg"]);
    expect(await findMedia(b, "_w800/rooms/rooms_76.jpg.webp")).toEqual({ object: { key: "_w800/rooms/rooms_76.jpg.webp" }, fallback: false });
  });

  test("a missing variant falls back to the original instead of 404", async () => {
    const b = bucket(["rooms/rooms_76.jpg"]);
    expect(await findMedia(b, "_w800/rooms/rooms_76.jpg.webp")).toEqual({ object: { key: "rooms/rooms_76.jpg" }, fallback: true });
  });

  test("a missing original, or a missing non-variant key, is null (404)", async () => {
    expect(await findMedia(bucket([]), "_w800/rooms/rooms_76.jpg.webp")).toBeNull();
    const b = bucket(["rooms/rooms_76.jpg"]);
    expect(await findMedia(b, "rooms/missing.jpg")).toBeNull();
    expect(b.get).toHaveBeenCalledTimes(1);
  });
});
