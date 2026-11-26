import { child, escapeXml, OTA_NS, PASSWORD_TEXT, parseEnvelope, SOAP_ENV_NS, type XmlNode } from "./inbound/soap";

/**
 * XML plumbing for our outbound calls to SiteMinder (docs/integrations/siteminder.md §2): build a minified SOAP 1.1
 * request with the WS-Security UsernameToken, and read the response envelope. Parsing reuses the inbound endpoint's
 * safe parser (no DTD, no entity expansion, namespace prefixes dropped).
 */

export const WSSE_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";

export type Attrs = Record<string, string | number | undefined>;

/**
 * Characters XML 1.0 does not allow (its Char production): C0 controls other than tab, LF and CR, U+FFFE / U+FFFF,
 * and lone surrogates. One bad character in a guest's name would make SiteMinder refuse the whole message.
 */
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `s` without the characters XML cannot carry. Every text and attribute value we send goes through it. */
export const xmlSafe = (s: string): string => s.replace(XML_INVALID, "");

/** At most `max` characters (code points: a surrogate pair is never split). */
export const clipChars = (s: string, max: number): string => Array.from(s).slice(0, max).join("");

/** One element, minified: attributes in the given order (undefined ones left out), children concatenated. */
export function el(name: string, attrs: Attrs = {}, ...children: string[]): string {
  const a = Object.entries(attrs)
    .filter((e): e is [string, string | number] => e[1] !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(xmlSafe(String(v)))}"`)
    .join("");
  const body = children.join("");
  return body ? `<${name}${a}>${body}</${name}>` : `<${name}${a}/>`;
}

/** Text content, escaped. */
export const txt = (s: string): string => escapeXml(xmlSafe(s));

/**
 * The request envelope: WS-Security UsernameToken with a PasswordText password ([QS][REQ]: the password travels in
 * clear inside HTTPS), the OTA message in the Body. Minified to one line, as production requires [REQ].
 */
export function requestEnvelope(creds: { username: string; password: string }, bodyXml: string): string {
  const security = `<wsse:Security SOAP-ENV:mustUnderstand="1" xmlns:wsse="${WSSE_NS}"><wsse:UsernameToken>`
    + `<wsse:Username>${txt(creds.username)}</wsse:Username>`
    + `<wsse:Password Type="${PASSWORD_TEXT}">${txt(creds.password)}</wsse:Password>`
    + `</wsse:UsernameToken></wsse:Security>`;
  return `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="${SOAP_ENV_NS}">`
    + `<SOAP-ENV:Header>${security}</SOAP-ENV:Header><SOAP-ENV:Body>${bodyXml}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

/** An OTA request root: `<Name xmlns=OTA EchoToken TimeStamp Version="1.0" …>`. */
export const otaRequest = (name: string, attrs: Attrs, ...children: string[]): string =>
  el(name, { xmlns: OTA_NS, ...attrs }, ...children);

/** Every child element `name` of `node` (a single one, or each of a repeated one). */
export function children(node: unknown, name: string): XmlNode[] {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return [];
  const v = (node as XmlNode)[name];
  const all = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return all.map((x) => (typeof x === "object" && x !== null && !Array.isArray(x) ? (x as XmlNode) : typeof x === "string" ? { "#text": x } : {}));
}

/** The response's Body element (name and content), or null when the text is not a SOAP envelope we can read. */
export function readResponse(xml: string): { rootName: string; root: XmlNode } | null {
  try {
    const { rootName, root } = parseEnvelope(xml);
    return { rootName, root };
  } catch {
    return null;
  }
}

export { child };
