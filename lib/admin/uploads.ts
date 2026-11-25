import { VARIANT_WIDTHS, variantKey } from "@/lib/media";
import type { StaffContext } from "./auth";
import { can } from "./permissions";

/** Largest photo staff may upload. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export type ImageFormat = "jpeg" | "png" | "webp" | "avif";

const FORMATS: Record<ImageFormat, { ext: string; contentType: string }> = {
  jpeg: { ext: "jpg", contentType: "image/jpeg" },
  png: { ext: "png", contentType: "image/png" },
  webp: { ext: "webp", contentType: "image/webp" },
  avif: { ext: "avif", contentType: "image/avif" },
};

/** Where an upload may go: a room's folder, or the news / pages folders. */
export type UploadPrefix = `rooms/${string}` | "news" | "pages";
const PREFIX = /^(rooms\/[a-z0-9][a-z0-9-]{0,79}|news|pages)$/;

/** The parts of the R2 binding uploads use (a fake in tests). */
export type MediaBucket = {
  put(key: string, value: Uint8Array | ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
};

/** Resize `bytes` to at most `width` px wide (never wider than the source) and return WebP bytes. */
export type ImageResizer = (bytes: Uint8Array, width: number) => Promise<Uint8Array | ArrayBuffer>;

export type UploadEnv = { MEDIA: MediaBucket; IMAGES?: ImagesBinding };
export type UploadOptions = {
  /** Overrides the resizer built from `env.IMAGES` (tests). */
  resize?: ImageResizer;
  /** Called when a variant could not be made; the upload still succeeds with the original. */
  onVariantError?: (key: string, width: number, error: unknown) => void;
};

export type UploadResult = { ok: true; key: string } | { ok: false; error: "TOO_LARGE" | "BAD_TYPE" | "BAD_PREFIX" | "FORBIDDEN" };

const ascii = (b: Uint8Array, at: number, s: string) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));

/**
 * The image format from the file's magic bytes, or null. What the browser claims (content type, file
 * name) is never trusted: SVG, HTML and anything else that is not one of the four formats is null.
 */
export function sniffImage(b: Uint8Array): ImageFormat | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 4 && b[0] === 0x89 && ascii(b, 1, "PNG")) return "png";
  if (b.length >= 12 && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "webp";
  if (b.length >= 12 && (ascii(b, 4, "ftypavif") || ascii(b, 4, "ftypavis"))) return "avif";
  return null;
}

/** Cloudflare Images: `width` px WebP, never upscaled (the same as scripts/media-variants.ts). */
export function imagesResizer(images: ImagesBinding): ImageResizer {
  return async (bytes, width) => {
    const out = await images
      .input(new Blob([bytes as BlobPart]).stream())
      .transform({ width, fit: "scale-down" })
      .output({ format: "image/webp", quality: 72 });
    return new Uint8Array(await out.response().arrayBuffer());
  };
}

/**
 * Store a staff photo upload in R2 as `<prefix>/<uuid>.<ext>` and return its key. The type (from magic
 * bytes) and the 8 MB cap are checked before anything is written. With a Cloudflare Images binding the
 * WebP width variants the site requests (lib/media.ts `variantKey`) are written too; without one (local
 * dev, tests) only the original is stored and the media route serves it in place of a missing variant.
 */
export async function uploadImage(
  env: UploadEnv,
  ctx: StaffContext,
  file: { bytes: Uint8Array; contentType: string; filename: string },
  prefix: UploadPrefix,
  opts: UploadOptions = {},
): Promise<UploadResult> {
  if (!can(ctx.staff, "content.edit")) return { ok: false, error: "FORBIDDEN" };
  if (!PREFIX.test(prefix)) return { ok: false, error: "BAD_PREFIX" };
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, error: "TOO_LARGE" };
  const format = sniffImage(file.bytes);
  if (!format) return { ok: false, error: "BAD_TYPE" };

  const { ext, contentType } = FORMATS[format];
  const key = `${prefix}/${crypto.randomUUID()}.${ext}`;
  await env.MEDIA.put(key, file.bytes, { httpMetadata: { contentType } });

  const resize = opts.resize ?? (env.IMAGES ? imagesResizer(env.IMAGES) : null);
  if (resize)
    for (const width of VARIANT_WIDTHS) {
      try {
        await env.MEDIA.put(variantKey(key, width), await resize(file.bytes, width), { httpMetadata: { contentType: "image/webp" } });
      } catch (e) {
        (opts.onVariantError ?? ((k, w, err) => console.error(`variant ${w} of ${k} failed`, err)))(key, width, e);
      }
    }
  return { ok: true, key };
}
