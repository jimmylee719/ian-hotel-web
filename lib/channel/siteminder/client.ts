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
 * - smConfirmation is SiteMinder's HotelReservationID@ResID_Value. Without one in a Success, the UniqueID we sent
 *   stands in (inferred: SiteMinder finds a reservation by UniqueID [RES]; SITEMINDER-OPEN-Q1).
 * - A modify or cancel answered without a ResID_Value succeeds and keeps the smConfirmation given; one answered
 *   with a DIFFERENT ResID_Value is reported as a failure, not retryable (SiteMinder has applied it, but its id for
 *   the booking is not ours, so staff check). SITEMINDER-OPEN-Q1: whether Modify / Cancel answers carry it at all.
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
    return a.ok ? { ok: true, smConfirmation: a.resId ?? uniqueIdFor(r.code) } : a;
  }

  async modifyReservation(r: ChannelReservation, smConfirmation: string): Promise<PushResult> {
    if (!smConfirmation) return local("NO_SM_CONFIRMATION");
    const a = await this.send(RES_STATUS.modify, r);
    if (!a.ok) return a;
    return sameReservation(a, smConfirmation) ?? { ok: true, smConfirmation };
  }

  async cancelReservation(r: ChannelReservation, smConfirmation: string): Promise<CancelResult> {
    if (!smConfirmation) return local("NO_SM_CONFIRMATION");
    const a = await this.send(RES_STATUS.cancel, r);
    if (!a.ok) return a;
    return sameReservation(a, smConfirmation) ?? { ok: true, retryable: false };
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

/**
 * SITEMINDER-OPEN-Q1: a Modify / Cancel answer names the reservation by ResID_Value, or not at all. None = the one
 * we hold (success). A different one = a failure (the message was sent and applied: kind confirmation_mismatch).
 */
function sameReservation(a: { resId?: string; echoToken?: string }, smConfirmation: string): ChannelFailure | null {
  if (a.resId === undefined || a.resId === smConfirmation) return null;
  return {
    ok: false, retryable: false,
    error: `SM_CONFIRMATION_MISMATCH: the channel answered for ${a.resId} (echo=${a.echoToken ?? "?"})`,
    detail: { kind: "confirmation_mismatch", echoToken: a.echoToken },
  };
}

/** A failure decided here, without calling SiteMinder. */
function local(error: string, retryable = false): ChannelFailure {
  return { ok: false, retryable, error, detail: { kind: "config" } };
}
