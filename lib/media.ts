/**
 * Public URL for an object in the R2 bucket `nk-media` (served by app/media/[...key]/route.ts).
 *
 * With NEXT_PUBLIC_CF_IMAGES=1 (production, zone with Cloudflare Images transformations enabled) a
 * width request goes through `/cdn-cgi/image/...`; locally the original is returned unchanged.
 */
export function mediaUrl(key: string, w?: number): string {
  const path = `/media/${key.replace(/^\/+/, "")}`;
  if (w && process.env.NEXT_PUBLIC_CF_IMAGES === "1") return `/cdn-cgi/image/width=${w},quality=80,format=auto${path}`;
  return path;
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
