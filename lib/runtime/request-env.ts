import { connection } from "next/server";
import { guestBookingOpen } from "./deps";
import { appEnv, type AppEnv } from "./env";

/**
 * The Worker's env for something being RENDERED (pages, layouts, metadata, robots.txt, the mock pay page).
 * `connection()` first: it makes the render request-time. A prerender at build time has no Worker env, so appEnv()
 * would read the build machine's top-level wrangler vars (ENVIRONMENT "local", PAYMENT_MODE "mock") and bake the
 * 測試用 banner, the noindex tag or an open booking flow into a production page. With this, an env-dependent render
 * can never be static, even on a route that forgets `dynamic = "force-dynamic"`. Route handlers, server actions and
 * the cron, which already run per request or per tick, may keep using appEnv().
 */
export async function requestEnv(): Promise<Awaited<ReturnType<typeof appEnv>>> {
  await connection();
  return appEnv();
}

/**
 * Can guests start a new booking (deps.guestBookingOpen) for this request? In `next dev` the BOOKING_OPEN switch
 * may also come from the shell (`BOOKING_OPEN=false npm run dev`).
 */
export async function bookingEnabled(): Promise<boolean> {
  return guestBookingOpen(await requestEnv(), { BOOKING_OPEN: typeof process === "undefined" ? undefined : process.env.BOOKING_OPEN });
}

export type { AppEnv };
