import { XMLParser, XMLValidator } from "fast-xml-parser";

/**
 * SOAP 1.1 plumbing for the inbound SiteConnect endpoint (docs/integrations/siteminder.md §2): parse a request
 * envelope safely, read the WS-Security UsernameToken, and write minified response envelopes.
 */

export const SOAP_ENV_NS = "http://schemas.xmlsoap.org/soap/envelope/";
export const OTA_NS = "http://www.opentravel.org/OTA/2003/05";
export const PASSWORD_TEXT = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText";
export const XML_CONTENT_TYPE = "text/xml; charset=utf-8";

/** A parsed element: attributes under "@name", text under "#text", children by local name (one, or an array). */
export type XmlNode = { [key: string]: unknown };

/**
 * Safe parser settings: no entity expansion (processEntities false, no HTML entities), declarations and processing
 * instructions dropped, values kept as strings. A DOCTYPE is refused before parsing (parseEnvelope), so no DTD is
 * ever read. Namespace prefixes are removed: elements are matched by local name (SOAP-ENV:Body → Body).
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  processEntities: false,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

/** The five predefined XML entities and numeric character references (the only ones we decode, by hand). */
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const cp = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const isNode = (v: unknown): v is XmlNode => typeof v === "object" && v !== null && !Array.isArray(v);

/** The first child element `name` of `node` (a repeated element gives its first occurrence). */
export function child(node: unknown, name: string): XmlNode | string | undefined {
  if (!isNode(node)) return undefined;
  const v = Array.isArray(node[name]) ? (node[name] as unknown[])[0] : node[name];
  return isNode(v) || typeof v === "string" ? v : undefined;
}

/** Follow a path of child element names. */
export function path(node: unknown, ...names: string[]): XmlNode | string | undefined {
  let cur: unknown = node;
  for (const n of names) cur = child(cur, n);
  return cur as XmlNode | string | undefined;
}

/** An attribute's value, entity-decoded; undefined when absent. */
export function attr(node: unknown, name: string): string | undefined {
  if (!isNode(node)) return undefined;
  const v = node[`@${name}`];
  return typeof v === "string" ? decodeXml(v) : undefined;
}

/** An element's text, entity-decoded ("" for an empty element). */
export function text(node: unknown): string | undefined {
  if (typeof node === "string") return decodeXml(node);
  if (!isNode(node)) return undefined;
  const v = node["#text"];
  return typeof v === "string" ? decodeXml(v) : "";
}

export type Envelope = {
  header: XmlNode | undefined;
  /** The Body's single child element: its local name (e.g. "OTA_HotelAvailRQ") and content. */
  rootName: string;
  root: XmlNode;
};

/** A request that is not a well-formed SOAP envelope with exactly one Body element (or that carries a DTD). */
export class MalformedRequestError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "MalformedRequestError";
  }
}

export function parseEnvelope(xml: string): Envelope {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new MalformedRequestError("DTD_NOT_ALLOWED");
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new MalformedRequestError("NOT_WELL_FORMED");
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new MalformedRequestError("NOT_WELL_FORMED");
  }
  const envelope = child(doc, "Envelope");
  if (!isNode(envelope)) throw new MalformedRequestError("NO_ENVELOPE");
  const body = child(envelope, "Body");
  if (!isNode(body)) throw new MalformedRequestError("NO_BODY");
  const elements = Object.keys(body).filter((k) => !k.startsWith("@") && k !== "#text");
  if (elements.length !== 1 || Array.isArray(body[elements[0]])) throw new MalformedRequestError("BODY_NOT_ONE_ELEMENT");
  const root = body[elements[0]];
  const header = child(envelope, "Header");
  return { header: isNode(header) ? header : undefined, rootName: elements[0], root: isNode(root) ? root : {} };
}

/** The WS-Security UsernameToken (Header/Security/UsernameToken), or null when absent or not PasswordText. */
export function usernameToken(header: XmlNode | undefined): { username: string; password: string } | null {
  const token = path(header, "Security", "UsernameToken");
  const username = text(child(token, "Username"));
  const pw = child(token, "Password");
  const password = text(pw);
  if (username === undefined || password === undefined) return null;
  // The docs accept only the PasswordText profile [REQ]; a missing Type is read as PasswordText (the OASIS default).
  const type = attr(pw, "Type");
  if (type !== undefined && type !== PASSWORD_TEXT) return null;
  return { username, password };
}

/** A minified SOAP 1.1 response envelope with the empty Header the docs require. */
export function soapEnvelope(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="${SOAP_ENV_NS}"><SOAP-ENV:Header/><SOAP-ENV:Body>${bodyXml}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

/** An OTA response root: `<Name xmlns=OTA EchoToken=… TimeStamp=… Version="1.0">content</Name>`. */
export function otaResponse(name: string, echo: { echoToken?: string; timeStamp: string }, content: string): string {
  const echoToken = echo.echoToken !== undefined ? ` EchoToken="${escapeXml(echo.echoToken)}"` : "";
  return `<${name} xmlns="${OTA_NS}"${echoToken} TimeStamp="${escapeXml(echo.timeStamp)}" Version="1.0">${content}</${name}>`;
}

/** ISO 8601 UTC with `Z`, whole seconds (the docs recommend UTC + Z [REQ]). */
export const isoTimestamp = (now: Date): string => now.toISOString().replace(/\.\d{3}Z$/, "Z");
