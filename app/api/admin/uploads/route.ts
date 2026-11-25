import { getCloudflareContext } from "@opennextjs/cloudflare";
import { eq } from "drizzle-orm";
import { actionError } from "@/lib/admin/action-messages";
import { withAdmin } from "@/lib/admin/auth";
import { can } from "@/lib/admin/permissions";
import { currentProperty } from "@/lib/admin/property-scope";
import { MAX_UPLOAD_BYTES, uploadImage, type UploadPrefix } from "@/lib/admin/uploads";
import { getDb } from "@/lib/db/client";
import { unitTypes } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/**
 * Upload one photo (multipart form). Fields: `file`, and `unitTypeId` for a room photo or `target`
 * ("news" | "pages") otherwise. Answers `{ ok, key }`; the key is not used anywhere until the caller saves
 * it into a photo list (e.g. PATCH /api/admin/content/rooms/:id `images`).
 */
const handle = withAdmin("content.edit", async (ctx, req) => {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File)) return actionError("BAD_REQUEST");

  let prefix: UploadPrefix;
  const unitTypeId = form.get("unitTypeId");
  if (typeof unitTypeId === "string" && unitTypeId) {
    const [u] = await (await getDb()).select({ slug: unitTypes.slug, propertyId: unitTypes.propertyId }).from(unitTypes).where(eq(unitTypes.id, unitTypeId));
    if (!u) return actionError("NOT_FOUND");
    if (!can(ctx.staff, "content.edit", u.propertyId)) return actionError("FORBIDDEN");
    prefix = `rooms/${u.slug}`;
  } else {
    const target = form.get("target");
    if (target !== "news" && target !== "pages") return actionError("BAD_PREFIX");
    if (!can(ctx.staff, "content.edit", await currentProperty(ctx))) return actionError("FORBIDDEN");
    prefix = target;
  }

  if (file.size > MAX_UPLOAD_BYTES) return actionError("TOO_LARGE");
  const { env } = await getCloudflareContext({ async: true });
  const r = await uploadImage({ MEDIA: env.MEDIA, IMAGES: env.IMAGES }, ctx, {
    bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type, filename: file.name,
  }, prefix);
  if (!r.ok) return actionError(r.error);
  return Response.json(r, { headers: { "Cache-Control": "no-store" } });
});

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}
