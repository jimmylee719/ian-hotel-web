import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createTranslator } from "next-intl";
import { formatPrice } from "@/components/booking/format";
import { CjkFonts } from "@/components/layout/CjkFonts";
import { routing } from "@/i18n/routing";
import { checkRate, RATE } from "@/lib/api/rate-limit";
import { getDb } from "@/lib/db/client";
import type { Locale } from "@/lib/db/schema";
import { buildMockPayment, checkMockPayRequest, isMockPaymentMode, MOCK_DEFAULT_SECRET, mockPayOrigins } from "@/lib/payments/mock-page";
import { bookingDisabledReason } from "@/lib/runtime/deps";
import type { AppEnv } from "@/lib/runtime/env";
import { requestEnv } from "@/lib/runtime/request-env";
import en from "@/messages/en.json";
import ja from "@/messages/ja.json";
import ko from "@/messages/ko.json";
import zhTW from "@/messages/zh-TW.json";

export const dynamic = "force-dynamic";

/**
 * The mock gateway's payment page (MockSinoPacGateway.startCharge redirects here), on a test site only (local dev and
 * the public preview) whose booking is on; 404 everywhere else, including a preview without MOCK_PAYMENT_SECRET.
 * Clearly labelled 模擬付款（測試用）: it shows the booking code and amount and two buttons that post a signed
 * success / failure notice to this site's own /api/payments/notify, exactly as the real gateway would, then send the
 * guest back to the return page. It never asks for card or bank details: the only inputs are hidden fields.
 * The page and its action both run checkMockPayRequest (signed link, this site's URLs, the booking's current pending
 * attempt and amount), so the public page is no signing oracle; the action is also rate limited per IP.
 */
type Search = { code?: string; order?: string; amount?: string; locale?: string; returnUrl?: string; notifyUrl?: string; sig?: string };

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

/** The page exists only on a test site whose booking may run (so never with the public default secret on the preview). */
function pageAvailable(env: AppEnv): boolean {
  return isMockPaymentMode(env) && bookingDisabledReason(env) === null;
}

const secretOf = (env: AppEnv) => env.MOCK_PAYMENT_SECRET || MOCK_DEFAULT_SECRET;

async function pay(formData: FormData) {
  "use server";
  const env = await requestEnv();
  if (!pageAvailable(env)) notFound();
  const db = await getDb();
  const ip = (await headers()).get("cf-connecting-ip")?.trim() || "unknown";
  if (!(await checkRate(db, `mockpay:${ip}`, RATE.mockPay, 60, new Date()))) notFound();
  const field = (name: string) => {
    const v = formData.get(name);
    return typeof v === "string" ? v : undefined;
  };
  const p = await checkMockPayRequest(db, { secret: secretOf(env), origins: mockPayOrigins(env.BASE_URL, await requestOrigin()) }, {
    ref: field("ref"), code: field("code"), order: field("order"), amount: field("amount"),
    notifyUrl: field("notifyUrl"), returnUrl: field("returnUrl"), sig: field("sig"),
  });
  if (!p) notFound();
  const outcome = formData.get("outcome") === "succeeded" ? "succeeded" : "failed";
  const { headers: noticeHeaders, body } = await buildMockPayment({
    secret: secretOf(env), ref: p.ref, code: p.code, merchantOrderNo: p.merchantOrderNo, amount: p.amount, outcome,
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
  const env = await requestEnv();
  if (!pageAvailable(env)) notFound();
  const { ref } = await params;
  const q = await searchParams;
  let decoded: string;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    notFound();
  }
  const p = await checkMockPayRequest(await getDb(), { secret: secretOf(env), origins: mockPayOrigins(env.BASE_URL, await requestOrigin()) }, {
    ...q, ref: decoded,
  });
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
        <input type="hidden" name="order" value={p.merchantOrderNo} />
        <input type="hidden" name="amount" value={String(p.amount)} />
        <input type="hidden" name="returnUrl" value={p.returnUrl} />
        <input type="hidden" name="notifyUrl" value={p.notifyUrl} />
        <input type="hidden" name="sig" value={q.sig} />
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
