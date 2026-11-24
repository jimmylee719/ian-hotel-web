import { getCloudflareContext } from "@opennextjs/cloudflare";
import { contentTypeFor, isValidMediaKey } from "@/lib/media";

/** Serves objects from the R2 bucket `nk-media` (binding MEDIA). Keys are immutable, so cache for a year. */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const key = (await params).key.map(decodeURIComponent).join("/");
  if (!isValidMediaKey(key)) return new Response("Not found", { status: 404 });

  const { env } = await getCloudflareContext({ async: true });
  const object = await env.MEDIA.get(key);
  if (!object) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? contentTypeFor(key),
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: object.httpEtag,
    },
  });
}
