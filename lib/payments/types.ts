import type { Locale } from "@/lib/db/schema";

export type ChargeRequest = {
  reservationCode: string;
  amount: number;
  locale: Locale;
  returnUrl: string;
  notifyUrl: string;
  description: string;
};

export type ChargeStart =
  | { kind: "redirect"; url: string }
  | { kind: "form_post"; action: string; fields: Record<string, string> };

export type PaymentNotice = {
  reservationCode: string;
  providerRef: string;
  amount: number;
  status: "succeeded" | "failed";
  authCode?: string;
  last4?: string;
};

export type VerifyResult =
  | { ok: true; notice: PaymentNotice }
  | { ok: false; error: "BAD_SIGNATURE" | "MALFORMED" };

export interface PaymentGateway {
  readonly provider: "sinopac" | "mock";
  readonly supportsPreauth: boolean;
  startCharge(r: ChargeRequest): Promise<ChargeStart>;
  verifyNotice(req: { headers: Record<string, string>; body: string }): Promise<VerifyResult>;
  refund(r: { providerRef: string; amount: number; reason: string }): Promise<
    { ok: true; refundRef: string } | { ok: false; error: string }
  >;
}
