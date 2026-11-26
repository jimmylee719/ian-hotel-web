import { getCloudflareContext } from "@opennextjs/cloudflare";
import { handleSiteMinderInbound } from "@/lib/channel/siteminder/inbound/dispatch";
import { getDb } from "@/lib/db/client";
import { buildOpsDeps } from "@/lib/runtime/deps";
import { appEnv } from "@/lib/runtime/env";

export const dynamic = "force-dynamic";

/** The Worker's ctx.waitUntil, when there is one (not in next dev without a context, nor in tests). */
async function waitUntil(): Promise<((work: Promise<unknown>) => void) | undefined> {
  try {
    const { ctx } = await getCloudflareContext({ async: true });
    if (typeof ctx?.waitUntil === "function") return (work) => ctx.waitUntil(work);
  } catch {
    // No Cloudflare context.
  }
  return undefined;
}

/**
 * SiteMinder SiteConnect inbound SOAP endpoint: Rooms and Rates and ARI (docs/integrations/siteminder.md §4).
 * POST only: Next answers 405 to other methods. Credentials are our secrets SITEMINDER_INBOUND_USERNAME /
 * SITEMINDER_INBOUND_PASSWORD; while either is unset (always, on the preview) every request is refused with the
 * docs' Type 4 / Code 448 error. Ops alerts about repeated ARI rejections are sent after the answer.
 */
export async function POST(req: Request) {
  const env = await appEnv();
  const db = await getDb();
  return handleSiteMinderInbound(
    {
      db, username: env.SITEMINDER_INBOUND_USERNAME, password: env.SITEMINDER_INBOUND_PASSWORD,
      ops: buildOpsDeps(env, db), defer: await waitUntil(),
    },
    req,
    new Date(),
  );
}
