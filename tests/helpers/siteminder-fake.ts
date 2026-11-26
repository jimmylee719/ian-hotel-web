import { readFileSync } from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";

export const fixture = (name: string): string =>
  readFileSync(path.resolve(__dirname, "../fixtures/siteminder", name), "utf8");

/** A fixture with its {{PLACEHOLDERS}} filled. */
export const filled = (name: string, values: Record<string, string>): string =>
  fixture(name).replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => values[k] ?? m);

/** Parse an outbound request: prefixes removed, repeatable elements always arrays (XPath-like access). */
const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "@", removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false,
  isArray: (n) => ["RoomStay", "Rate", "Service", "GuestCount", "Comment", "ResGuest", "HotelReservation"].includes(n),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const parseRequest = (xml: string): any => parser.parse(xml);

/** Follow "a/b/c" (array steps use [n], default the first), "@x" for an attribute. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function xp(node: any, p: string): any {
  let cur = node;
  for (const step of p.split("/")) {
    const m = /^([^[]+)(?:\[(\d+)\])?$/.exec(step)!;
    cur = cur?.[m[1]];
    if (Array.isArray(cur)) cur = cur[m[2] ? Number(m[2]) : 0];
  }
  return cur;
}

type Held = { resId: string; state: "active" | "cancelled" };

/**
 * A fake SiteMinder reservation endpoint, answering with the doc-derived fixtures and keeping SiteMinder's rules
 * (docs/integrations/siteminder.md §3, §8.6): wrong credentials → the credentials error; a HotelCode it does not
 * know → "Hotel not found"; CreateDateTime (and LastModifyDateTime for Modify / Cancel) required; a Commit of a
 * UniqueID it already holds is ignored and answered with the same ResID_Value (SITEMINDER-OPEN-Q1 as assumed); a
 * Modify of an unknown or cancelled UniqueID and a Cancel of an unknown one are refused (Q10, our stand-in fixture);
 * nothing brings a cancelled UniqueID back.
 */
export function fakeSiteMinder(o: { username: string; password: string; hotelCode: string }) {
  const held = new Map<string, Held>();
  const requests: string[] = [];
  let seq = 0;
  const xml = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/xml; charset=utf-8" } });

  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    requests.push(body);
    const doc = parseRequest(body);
    const token = xp(doc, "Envelope/Header/Security/UsernameToken");
    const rq = xp(doc, "Envelope/Body/OTA_HotelResNotifRQ");
    const ECHO_TOKEN = rq?.["@EchoToken"] ?? "";
    if (xp(token, "Username") !== o.username || xp(token, "Password/#text") !== o.password)
      return xml(filled("res-notif-rs-error-credentials.xml", { ECHO_TOKEN }));
    const hr = xp(rq, "HotelReservations/HotelReservation");
    const hotel = xp(hr, "RoomStays/RoomStay/BasicPropertyInfo/@HotelCode");
    if (!hotel) return xml(filled("res-notif-rs-error-no-hotel-codes.xml", { ECHO_TOKEN }));
    if (hotel !== o.hotelCode) return xml(filled("res-notif-rs-error-hotel-not-found.xml", { ECHO_TOKEN, HOTEL_CODE: hotel }));
    const status = rq["@ResStatus"] as string;
    if (!hr["@CreateDateTime"]) return xml(filled("res-notif-rs-error-node-missing.xml", { ECHO_TOKEN, NODE: "CreateDateTime" }));
    if (status !== "Commit" && !hr["@LastModifyDateTime"])
      return xml(filled("res-notif-rs-error-node-missing.xml", { ECHO_TOKEN, NODE: "LastModifyDateTime" }));
    const UNIQUE_ID = xp(hr, "UniqueID/@ID") as string;
    const h = held.get(UNIQUE_ID);
    const ok = (x: Held) => xml(filled("res-notif-rs-success.xml", { ECHO_TOKEN, UNIQUE_ID, RES_ID: x.resId }));
    const refuse = (ACTION: string) => xml(filled("res-notif-rs-error-fake-unknown.xml", { ECHO_TOKEN, UNIQUE_ID, ACTION }));
    if (status === "Commit") {
      if (h) return ok(h); // a UniqueID already used is ignored
      const x: Held = { resId: `SMR${++seq}${UNIQUE_ID}`, state: "active" };
      held.set(UNIQUE_ID, x);
      return ok(x);
    }
    if (status === "Modify") return h && h.state === "active" ? ok(h) : refuse("modified");
    if (status === "Cancel") {
      if (!h) return refuse("cancelled");
      h.state = "cancelled";
      return ok(h);
    }
    return xml(filled("res-notif-rs-error-node-missing.xml", { ECHO_TOKEN, NODE: "ResStatus" }));
  }) as typeof globalThis.fetch;

  return { fetch, requests, held };
}
