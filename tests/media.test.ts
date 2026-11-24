import { afterEach, describe, expect, test, vi } from "vitest";
import { mediaSrcSet, mediaUrl, originalOfVariant, variantKey } from "@/lib/media";

describe("media URLs", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("without transforms the original is served at any width", () => {
    vi.stubEnv("NEXT_PUBLIC_CF_IMAGES", "");
    vi.stubEnv("NEXT_PUBLIC_MEDIA_VARIANTS", "");
    expect(mediaUrl("rooms/rooms_76.jpg", 800)).toBe("/media/rooms/rooms_76.jpg");
    expect(mediaSrcSet("rooms/rooms_76.jpg", 1100)).toBeUndefined();
  });

  test("Cloudflare Images wins over variants", () => {
    vi.stubEnv("NEXT_PUBLIC_CF_IMAGES", "1");
    vi.stubEnv("NEXT_PUBLIC_MEDIA_VARIANTS", "1");
    expect(mediaUrl("rooms/rooms_76.jpg", 800)).toBe("/cdn-cgi/image/width=800,quality=80,format=auto/media/rooms/rooms_76.jpg");
  });

  test("variants: smallest width that covers the request, never above the largest", () => {
    vi.stubEnv("NEXT_PUBLIC_CF_IMAGES", "");
    vi.stubEnv("NEXT_PUBLIC_MEDIA_VARIANTS", "1");
    expect(mediaUrl("rooms/rooms_76.jpg", 400)).toBe("/media/_w480/rooms/rooms_76.jpg.webp");
    expect(mediaUrl("rooms/rooms_76.jpg", 600)).toBe("/media/_w800/rooms/rooms_76.jpg.webp");
    expect(mediaUrl("rooms/rooms_76.jpg", 2000)).toBe("/media/_w1100/rooms/rooms_76.jpg.webp");
    expect(mediaUrl("rooms/rooms_76.jpg")).toBe("/media/rooms/rooms_76.jpg");
    expect(mediaSrcSet("rooms/rooms_131.jpg", 790)).toBe("/media/_w480/rooms/rooms_131.jpg.webp 480w, /media/_w800/rooms/rooms_131.jpg.webp 790w");
  });

  test("variant keys map back to their original", () => {
    expect(variantKey("rooms/rooms_76.jpg", 800)).toBe("_w800/rooms/rooms_76.jpg.webp");
    expect(originalOfVariant("_w800/rooms/rooms_76.jpg.webp")).toBe("rooms/rooms_76.jpg");
    expect(originalOfVariant("rooms/rooms_76.jpg")).toBeNull();
  });
});
