import type { ChannelErrorDetail, ChannelFailure } from "../types";
import { attr, path, text, type XmlNode } from "./inbound/soap";
import { child, children, readResponse } from "./xml";

/**
 * How SiteMinder's answer to an OTA_HotelResNotifRQ is classified (docs/integrations/siteminder.md §5.1, [ERR-G]
 * [HTTP]). Never throws: every answer, or its absence, becomes a success or a structured ChannelFailure.
 *
 * | answer                                   | class                                               |
 * |------------------------------------------|-----------------------------------------------------|
 * | OTA_HotelResNotifRS with <Success/>      | ok (smConfirmation from HotelReservationID@ResID_Value) |
 * | OTA_HotelResNotifRS with <Errors>        | not retryable (fix the data first, [ERR-G])         |
 * | SOAP Fault (any HTTP status)             | not retryable (SITEMINDER-OPEN-Q2)                  |
 * | HTTP 4xx                                 | not retryable ([ERR-G][HTTP]; 409 = duplicate, Q1)  |
 * | HTTP 500, 502, 503, 504 (other 5xx too)  | retryable                                           |
 * | HTTP 501, 505                            | not retryable ([HTTP])                              |
 * | timeout, network error                   | retryable (inferred; resend converges, Q1)          |
 * | 2xx we cannot read                       | retryable (outcome unknown; the resend converges)   |
 */

/** [HTTP]: 501 Not Implemented and 505 HTTP Version Not Supported are not retried; other 5xx are. */
export const NON_RETRYABLE_5XX: readonly number[] = [501, 505];

/**
 * SITEMINDER-OPEN-Q2: OTA Error codes in an OTA_HotelResNotifRS that may be retried. [ERR-G] says an RS error is
 * never retried until the data is fixed; whether 187 "System currently unavailable" or 450 "Unable to process" are
 * exceptions is asked in Q2. Empty until SiteMinder answers.
 */
export const RETRYABLE_OTA_CODES: readonly number[] = [];

/**
 * SITEMINDER-OPEN-Q2: a SOAP Fault ([RES]: wrong credentials "return a SOAP fault") is taken as not retryable,
 * whatever its HTTP status (SOAP 1.1 sends faults with 500). Change here if SiteMinder says otherwise.
 */
export const SOAP_FAULT_RETRYABLE = false;

/** Longest channel text kept in an error (it ends up in lastSyncError for staff). */
const MAX_TEXT = 200;
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

export type OtaIssue = { type?: number; code?: number; text: string };

export type ClassifiedAnswer =
  | { ok: true; resId?: string; echoToken?: string; warnings: OtaIssue[] }
  | ChannelFailure;

const num = (v: string | undefined): number | undefined => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined);

function issues(node: unknown, list: string, item: string): OtaIssue[] {
  return children(child(node, list), item).map((e: XmlNode) => ({
    type: num(attr(e, "Type")), code: num(attr(e, "Code")), text: (text(e) ?? "").trim(),
  }));
}

/** HotelReservations/HotelReservation/ResGlobalInfo/HotelReservationIDs/HotelReservationID[@ResID_Type=14]@ResID_Value. */
function resIdOf(rs: XmlNode): string | undefined {
  const ids = path(rs, "HotelReservations", "HotelReservation", "ResGlobalInfo", "HotelReservationIDs");
  const id = children(ids, "HotelReservationID").find((x) => attr(x, "ResID_Type") === "14") ?? children(ids, "HotelReservationID")[0];
  const v = attr(id, "ResID_Value")?.trim();
  return v || undefined;
}

const failure = (retryable: boolean, error: string, detail: ChannelErrorDetail): ChannelFailure => ({ ok: false, retryable, error, detail });

/** The HTTP-status rule alone (no OTA answer to go by). */
export function httpRetryable(status: number): boolean {
  if (status >= 500) return !NON_RETRYABLE_5XX.includes(status);
  return false;
}

/**
 * Classify one HTTP answer. `echoToken` is the request's (kept in the detail for tracing). The body is read as an
 * OTA_HotelResNotifRS or a SOAP Fault whatever the status; only an answer that is neither falls back to the status.
 */
export function classifyAnswer(httpStatus: number, body: string, echoToken: string): ClassifiedAnswer {
  const parsed = readResponse(body);
  const ok2xx = httpStatus >= 200 && httpStatus < 300;

  if (parsed?.rootName === "Fault") {
    const code = (text(child(parsed.root, "faultcode")) ?? "").trim();
    const msg = (text(child(parsed.root, "faultstring")) ?? "").trim();
    return failure(SOAP_FAULT_RETRYABLE, clip(`SITEMINDER_SOAP_FAULT http=${httpStatus} ${code}: ${msg}`),
      { kind: "soap_fault", httpStatus, echoToken });
  }

  if (parsed?.rootName === "OTA_HotelResNotifRS") {
    const rs = parsed.root;
    const errors = issues(rs, "Errors", "Error");
    if (errors.length) {
      const first = errors[0];
      const retryable = errors.every((e) => e.code !== undefined && RETRYABLE_OTA_CODES.includes(e.code));
      const all = errors.map((e) => `type=${e.type ?? "?"}${e.code !== undefined ? ` code=${e.code}` : ""}: ${e.text}`).join("; ");
      return failure(retryable, clip(`SITEMINDER_ERROR ${all}`),
        { kind: "ota", httpStatus, type: first.type, code: first.code, echoToken });
    }
    if (child(rs, "Success") !== undefined && ok2xx)
      return { ok: true, resId: resIdOf(rs), echoToken: attr(rs, "EchoToken"), warnings: issues(rs, "Warnings", "Warning") };
  }

  if (!ok2xx)
    return failure(httpRetryable(httpStatus), `SITEMINDER_HTTP_${httpStatus}`, { kind: "http", httpStatus, echoToken });
  return failure(true, "SITEMINDER_BAD_RESPONSE", { kind: "bad_response", httpStatus, echoToken });
}

/** No answer within the timeout: retryable (doc §5.1, inferred). */
export const timeoutFailure = (echoToken: string): ChannelFailure =>
  failure(true, "TIMEOUT", { kind: "timeout", echoToken });

/** The request never got an answer (DNS, TLS, connection reset): retryable. */
export const networkFailure = (echoToken: string, e: unknown): ChannelFailure =>
  failure(true, clip(`SITEMINDER_NETWORK: ${e instanceof Error ? e.name : "Error"}`), { kind: "network", echoToken });
