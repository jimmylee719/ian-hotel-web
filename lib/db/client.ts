import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import type { Db } from "./types";

/** D1-backed database for the current request (Workers runtime). */
export async function getDb(): Promise<Db> {
  const { env } = await getCloudflareContext({ async: true });
  return drizzle(env.DB, { schema }) as unknown as Db;
}
