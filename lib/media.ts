/**
 * Public URL for an object in the R2 bucket `nk-media` (served by app/media/[...key]/route.ts).
 *
 * A width request is served:
 * - by default, as a pre-generated WebP in R2 (scripts/media-variants.ts, `npm run media:variants`)
 *   at the smallest variant width that covers the request; the media route falls back to the
 *   original if the variant is missing (see findMedia);
 * - with NEXT_PUBLIC_CF_IMAGES=1 (opt-in: zone with Cloudflare Images transformations enabled),
 *   through `/cdn-cgi/image/...`.
 * Without a width, the original is served unchanged.
 */
export const VARIANT_WIDTHS = [480, 800, 1100] as const;

/** R2 key of a pre-generated WebP variant: `_w800/rooms/rooms_76.jpg.webp`. */
export function variantKey(key: string, width: number): string {
  return `_w${width}/${key}.webp`;
}

/** The original key behind a variant key, or null if `key` is not a variant. */
export function originalOfVariant(key: string): string | null {
  return /^_w\d+\/(.+)\.webp$/.exec(key)?.[1] ?? null;
}

export function mediaUrl(key: string, w?: number): string {
  const clean = key.replace(/^\/+/, "");
  const path = `/media/${clean}`;
  if (w && process.env.NEXT_PUBLIC_CF_IMAGES === "1") return `/cdn-cgi/image/width=${w},quality=80,format=auto${path}`;
  if (w) {
    const width = VARIANT_WIDTHS.find((v) => v >= w) ?? VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];
    return `/media/${variantKey(clean, width)}`;
  }
  return path;
}

/** `srcset` for a photo whose source is `sourceWidth` px wide (no upscaling). */
export function mediaSrcSet(key: string, sourceWidth: number): string {
  const widths = VARIANT_WIDTHS.filter((w) => w < sourceWidth);
  return [...widths, sourceWidth].map((w) => `${mediaUrl(key, w)} ${w}w`).join(", ");
}

/**
 * Looks up a media key in R2; a missing variant falls back to its original key so a variant that
 * was never generated still shows the photo. `fallback` tells the caller to cache briefly.
 */
export async function findMedia<T>(bucket: { get(key: string): Promise<T | null> }, key: string): Promise<{ object: T; fallback: boolean } | null> {
  const object = await bucket.get(key);
  if (object) return { object, fallback: false };
  const original = originalOfVariant(key);
  const fallback = original ? await bucket.get(original) : null;
  return fallback ? { object: fallback, fallback: true } : null;
}

const TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  svg: "image/svg+xml",
};

export function contentTypeFor(key: string): string {
  return TYPES[key.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

/** Rejects empty keys and path traversal; R2 keys are plain `dir/file.ext`. */
export function isValidMediaKey(key: string): boolean {
  return key.length > 0 && key.length < 512 && !key.split("/").some((s) => s === "" || s === "." || s === "..");
}
