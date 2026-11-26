import type {
  ChargeRequest, ChargeStart, PaymentGateway, PaymentNotice, RefundQueryResult, RefundResult, TransactionQueryResult, VerifyResult,
} from "./types";

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer as ArrayBuffer);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
}

/** What a mock pay link (startCharge → /dev/pay) is signed over. */
export type PayLinkFields = { ref: string; code: string; merchantOrderNo: string; amount: number; returnUrl: string; notifyUrl: string };

/**
 * HMAC-SHA256 (hex) of a pay link's fields with the gateway secret. Domain-separated ("mock-pay-link", a JSON array)
 * from the notices' signature (a JSON object), so neither can stand in for the other.
 */
export async function payLinkSignature(secret: string, f: PayLinkFields): Promise<string> {
  return hmacHex(secret, JSON.stringify(["mock-pay-link", f.ref, f.code, f.merchantOrderNo, f.amount, f.returnUrl, f.notifyUrl]));
}

/** Constant-time check of a pay link's `sig`. */
export async function payLinkValid(secret: string, f: PayLinkFields, sig: string): Promise<boolean> {
  return timingSafeEqual(sig, await payLinkSignature(secret, f));
}

function isNotice(v: unknown): v is PaymentNotice {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.reservationCode === "string" &&
    typeof n.providerRef === "string" &&
    typeof n.amount === "number" && Number.isInteger(n.amount) &&
    (n.status === "succeeded" || n.status === "failed") &&
    (n.authCode === undefined || typeof n.authCode === "string") &&
    (n.last4 === undefined || typeof n.last4 === "string") &&
    (n.merchantOrderNo === undefined || typeof n.merchantOrderNo === "string")
  );
}

export class MockSinoPacGateway implements PaymentGateway {
  readonly provider = "mock" as const;
  readonly supportsPreauth = false;
  readonly timeoutMs = 10_000;
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly failRefund: boolean;
  /** How many of the next refunds are made but answered with a TIMEOUT (the answer lost on the way back). */
  refundTimeoutNext: number;

  constructor(o: { secret: string; baseUrl: string; failRefund?: boolean; refundTimeoutNext?: number }) {
    this.secret = o.secret;
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.failRefund = o.failRefund ?? false;
    this.refundTimeoutNext = o.refundTimeoutNext ?? 0;
  }

  /** Charges this instance started or saw a verified notice for, by providerRef. */
  private readonly charges = new Map<string, { merchantOrderNo?: string; amount: number; status: "succeeded" | "failed" | "pending" }>();

  async startCharge(r: ChargeRequest): Promise<ChargeStart> {
    const ref = `MOCK-${r.reservationCode}-${randomHex(4)}`;
    this.charges.set(ref, { merchantOrderNo: r.merchantOrderNo, amount: r.amount, status: "pending" });
    // Signed, so the public pay page only acts on links this gateway made (see app/dev/pay and lib/payments/mock-page.ts).
    const sig = await payLinkSignature(this.secret, {
      ref, code: r.reservationCode, merchantOrderNo: r.merchantOrderNo, amount: r.amount, returnUrl: r.returnUrl, notifyUrl: r.notifyUrl,
    });
    const q = new URLSearchParams({
      code: r.reservationCode,
      order: r.merchantOrderNo,
      amount: String(r.amount),
      locale: r.locale,
      returnUrl: r.returnUrl,
      notifyUrl: r.notifyUrl,
      sig,
    });
    return { kind: "redirect", url: `${this.baseUrl}/dev/pay/${encodeURIComponent(ref)}?${q.toString()}` };
  }

  async signedNotice(notice: PaymentNotice): Promise<{ headers: Record<string, string>; body: string }> {
    const body = JSON.stringify(notice);
    return {
      headers: { "content-type": "application/json", [MOCK_SIGNATURE_HEADER]: await hmacHex(this.secret, body) },
      body,
    };
  }

  async verifyNotice(req: { headers: Record<string, string>; body: string }): Promise<VerifyResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      return { ok: false, error: "MALFORMED" };
    }
    if (!isNotice(parsed)) return { ok: false, error: "MALFORMED" };
    const given = Object.entries(req.headers).find(([k]) => k.toLowerCase() === MOCK_SIGNATURE_HEADER)?.[1] ?? "";
    if (!timingSafeEqual(given, await hmacHex(this.secret, req.body))) {
      return { ok: false, error: "BAD_SIGNATURE" };
    }
    // The provider's notice carries its own transaction ref and, when it reports one, the attempt's order number.
    const known = this.charges.get(parsed.providerRef);
    const merchantOrderNo = parsed.merchantOrderNo ?? known?.merchantOrderNo;
    this.charges.set(parsed.providerRef, { merchantOrderNo, amount: parsed.amount, status: parsed.status });
    return { ok: true, notice: parsed };
  }

  /**
   * By providerRef, or by merchantOrderNo: an attempt is first known under the ref startCharge made up and then, once
   * paid, under the notice's ref; the settled outcome (succeeded, then failed) wins over the still-pending start.
   */
  async queryTransaction(ref: { providerRef?: string; merchantOrderNo?: string }): Promise<TransactionQueryResult> {
    const rank = { succeeded: 0, failed: 1, pending: 2 } as const;
    const hit = [...this.charges].filter(([providerRef, c]) =>
      (ref.providerRef !== undefined && providerRef === ref.providerRef) ||
      (ref.merchantOrderNo !== undefined && c.merchantOrderNo === ref.merchantOrderNo))
      .sort(([, a], [, b]) => rank[a.status] - rank[b.status])[0];
    if (!hit) return { status: "not_found" };
    const [providerRef, c] = hit;
    return { status: c.status, amount: c.amount, providerRef };
  }

  /** Refunds actually made (a repeat of an idempotency key is not one). */
  readonly refunds: { providerRef: string; amount: number; refundRef: string }[] = [];
  private readonly byKey = new Map<string, string>();

  async refund(r: { providerRef: string; amount: number; reason: string; idempotencyKey?: string }): Promise<RefundResult> {
    if (this.failRefund) return { ok: false, error: "MOCK_REFUND_FAILED" };
    const seen = r.idempotencyKey === undefined ? undefined : this.byKey.get(r.idempotencyKey);
    let refundRef = seen;
    if (!refundRef) {
      refundRef = `MOCK-REFUND-${r.providerRef}-${randomHex(4)}`;
      this.refunds.push({ providerRef: r.providerRef, amount: r.amount, refundRef });
      if (r.idempotencyKey !== undefined) this.byKey.set(r.idempotencyKey, refundRef);
    }
    if (this.refundTimeoutNext > 0) {
      this.refundTimeoutNext--;
      return { ok: false, error: "TIMEOUT", outcomeUnknown: true }; // made, but the answer never arrives
    }
    return { ok: true, refundRef };
  }

  async queryRefund(idempotencyKey: string): Promise<RefundQueryResult> {
    const refundRef = this.byKey.get(idempotencyKey);
    return refundRef ? { status: "succeeded", refundRef } : { status: "not_found" };
  }
}
