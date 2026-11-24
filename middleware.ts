import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

// `/` redirects to the visitor's language (Accept-Language, then the NEXT_LOCALE cookie), default zh-TW.
export default createMiddleware(routing);

export const config = {
  // Everything except API routes, dev tools, R2 media, Next internals and files with an extension.
  matcher: ["/((?!api|dev|media|_next|_vercel|.*\\..*).*)"],
};
