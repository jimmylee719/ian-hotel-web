import { MockSinoPacGateway } from "./mock-sinopac";

/** Signing secret when MOCK_PAYMENT_SECRET is not set (mock mode only; the gateway and the pay page share it). */
export const MOCK_DEFAULT_SECRET = "mock-secret";

/** The mock pay page exists only when PAYMENT_MODE is "mock". */
export function isMockPaymentMode(env: { PAYMENT_MODE?: string } = process.env as { PAYMENT_MODE?: string }): boolean {
  return env.PAYMENT_MODE === "mock";
}

/** Recover the reservation code from a ref shaped MOCK-<code>-<8 hex>. */
export function reservationCodeFromRef(ref: string): string | null {
  const m = /^MOCK-(.+)-[0-9a-f]{8}$/.exec(ref);
  return m ? m[1] : null;
}

/** Build the signed notice the mock pay page POSTs to notifyUrl. */
export async function buildMockPayment(p: {
  secret: string;
  ref: string;
  code: string;
  amount: number;
  outcome: "succeeded" | "failed";
}) {
  const gw = new MockSinoPacGateway({ secret: p.secret, baseUrl: "http://localhost" });
  return gw.signedNotice({
    reservationCode: p.code,
    providerRef: p.ref,
    amount: p.amount,
    status: p.outcome,
    ...(p.outcome === "succeeded" ? { authCode: "000000", last4: "4242" } : {}),
  });
}
