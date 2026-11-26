import { escapeXml, otaResponse, rsEcho, soapEnvelope, XML_CONTENT_TYPE, type XmlNode } from "./soap";

/**
 * What the inbound endpoint answers when something is wrong (docs/integrations/siteminder.md §4.3, §5.3).
 * The OTA errors below are the docs' required ones: Type, Code and text exactly as written there ([ERR-G]),
 * because SiteMinder's auto-disable matches on them. Do not reword them.
 */
export const OTA_ERRORS = {
  /** Wrong or missing WS-Security credentials. AvailRS, AvailNotifRS, RateAmountNotifRS. */
  AUTH: { type: 4, code: 448, text: "Invalid Username and/or Password" },
  /** HotelCode we do not have: SiteMinder disables the whole hotel's connection. */
  HOTEL_NOT_FOUND: (hotelCode: string) => ({ type: 6, code: 392, text: `Hotel not found for HotelCode=${hotelCode}` }),
  /** ARI (inbound/ari.ts): unknown InvTypeCode / RatePlanCode. AvailNotifRS, RateAmountNotifRS. */
  ROOM_NOT_FOUND: { type: 12, code: 402, text: "Room type code not found for this hotel" },
  RATE_NOT_FOUND: { type: 12, code: 249, text: "Rate code not found for this hotel" },
  /** PDP: an included occupancy (BaseByGuestAmt@NumberOfGuests) other than the room type's. RateAmountNotifRS. */
  INVALID_INCLUDED_OCCUPANCY: (expecting: number) => ({ type: 12, code: 137, text: `Invalid included occupancy: expecting ${expecting}` }),
  /**
   * SITEMINDER-OPEN-Q7: a required element or attribute is missing from an otherwise valid request. The docs list
   * EWT 10 "Required field missing" and ERR 321 "Required field missing" [EWT][EC] but give no rule for using them
   * in our responses.
   */
  REQUIRED_FIELD_MISSING: (what: string) => ({ type: 10, code: 321, text: `Required field missing: ${what}` }),
} as const;

export type OtaError = { type: number; code?: number; text: string };

export const errorsXml = (errors: OtaError[]): string =>
  `<Errors>${errors.map((e) => `<Error Type="${e.type}"${e.code !== undefined ? ` Code="${e.code}"` : ""}>${escapeXml(e.text)}</Error>`).join("")}</Errors>`;

const HEADERS = { "content-type": XML_CONTENT_TYPE, "cache-control": "no-store" };

/** A SOAP response with HTTP 200: application-level errors must not become HTTP errors [ERR-G][FAQ]. */
export const soapResponse = (bodyXml: string, status = 200): Response =>
  new Response(soapEnvelope(bodyXml), { status, headers: HEADERS });

/**
 * The RS element answering an RQ root: OTA_HotelAvailRQ → OTA_HotelAvailRS. null for a root that is not an OTA
 * request (does not end in "RQ").
 */
export const responseNameFor = (rootName: string): string | null =>
  /^OTA_[A-Za-z]{1,60}RQ$/.test(rootName) ? `${rootName.slice(0, -2)}RS` : null;

/**
 * Wrong or missing credentials (and every request while our inbound secrets are unset).
 * SITEMINDER-OPEN-Q2: [RR] says invalid credentials "return a SOAP fault"; [ERR-G] lists Type 4 / Code 448 as a
 * required error of OTA_HotelAvailRS, AvailNotifRS and RateAmountNotifRS. We answer the matching RS (EchoToken and
 * TimeStamp per soap.ts RS_TIMESTAMP) with that error inside the SOAP envelope, HTTP 200 (the RS form is the one the docs give exact values for). A root that is not
 * an OTA request gets a SOAP Fault carrying the same text.
 */
export function authFailure(rootName: string, request: XmlNode, now: Date): Response {
  const rs = responseNameFor(rootName);
  if (!rs) return soapFault(400, OTA_ERRORS.AUTH.text);
  return soapResponse(otaResponse(rs, rsEcho(rs, request, now), errorsXml([OTA_ERRORS.AUTH])));
}

/**
 * Protocol-level problems the docs give no OTA error for: an unparseable body, a non-SOAP or multi-element body, an
 * OTA message we do not implement, an oversized body, or our own failure. Answered as a SOAP 1.1 Fault.
 * SITEMINDER-OPEN-Q7: the docs do not say what to return for XML we cannot parse or a message we do not handle, nor
 * with which HTTP status. We use 400 (Client fault: a 4xx is "fix before resending" [HTTP]) for the request's
 * faults, 413 for size, 503 for rate limiting and 500 (Server fault: SiteMinder retries 5xx every 2 minutes
 * [ERR-G][FAQ]) for ours.
 */
export function soapFault(status: number, faultstring: string, headers: Record<string, string> = {}): Response {
  const faultcode = status >= 500 ? "SOAP-ENV:Server" : "SOAP-ENV:Client";
  return new Response(
    soapEnvelope(`<SOAP-ENV:Fault><faultcode>${faultcode}</faultcode><faultstring>${escapeXml(faultstring)}</faultstring></SOAP-ENV:Fault>`),
    { status, headers: { ...HEADERS, ...headers } },
  );
}
