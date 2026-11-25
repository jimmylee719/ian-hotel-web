import type { Locale } from "@/lib/db/schema";

export type ChargeRequest = {
  reservationCode: string;
  /**
   * The provider's order number for THIS payment attempt: `<code>-<chargeAttempt>` (createReservation),
   * so a retried payment never reuses an earlier attempt's order number.
   */
  merchantOrderNo: string;
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
  /** The attempt's order number (`<code>-<n>`, ChargeRequest.merchantOrderNo), when the provider reports it. */
  merchantOrderNo?: string;
};

export type VerifyResult =
  | { ok: true; notice: PaymentNotice }
  | { ok: false; error: "BAD_SIGNATURE" | "MALFORMED" };

export type TransactionQueryResult =
  | { status: "succeeded" | "failed" | "pending" | "not_found"; amount?: number; providerRef?: string }
  | { error: string };

export type RefundQueryResult =
  | { status: "succeeded" | "failed" | "pending" | "not_found"; refundRef?: string }
  | { error: string };

export type RefundResult =
  | { ok: true; refundRef: string }
  | {
      ok: false;
      error: string;
      /**
       * True when the call may have reached the provider but its answer was lost (timeout, network error, e.g.
       * error "TIMEOUT"): the refund may have happened, so the caller asks queryRefund instead of assuming.
       * Absent/false: a definite rejection, nothing was refunded.
       */
      outcomeUnknown?: boolean;
    };

export interface PaymentGateway {
  readonly provider: "sinopac" | "mock";
  readonly supportsPreauth: boolean;
  /** How long one call to the provider may take before it is abandoned (at most 30000). */
  readonly timeoutMs: number;
  startCharge(r: ChargeRequest): Promise<ChargeStart>;
  verifyNotice(req: { headers: Record<string, string>; body: string }): Promise<VerifyResult>;
  /**
   * Refund part or all of a charge. `idempotencyKey` (our refund row id): a repeat call with the same
   * key must not refund again and returns the first call's result.
   */
  refund(r: { providerRef: string; amount: number; reason: string; idempotencyKey?: string }): Promise<RefundResult>;
  /** The provider's view of a charge, by its providerRef or by the attempt's merchantOrderNo. */
  queryTransaction(ref: { providerRef?: string; merchantOrderNo?: string }): Promise<TransactionQueryResult>;
  /** The provider's view of the refund made under `idempotencyKey` (not_found: it never made one). */
  queryRefund(idempotencyKey: string): Promise<RefundQueryResult>;
}
