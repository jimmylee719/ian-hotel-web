import { getCloudflareContext } from "@opennextjs/cloudflare";
import { contentTypeFor, findMedia, isValidMediaKey } from "@/lib/media";

/** Serves objects from the R2 bucket `nk-media` (binding MEDIA). Keys are immutable, so cache for a year. */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const key = (await params).key.map(decodeURIComponent).join("/");
  if (!isValidMediaKey(key)) return new Response("Not found", { status: 404 });

  const { env } = await getCloudflareContext({ async: true });
  // A missing pre-generated variant (lib/media.ts) falls back to its original.
  const found = await findMedia(env.MEDIA, key);
  if (!found) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

  const { object, fallback } = found;
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? contentTypeFor(object.key),
      // A fallback is cached briefly so a variant uploaded later takes over.
      "Cache-Control": fallback ? "public, max-age=3600" : "public, max-age=31536000, immutable",
      ETag: object.httpEtag,
    },
  });
}
