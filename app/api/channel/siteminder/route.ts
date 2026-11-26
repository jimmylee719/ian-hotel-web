import { handleSiteMinderInbound } from "@/lib/channel/siteminder/inbound/dispatch";
import { getDb } from "@/lib/db/client";
import { appEnv } from "@/lib/runtime/env";

export const dynamic = "force-dynamic";

/**
 * SiteMinder SiteConnect inbound SOAP endpoint (Rooms and Rates now, ARI in Task 4). POST only: Next answers 405 to
 * other methods. Credentials are our secrets SITEMINDER_INBOUND_USERNAME / SITEMINDER_INBOUND_PASSWORD; while
 * either is unset (always, on the preview) every request is refused with the docs' Type 4 / Code 448 error.
 */
export async function POST(req: Request) {
  const env = await appEnv();
  return handleSiteMinderInbound(
    { db: await getDb(), username: env.SITEMINDER_INBOUND_USERNAME, password: env.SITEMINDER_INBOUND_PASSWORD },
    req,
    new Date(),
  );
}
