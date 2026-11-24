import { notFound, redirect } from "next/navigation";
import { buildMockPayment, isMockPaymentMode } from "@/lib/payments/mock-page";

// Dev-only mock payment page. 404s unless PAYMENT_MODE === "mock".
type Search = { code?: string; amount?: string; locale?: string; returnUrl?: string; notifyUrl?: string };

async function pay(formData: FormData) {
  "use server";
  if (!isMockPaymentMode()) notFound();
  const outcome = formData.get("outcome") === "succeeded" ? "succeeded" : "failed";
  const notifyUrl = String(formData.get("notifyUrl"));
  const returnUrl = String(formData.get("returnUrl"));
  const { headers, body } = await buildMockPayment({
    secret: process.env.MOCK_PAYMENT_SECRET ?? "mock-secret",
    ref: String(formData.get("ref")),
    code: String(formData.get("code")),
    amount: Number(formData.get("amount")),
    outcome,
  });
  await fetch(notifyUrl, { method: "POST", headers, body });
  redirect(returnUrl);
}

export default async function MockPayPage({
  params, searchParams,
}: { params: Promise<{ ref: string }>; searchParams: Promise<Search> }) {
  if (!isMockPaymentMode()) notFound();
  const { ref } = await params;
  const q = await searchParams;
  if (!q.code || !q.amount || !q.returnUrl || !q.notifyUrl) notFound();
  return (
    <main>
      <h1>Mock payment {q.code}</h1>
      <p>NT${Number(q.amount).toLocaleString("en-US")}</p>
      <form action={pay}>
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
