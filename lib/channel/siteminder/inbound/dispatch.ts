import { checkRate, clientIp, retryAfterSec } from "@/lib/api/rate-limit";
import type { Db } from "@/lib/db/types";
import { log } from "@/lib/runtime/log";
import { authFailure, soapFault, soapResponse } from "./errors";
import { handleRoomsAndRates } from "./rooms-and-rates";
import { attr, isoTimestamp, MalformedRequestError, parseEnvelope, usernameToken, type XmlNode } from "./soap";

/**
 * The one inbound SiteConnect endpoint (POST /api/channel/siteminder; docs/integrations/siteminder.md §2, §8.2):
 * SiteMinder sends every message to the same URI and we dispatch on the SOAP Body's root element.
 * Checks, in order: body size (413), rate limit (503), well-formed SOAP (400 Fault), WS-Security credentials
 * (the docs' Type 4 / Code 448 error), then the handler for the root element. No external calls: the docs want an
 * answer within 1–2 s (20 s hard limit) [REQ].
 */

export type InboundDeps = {
  db: Db;
  /** Our credentials for SiteMinder's calls (secrets). Unset or empty = every request is refused. */
  username?: string;
  password?: string;
};

export type InboundContext = { db: Db; root: XmlNode; now: Date };

/** Answers one OTA request root with its RS element (the SOAP envelope is added by the endpoint). */
export type InboundHandler = (ctx: InboundContext) => Promise<string>;

/** Root element → handler. Task 4 adds OTA_HotelAvailNotifRQ and OTA_HotelRateAmountNotifRQ here. */
export const HANDLERS: Readonly<Record<string, InboundHandler>> = {
  OTA_HotelAvailRQ: handleRoomsAndRates,
};

/**
 * Body size limit. The docs give none; one ARI message is at most 210 days of one room type (doc §4.4), far below
 * this. SiteMinder can raise its batch size, so this stays generous.
 */
export const MAX_BODY_BYTES = 1_000_000;

/** Requests per minute per source IP. SiteMinder sends one message at a time per hotel, each answered in ~1 s. */
export const INBOUND_RATE_PER_MIN = 600;

const enc = new TextEncoder();

/** Constant-time string equality: both sides are hashed first, so neither length nor content leaks through timing. */
export async function sameSecret(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([given, expected].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** The body as UTF-8 text, or null once it exceeds `max` bytes (Content-Length or the bytes actually sent). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}

export async function handleSiteMinderInbound(deps: InboundDeps, req: Request, now: Date): Promise<Response> {
  const xml = await readCapped(req, MAX_BODY_BYTES);
  if (xml === null) return soapFault(413, "Request too large");

  const ip = clientIp(req);
  if (!(await checkRate(deps.db, `siteminder-inbound:${ip}`, INBOUND_RATE_PER_MIN, 60, now))) {
    // Server-level, so SiteMinder retries it (every 2 minutes [FAQ]); a 4xx would read as "fix before resending".
    return soapFault(503, "Too many requests", { "retry-after": String(retryAfterSec(60, now)) });
  }

  let envelope: ReturnType<typeof parseEnvelope>;
  try {
    envelope = parseEnvelope(xml);
  } catch (e) {
    if (!(e instanceof MalformedRequestError)) throw e;
    log.warn(`siteminder inbound: malformed request (${e.message}) from ${ip}`);
    return soapFault(400, "Malformed request");
  }
  const { root, header } = envelope;
  const rootName = envelope.rootName.slice(0, 64); // sender-controlled: kept short in logs and faults

  const token = usernameToken(header);
  const configured = !!deps.username && !!deps.password;
  // Both comparisons always run (no short-circuit), so a wrong username costs the same time as a wrong password.
  const userOk = await sameSecret(token?.username ?? "", deps.username ?? "");
  const passOk = await sameSecret(token?.password ?? "", deps.password ?? "");
  if (!configured || !token || !userOk || !passOk) {
    log.warn(`siteminder inbound: credentials refused for ${rootName} from ${ip}${configured ? "" : " (inbound credentials are not configured)"}`);
    return authFailure(rootName, attr(root, "EchoToken"), isoTimestamp(now));
  }

  const handler = Object.hasOwn(HANDLERS, rootName) ? HANDLERS[rootName] : undefined;
  if (!handler) {
    log.warn(`siteminder inbound: unsupported message ${rootName}`);
    return soapFault(400, `Unsupported message: ${rootName}`);
  }
  try {
    return soapResponse(await handler({ db: deps.db, root, now }));
  } catch (e) {
    log.error(`siteminder inbound: ${rootName} failed`, e);
    return soapFault(500, "Internal error");
  }
}
