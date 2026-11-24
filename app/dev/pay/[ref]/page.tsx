import { notFound, redirect } from "next/navigation";
import { buildMockPayment, isMockPaymentMode, MOCK_DEFAULT_SECRET } from "@/lib/payments/mock-page";
import { appEnv } from "@/lib/runtime/env";

export const dynamic = "force-dynamic";

// Dev-only mock payment page. 404s unless PAYMENT_MODE === "mock".
type Search = { code?: string; amount?: string; locale?: string; returnUrl?: string; notifyUrl?: string };

async function pay(formData: FormData) {
  "use server";
  const env = await appEnv();
  if (!isMockPaymentMode(env)) notFound();
  const outcome = formData.get("outcome") === "succeeded" ? "succeeded" : "failed";
  const notifyUrl = String(formData.get("notifyUrl"));
  const returnUrl = String(formData.get("returnUrl"));
  const { headers, body } = await buildMockPayment({
    secret: env.MOCK_PAYMENT_SECRET || MOCK_DEFAULT_SECRET,
    ref: String(formData.get("ref")),
    code: String(formData.get("code")),
    amount: Number(formData.get("amount")),
    outcome,
  });
  // A Worker cannot fetch its own hostname over the network; the self-service binding reaches it directly.
  const self = env.WORKER_SELF_REFERENCE;
  const res = await (self ? self.fetch(notifyUrl, { method: "POST", headers, body }) : fetch(notifyUrl, { method: "POST", headers, body }));
  if (!res.ok) throw new Error(`Mock notify to ${notifyUrl} failed: HTTP ${res.status}`);
  redirect(returnUrl);
}

export default async function MockPayPage({
  params, searchParams,
}: { params: Promise<{ ref: string }>; searchParams: Promise<Search> }) {
  if (!isMockPaymentMode(await appEnv())) notFound();
  const { ref } = await params;
  const q = await searchParams;
  if (!q.code || !q.amount || !q.returnUrl || !q.notifyUrl) notFound();
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 480, margin: "64px auto", padding: "0 20px" }}>
      <p style={{ color: "#8f2d1f" }}>Mock payment page (PAYMENT_MODE=mock). No money moves.</p>
      <h1>Mock payment {q.code}</h1>
      <p>NT${Number(q.amount).toLocaleString("en-US")}</p>
      <form action={pay} style={{ display: "flex", gap: 12 }}>
        <input type="hidden" name="ref" value={ref} />
        <input type="hidden" name="code" value={q.code} />
        <input type="hidden" name="amount" value={q.amount} />
        <input type="hidden" name="returnUrl" value={q.returnUrl} />
        <input type="hidden" name="notifyUrl" value={q.notifyUrl} />
        <button name="outcome" value="succeeded">付款成功 / Pay (success)</button>
        <button name="outcome" value="failed">付款失敗 / Fail</button>
      </form>
    </main>
  );
}
