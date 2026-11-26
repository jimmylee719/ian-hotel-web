import { getTranslations } from "next-intl/server";
import type { Locale } from "@/lib/db/schema";

/**
 * The 測試用 labels of a test site (isTestSite in lib/runtime/env.ts: local dev and the public preview, where bookings
 * and payments are simulated). Callers decide whether the site is one; these only render the text. Not dismissible.
 */

/** Full-width strip above the header on every public page. Wraps on its own line, so the header's row never does. */
export async function TestSiteBanner({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "testMode" });
  return (
    <div className="test-banner" role="note">
      <p className="wrap">{t("banner")}</p>
    </div>
  );
}

/** The short note next to a booking or payment action; `noEmail` adds that the test site sends no confirmation email. */
export async function TestNote({ locale, noEmail = false }: { locale: Locale; noEmail?: boolean }) {
  const t = await getTranslations({ locale, namespace: "testMode" });
  return (
    <p className="test-note" role="note">
      {t("note")}
      {noEmail && (
        <>
          <br />
          {t("noEmail")}
        </>
      )}
    </p>
  );
}
