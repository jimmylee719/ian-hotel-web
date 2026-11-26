import { log } from "@/lib/runtime/log";
import {
  CHANNEL_MAX_TIMEOUT_MS, CHANNEL_MIN_TIMEOUT_MS,
  type CancelResult, type ChannelFailure, type ChannelManager, type ChannelReservation, type PushResult,
} from "../types";
import { classifyAnswer, networkFailure, retryAfterMs, timeoutFailure, type ClassifiedAnswer } from "./errors";
import { XML_CONTENT_TYPE } from "./inbound/soap";
import { RES_STATUS, resNotifRQ, uniqueIdFor, unsendableReason, type ResStatus } from "./map";
import { requestEnvelope } from "./xml";

export type SiteMinderOptions = {
  /** SiteMinder's reservation SOAP endpoint (SITEMINDER_ENDPOINT; its host is checked by config-guard). */
  endpoint: string;
  /** The WS-Security credentials SiteMinder gave us (secrets SITEMINDER_USERNAME / SITEMINDER_PASSWORD). */
  username: string;
  password: string;
  /**
   * The property's HotelCode (properties.smPropertyCode), or how to read it. Every reservation sent must carry it:
   * these credentials and this adapter serve that one hotel.
   */
  hotelCode: string | (() => Promise<string>);
  /** Our channel code from SiteMinder: POS/Source/RequestorID@ID [REQ][RES]. */
  requestorId: string;
  /** BookingChannel/CompanyName text. */
  companyName?: string;
  fetch?: typeof fetch;
  /** One call's limit, within CHANNEL_MIN_TIMEOUT_MS..CHANNEL_MAX_TIMEOUT_MS (60–120 s, [ERR-G]). */
  timeoutMs?: number;
  /** For tests: the clock (TimeStamp) and EchoToken source. EchoToken default: a UUID per request [REQ]. */
  now?: () => Date;
  echoToken?: () => string;
};

export const SITEMINDER_DEFAULT_TIMEOUT_MS = CHANNEL_MIN_TIMEOUT_MS;

/**
 * SiteMinder SiteConnect reservations (OTA_HotelResNotifRQ, docs/integrations/siteminder.md §3): push = Commit,
 * modify = Modify, cancel = Cancel, one reservation per request, the whole booking in each. No lookup: SiteConnect
 * has none (doc §8.3).
 * - Every request has a fresh EchoToken (UUID); it is logged with the outcome and kept in a failure's error text
 *   and detail, so a call can be traced with SiteMinder.
 * - smConfirmation is SiteMinder's HotelReservationID@ResID_Value (commitConfirmation, followUpConfirmation:
 *   the SITEMINDER-OPEN-Q1 decisions, below).
 * - Never throws; every failure is structured (lib/channel/types.ts ChannelErrorDetail).
 * - Logs (through redact) carry the status, UniqueID, EchoToken and outcome only: never credentials, XML or guest data.
 */
export class SiteMinderChannelManager implements ChannelManager {
  readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly echo: () => string;

  constructor(private readonly opts: SiteMinderOptions) {
    const t = opts.timeoutMs ?? SITEMINDER_DEFAULT_TIMEOUT_MS;
    if (!(t >= CHANNEL_MIN_TIMEOUT_MS && t <= CHANNEL_MAX_TIMEOUT_MS))
      throw new RangeError(`SiteMinder timeoutMs must be ${CHANNEL_MIN_TIMEOUT_MS}–${CHANNEL_MAX_TIMEOUT_MS}`);
    this.timeoutMs = t;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => new Date());
    this.echo = opts.echoToken ?? (() => crypto.randomUUID());
  }

  async pushReservation(r: ChannelReservation): Promise<PushResult> {
    const a = await this.send(RES_STATUS.push, r);
    return a.ok ? { ok: true, smConfirmation: commitConfirmation(a.resId, r.code) } : a;
  }

  async modifyReservation(r: ChannelReservation, smConfirmation: string): Promise<PushResult> {
    if (!smConfirmation) return local("NO_SM_CONFIRMATION");
    const a = await this.send(RES_STATUS.modify, r);
    if (!a.ok) return a;
    const f = followUpConfirmation(a, smConfirmation, r.code);
    return "error" in f ? f : { ok: true, smConfirmation: f.smConfirmation };
  }

  async cancelReservation(r: ChannelReservation, smConfirmation: string): Promise<CancelResult> {
    if (!smConfirmation) return local("NO_SM_CONFIRMATION");
    const a = await this.send(RES_STATUS.cancel, r);
    if (!a.ok) return a;
    const f = followUpConfirmation(a, smConfirmation, r.code);
    return "error" in f ? f : { ok: true, retryable: false };
  }

  /** The HotelCode, or why there is none (the resolver's own SITEMINDER_… reason is kept). */
  private async hotelCode(): Promise<{ code: string } | { reason: string }> {
    const h = this.opts.hotelCode;
    try {
      const code = (typeof h === "function" ? await h() : h).trim();
      return code ? { code } : { reason: "SITEMINDER_HOTEL_CODE_NOT_SET" };
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      return { reason: /^SITEMINDER_[A-Z_]+$/.test(m) ? m : "SITEMINDER_HOTEL_CODE_NOT_SET" };
    }
  }

  /** One OTA_HotelResNotifRQ for `r`, its answer classified. */
  private async send(status: ResStatus, r: ChannelReservation): Promise<Sent> {
    const uid = uniqueIdFor(r.code);
    const hotel = await this.hotelCode();
    // Our configuration: retried, so bookings go out once it is fixed.
    if ("reason" in hotel) return local(hotel.reason, true);
    if (r.smPropertyCode !== hotel.code) return local("HOTEL_CODE_MISMATCH");
    const bad = unsendableReason(r);
    if (bad) return local(bad);

    const echoToken = this.echo();
    const xml = requestEnvelope(
      { username: this.opts.username, password: this.opts.password },
      resNotifRQ(r, { status, echoToken, now: this.now(), requestorId: this.opts.requestorId, companyName: this.opts.companyName ?? "NK Hostel" }),
    );
    const answer = await this.post(xml, echoToken);
    if (answer.ok) {
      if (answer.echoToken !== undefined && answer.echoToken !== echoToken)
        log.warn(`siteminder ${status} ${uid}: answer EchoToken differs from the request's (echo=${echoToken})`);
      for (const w of answer.warnings) log.warn(`siteminder ${status} ${uid} echo=${echoToken}: warning type=${w.type ?? "?"} code=${w.code ?? "-"}`);
      log.info(`siteminder ${status} ${uid} echo=${echoToken}: ok`);
      return { ...answer, echoToken };
    }
    const d = answer.detail;
    log.warn(`siteminder ${status} ${uid} echo=${echoToken}: ${answer.retryable ? "retryable" : "not retryable"} kind=${d?.kind}`
      + `${d?.httpStatus !== undefined ? ` http=${d.httpStatus}` : ""}${d?.type !== undefined ? ` type=${d.type}` : ""}${d?.code !== undefined ? ` code=${d.code}` : ""}`);
    return { ...answer, error: `${answer.error} (echo=${echoToken})` };
  }

  /** POST under the timeout (request and body read alike); an abort or a stall past timeoutMs is a timeout. */
  private async post(xml: string, echoToken: string): Promise<ClassifiedAnswer> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        ctrl.abort();
        resolve("timeout");
      }, this.timeoutMs);
    });
    const call = (async () => {
      const res = await this.fetchFn(this.opts.endpoint, {
        method: "POST", body: xml, signal: ctrl.signal,
        // SITEMINDER-OPEN-Q19: the SOAPAction SiteMinder expects (none documented; an empty one is sent).
        headers: { "content-type": XML_CONTENT_TYPE, accept: "text/xml", soapaction: '""' },
      });
      return { status: res.status, body: await res.text(), retryAfter: retryAfterMs(res.headers.get("retry-after"), this.now()) };
    })();
    try {
      const out = await Promise.race([call, timedOut]);
      if (out === "timeout") {
        call.catch(() => {}); // the abandoned call may still settle
        return timeoutFailure(echoToken);
      }
      return classifyAnswer(out.status, out.body, echoToken, out.retryAfter);
    } catch (e) {
      if (ctrl.signal.aborted || (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")))
        return timeoutFailure(echoToken);
      return networkFailure(echoToken, e);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A classified answer; a success carries the request's EchoToken. */
type Sent = ClassifiedAnswer;

// ---- SITEMINDER-OPEN-Q1 decisions (which id names the reservation), in one place ----

/**
 * SITEMINDER-OPEN-Q1: the smConfirmation a Commit Success gives: its ResID_Value, or, when it carries none, the
 * UniqueID we sent as a placeholder (inferred: SiteMinder finds a reservation by UniqueID [RES]).
 */
export function commitConfirmation(resId: string | undefined, code: string): string {
  return resId ?? placeholderConfirmation(code);
}

/** SITEMINDER-OPEN-Q1: the placeholder stored when a Commit answer had no ResID_Value. */
export const placeholderConfirmation = (code: string): string => uniqueIdFor(code);

/**
 * SITEMINDER-OPEN-Q1: what a Modify / Cancel Success says about the id we hold. No ResID_Value = the one we hold.
 * The same one = fine. A real one while we hold only the placeholder = SiteMinder's id at last: adopted. Any other
 * = a failure, not retryable (the message was applied, but SiteMinder's id is not ours: staff check).
 */
export function followUpConfirmation(
  a: { resId?: string; echoToken?: string }, held: string, code: string,
): { smConfirmation: string } | ChannelFailure {
  if (a.resId === undefined || a.resId === held) return { smConfirmation: held };
  if (held === placeholderConfirmation(code)) return { smConfirmation: a.resId };
  return {
    ok: false, retryable: false,
    error: `SM_CONFIRMATION_MISMATCH: the channel answered for ${a.resId} (echo=${a.echoToken ?? "?"})`,
    detail: { kind: "confirmation_mismatch", echoToken: a.echoToken },
  };
}

// ---- end of SITEMINDER-OPEN-Q1 decisions ----

/** A failure decided here, without calling SiteMinder. */
function local(error: string, retryable = false): ChannelFailure {
  return { ok: false, retryable, error, detail: { kind: "config" } };
}
