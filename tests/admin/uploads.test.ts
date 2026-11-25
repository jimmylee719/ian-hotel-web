import { describe, expect, test } from "vitest";
import type { StaffContext } from "@/lib/admin/auth";
import { MAX_UPLOAD_BYTES, sniffImage, uploadImage, type ImageResizer, type MediaBucket } from "@/lib/admin/uploads";
import { VARIANT_WIDTHS, variantKey } from "@/lib/media";

const ctx = (role: "marketing" | "front_desk" = "marketing"): StaffContext => ({
  staff: { id: "s1", email: "m@nk.test", name: "M", role, propertyIds: ["p1"], active: true },
  email: "m@nk.test",
});

/** A fake R2 bucket that records every put. */
function fakeBucket(): MediaBucket & { puts: { key: string; contentType?: string; size: number }[] } {
  const puts: { key: string; contentType?: string; size: number }[] = [];
  return {
    puts,
    async put(key, value, opts) {
      const size = value instanceof Uint8Array ? value.byteLength : (value as ArrayBuffer).byteLength;
      puts.push({ key, contentType: opts?.httpMetadata?.contentType, size });
      return null;
    },
  };
}

const bytes = (...head: number[]) => {
  const b = new Uint8Array(64);
  b.set(head);
  return b;
};
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const WEBP = bytes(...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBP"));
const AVIF = bytes(0, 0, 0, 0x1c, ...ascii("ftypavif"));
const AVIS = bytes(0, 0, 0, 0x1c, ...ascii("ftypavis"));
const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

describe("sniffImage", () => {
  test("recognises the four allowed formats by their magic bytes only", () => {
    expect(sniffImage(JPEG)).toBe("jpeg");
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(WEBP)).toBe("webp");
    expect(sniffImage(AVIF)).toBe("avif");
    expect(sniffImage(AVIS)).toBe("avif");
    expect(sniffImage(HTML)).toBeNull();
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(bytes(...ascii("GIF89a")))).toBeNull();
    expect(sniffImage(bytes(...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAVE")))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe("uploadImage", () => {
  test("HTML labelled image/jpeg is BAD_TYPE and nothing is written", async () => {
    const MEDIA = fakeBucket();
    expect(await uploadImage({ MEDIA }, ctx(), { bytes: HTML, contentType: "image/jpeg", filename: "a.jpg" }, "rooms/deluxe-room"))
      .toEqual({ ok: false, error: "BAD_TYPE" });
    expect(await uploadImage({ MEDIA }, ctx(), { bytes: SVG, contentType: "image/svg+xml", filename: "a.svg" }, "news"))
      .toEqual({ ok: false, error: "BAD_TYPE" });
    expect(MEDIA.puts).toEqual([]);
  });

  test("9 MB is TOO_LARGE and nothing is written", async () => {
    const MEDIA = fakeBucket();
    const big = new Uint8Array(9 * 1024 * 1024);
    big.set(PNG);
    expect(await uploadImage({ MEDIA }, ctx(), { bytes: big, contentType: "image/png", filename: "big.png" }, "rooms/deluxe-room"))
      .toEqual({ ok: false, error: "TOO_LARGE" });
    expect(MAX_UPLOAD_BYTES).toBe(8 * 1024 * 1024);
    expect(MEDIA.puts).toEqual([]);
  });

  test("a PNG is stored as rooms/<slug>/<uuid>.png with the sniffed content type; no IMAGES binding = original only", async () => {
    const MEDIA = fakeBucket();
    const r = await uploadImage({ MEDIA }, ctx(), { bytes: PNG, contentType: "application/octet-stream", filename: "x.jpg" }, "rooms/deluxe-room");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.key).toMatch(new RegExp(`^rooms/deluxe-room/${UUID.source}\\.png$`));
    expect(MEDIA.puts).toEqual([{ key: r.key, contentType: "image/png", size: PNG.byteLength }]);
  });

  test("with a resizer, every variant width is written as WebP where findMedia looks for it", async () => {
    const MEDIA = fakeBucket();
    const calls: number[] = [];
    const resize: ImageResizer = async (_b, width) => (calls.push(width), new Uint8Array(width));
    const r = await uploadImage({ MEDIA }, ctx(), { bytes: JPEG, contentType: "image/jpeg", filename: "a.jpg" }, "news", { resize });
    if (!r.ok) throw new Error("upload failed");
    expect(r.key).toMatch(new RegExp(`^news/${UUID.source}\\.jpg$`));
    expect(calls).toEqual([...VARIANT_WIDTHS]);
    expect(MEDIA.puts).toEqual([
      { key: r.key, contentType: "image/jpeg", size: JPEG.byteLength },
      ...VARIANT_WIDTHS.map((w) => ({ key: variantKey(r.key, w), contentType: "image/webp", size: w })),
    ]);
  });

  test("a failing resizer keeps the original (findMedia falls back to it)", async () => {
    const MEDIA = fakeBucket();
    const resize: ImageResizer = async () => { throw new Error("images down"); };
    const r = await uploadImage({ MEDIA }, ctx(), { bytes: WEBP, contentType: "image/webp", filename: "a.webp" }, "pages", { resize, onVariantError: () => {} });
    expect(r.ok).toBe(true);
    expect(MEDIA.puts.map((p) => p.key)).toEqual([r.ok ? r.key : ""]);
  });

  test("rejects a bad prefix and staff without content.edit", async () => {
    const MEDIA = fakeBucket();
    const file = { bytes: PNG, contentType: "image/png", filename: "a.png" };
    expect(await uploadImage({ MEDIA }, ctx(), file, "rooms/../x" as never)).toEqual({ ok: false, error: "BAD_PREFIX" });
    expect(await uploadImage({ MEDIA }, ctx(), file, "other" as never)).toEqual({ ok: false, error: "BAD_PREFIX" });
    expect(await uploadImage({ MEDIA }, ctx("front_desk"), file, "news")).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(MEDIA.puts).toEqual([]);
  });
});
