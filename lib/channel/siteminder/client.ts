import { log } from "@/lib/runtime/log";
import {
  CHANNEL_MAX_TIMEOUT_MS, CHANNEL_MIN_TIMEOUT_MS,
  type CancelResult, type ChannelFailure, type ChannelManager, type ChannelReservation, type PushResult,
} from "../types";
import { classifyAnswer, networkFailure, timeoutFailure, type ClassifiedAnswer } from "./errors";
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
 * - A modify or cancel whose answer carries another ResID_Value than the smConfirmation given is reported as a
 *   failure, not retryable: SiteMinder has applied it, but its id for the booking is not ours, so staff check.
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
    return this.sameReservation(a, r, smConfirmation) ?? { ok: true, smConfirmation };
  }

  async cancelReservation(r: ChannelReservation, smConfirmation: string): Promise<CancelResult> {
    if (!smConfirmation) return local("NO_SM_CONFIRMATION");
    const a = await this.send(RES_STATUS.cancel, r);
    if (!a.ok) return a;
    return this.sameReservation(a, r, smConfirmation) ?? { ok: true, retryable: false };
  }

  /** A failure when the answer names another reservation than `smConfirmation`, else null. */
  private sameReservation(a: { resId?: string }, r: ChannelReservation, smConfirmation: string): ChannelFailure | null {
    const theirs = a.resId ?? uniqueIdFor(r.code);
    return theirs === smConfirmation ? null : local("SM_CONFIRMATION_MISMATCH");
  }

  private async hotelCode(): Promise<string> {
    const h = this.opts.hotelCode;
    try {
      return (typeof h === "function" ? await h() : h).trim();
    } catch {
      return "";
    }
  }

  /** One OTA_HotelResNotifRQ for `r`, its answer classified. */
  private async send(status: ResStatus, r: ChannelReservation): Promise<ClassifiedAnswer> {
    const uid = uniqueIdFor(r.code);
    const hotel = await this.hotelCode();
    // Our configuration: retried, so bookings go out once it is fixed.
    if (!hotel) return local("SITEMINDER_HOTEL_CODE_NOT_SET", true);
    if (r.smPropertyCode !== hotel) return local("HOTEL_CODE_MISMATCH");
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
      return answer;
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
      return { status: res.status, body: await res.text() };
    })();
    try {
      const out = await Promise.race([call, timedOut]);
      if (out === "timeout") {
        call.catch(() => {}); // the abandoned call may still settle
        return timeoutFailure(echoToken);
      }
      return classifyAnswer(out.status, out.body, echoToken);
    } catch (e) {
      if (ctrl.signal.aborted || (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")))
        return timeoutFailure(echoToken);
      return networkFailure(echoToken, e);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A failure decided here, without calling SiteMinder. */
function local(error: string, retryable = false): ChannelFailure {
  return { ok: false, retryable, error, detail: { kind: "config" } };
}
