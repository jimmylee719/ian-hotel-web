import type zhTW from "./messages/zh-TW.json";
import type { routing } from "./i18n/routing";

/**
 * Types next-intl's translators against the zh-TW messages (the reference locale; the other three are
 * held to the same keys by tests/i18n/messages.test.ts), so `t("missing.key")` fails `tsc` and `next build`.
 */
declare module "next-intl" {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: typeof zhTW;
  }
}
