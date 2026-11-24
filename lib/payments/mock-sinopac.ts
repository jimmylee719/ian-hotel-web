import type {
  ChargeRequest, ChargeStart, PaymentGateway, PaymentNotice, VerifyResult,
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

function isNotice(v: unknown): v is PaymentNotice {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.reservationCode === "string" &&
    typeof n.providerRef === "string" &&
    typeof n.amount === "number" && Number.isInteger(n.amount) &&
    (n.status === "succeeded" || n.status === "failed") &&
    (n.authCode === undefined || typeof n.authCode === "string") &&
    (n.last4 === undefined || typeof n.last4 === "string")
  );
}

export class MockSinoPacGateway implements PaymentGateway {
  readonly provider = "mock" as const;
  readonly supportsPreauth = false;
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly failRefund: boolean;

  constructor(o: { secret: string; baseUrl: string; failRefund?: boolean }) {
    this.secret = o.secret;
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.failRefund = o.failRefund ?? false;
  }

  async startCharge(r: ChargeRequest): Promise<ChargeStart> {
    const ref = `MOCK-${r.reservationCode}-${randomHex(4)}`;
    const q = new URLSearchParams({
      code: r.reservationCode,
      amount: String(r.amount),
      locale: r.locale,
      returnUrl: r.returnUrl,
      notifyUrl: r.notifyUrl,
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
    return { ok: true, notice: parsed };
  }

  async refund(r: { providerRef: string; amount: number; reason: string }) {
    if (this.failRefund) return { ok: false as const, error: "MOCK_REFUND_FAILED" };
    return { ok: true as const, refundRef: `MOCK-REFUND-${r.providerRef}-${randomHex(4)}` };
  }
}
