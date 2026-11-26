import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createTranslator } from "next-intl";
import { formatPrice } from "@/components/booking/format";
import { CjkFonts } from "@/components/layout/CjkFonts";
import { routing } from "@/i18n/routing";
import type { Locale } from "@/lib/db/schema";
import {
  buildMockPayment, isMockPaymentMode, MOCK_DEFAULT_SECRET, mockPayOrigins, mockPayTargetsValid, reservationCodeFromRef,
} from "@/lib/payments/mock-page";
import { appEnv } from "@/lib/runtime/env";
import en from "@/messages/en.json";
import ja from "@/messages/ja.json";
import ko from "@/messages/ko.json";
import zhTW from "@/messages/zh-TW.json";

export const dynamic = "force-dynamic";

/**
 * The mock gateway's payment page (MockSinoPacGateway.startCharge redirects here), on a test site only (local dev and
 * the public preview; 404 everywhere else). Clearly labelled 模擬付款（測試用）: it shows the booking code and amount
 * and two buttons that post a signed success / failure notice to this site's own /api/payments/notify, exactly as
 * the real gateway would, then send the guest back to the return page. It never asks for card or bank details: the
 * only inputs are hidden fields. Both target URLs must be this site's own (mockPayTargetsValid), on the page and in
 * the action, so the public page cannot post notices elsewhere or redirect off-site.
 */
type Search = { code?: string; amount?: string; locale?: string; returnUrl?: string; notifyUrl?: string };

const MESSAGES = { "zh-TW": zhTW, en, ja, ko } as const;

function pageLocale(l: string | undefined): Locale {
  return (routing.locales as readonly string[]).includes(l ?? "") ? (l as Locale) : routing.defaultLocale;
}

/** This request's origin (local dev without BASE_URL); BASE_URL wins whenever it is set (mockPayOrigins). */
async function requestOrigin(): Promise<string | undefined> {
  const h = await headers();
  const host = h.get("host");
  if (!host) return undefined;
  const proto = h.get("x-forwarded-proto") ?? (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

/** The checked inputs of a pay request, or null (the caller 404s) when anything is missing, malformed or off-site. */
async function checked(env: { BASE_URL?: string }, p: { ref: string; code?: string; amount?: string; notifyUrl?: string; returnUrl?: string }) {
  const { ref, code = "", notifyUrl = "", returnUrl = "" } = p;
  const amount = Number(p.amount);
  if (!code || reservationCodeFromRef(ref) !== code || !Number.isSafeInteger(amount) || amount < 0) return null;
  if (!mockPayTargetsValid({ notifyUrl, returnUrl, code }, mockPayOrigins(env.BASE_URL, await requestOrigin()))) return null;
  return { ref, code, amount, notifyUrl, returnUrl };
}

async function pay(formData: FormData) {
  "use server";
  const env = await appEnv();
  if (!isMockPaymentMode(env)) notFound();
  const field = (name: string) => {
    const v = formData.get(name);
    return typeof v === "string" ? v : undefined;
  };
  const p = await checked(env, {
    ref: field("ref") ?? "", code: field("code"), amount: field("amount"), notifyUrl: field("notifyUrl"), returnUrl: field("returnUrl"),
  });
  if (!p) notFound();
  const outcome = formData.get("outcome") === "succeeded" ? "succeeded" : "failed";
  const { headers: noticeHeaders, body } = await buildMockPayment({
    secret: env.MOCK_PAYMENT_SECRET || MOCK_DEFAULT_SECRET, ref: p.ref, code: p.code, amount: p.amount, outcome,
  });
  // A Worker cannot fetch its own hostname over the network; the self-service binding reaches it directly.
  const self = env.WORKER_SELF_REFERENCE;
  const init = { method: "POST", headers: noticeHeaders, body };
  const res = await (self ? self.fetch(p.notifyUrl, init) : fetch(p.notifyUrl, init));
  if (!res.ok) throw new Error(`Mock notify failed: HTTP ${res.status}`);
  redirect(p.returnUrl);
}

export default async function MockPayPage({
  params, searchParams,
}: { params: Promise<{ ref: string }>; searchParams: Promise<Search> }) {
  const env = await appEnv();
  if (!isMockPaymentMode(env)) notFound();
  const { ref } = await params;
  const q = await searchParams;
  let decoded: string;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    notFound();
  }
  const p = await checked(env, { ...q, ref: decoded });
  if (!p) notFound();
  const locale = pageLocale(q.locale);
  const t = createTranslator({ locale, messages: MESSAGES[locale], namespace: "testMode" });
  return (
    <main className="mock-pay" lang={locale}>
      <CjkFonts locale={locale} />
      <p className="mock-pay-brand">NK Hostel 小公館人文旅舍</p>
      <h1>{t("payTitle")}</h1>
      <p className="mock-pay-lead">{t("payLead")}</p>
      <dl className="mock-pay-facts">
        <div>
          <dt>{t("payCode")}</dt>
          <dd>{p.code}</dd>
        </div>
        <div>
          <dt>{t("payAmount")}</dt>
          <dd>{formatPrice(p.amount)}</dd>
        </div>
      </dl>
      <p className="mock-pay-hint">{t("payHint")}</p>
      <form action={pay} className="mock-pay-actions">
        <input type="hidden" name="ref" value={p.ref} />
        <input type="hidden" name="code" value={p.code} />
        <input type="hidden" name="amount" value={String(p.amount)} />
        <input type="hidden" name="returnUrl" value={p.returnUrl} />
        <input type="hidden" name="notifyUrl" value={p.notifyUrl} />
        <button className="cta" name="outcome" value="succeeded">
          {t("paySucceed")}
        </button>
        <button className="ghost-button" name="outcome" value="failed">
          {t("payFail")}
        </button>
      </form>
    </main>
  );
}
