import type { MetadataRoute } from "next";
import { appEnv } from "@/lib/runtime/env";
import { robotsFor } from "@/lib/seo";

// Per request: the answer depends on the Worker's ENVIRONMENT, which is only known at run time.
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  return robotsFor(await appEnv());
}
