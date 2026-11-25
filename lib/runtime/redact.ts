/** What a masked value is replaced with. */
export const REDACTED = "[REDACTED]";

/**
 * Field names whose values are secrets: anything ending in password / secret / key / token (so apiKey, hashKey,
 * RESEND_API_KEY, accessToken, client_secret), hashIV, and the Authorization / Cookie headers.
 */
const SECRET_NAME = String.raw`[A-Za-z0-9_\-]*(?:password|passwd|secret|key|token|hashiv)|(?:proxy-)?authorization|(?:set-)?cookie`;

/** JSON form: "name": "value" or "name": 123. The value is replaced by a JSON string, so the JSON stays valid. */
const JSON_FIELD = new RegExp(String.raw`("(?:${SECRET_NAME})"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*)`, "gi");

/** Header form for Authorization / Cookie: the whole rest of the line ("Bearer x", "a=b; c=d"). */
const AUTH_HEADER = /(^|[^\w-])((?:proxy-)?authorization|(?:set-)?cookie)(\s*:[ \t]*)[^\r\n]+/gi;

/** Header form for the other secret names: one token ("X-Api-Key: abc"). */
const SECRET_HEADER = new RegExp(String.raw`(^|[^\w-])(${SECRET_NAME})(\s*:[ \t]*)(?!\[REDACTED\])[^\s,;&]+`, "gi");

/** key=value form (query strings, env dumps, form bodies): the value up to the next separator, or a quoted value. */
const KEY_VALUE = new RegExp(String.raw`(^|[^\w-])(${SECRET_NAME})(\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s&;,"')\]}]+)`, "gi");

/**
 * Card-like digit runs: groups of 3+ digits joined by single spaces or hyphens, 13 or more digits in all
 * (4111 1111 1111 1111, 3782-822463-10005, 4111111111111111). Groups of 1–2 digits break a run, so ISO dates
 * (2026-12-01), times and phone numbers (+886 2 1234 5678) are left alone; so are amounts under 13 digits.
 */
const DIGIT_RUN = /(?<!\w)\d{3,}(?:[ -]\d{3,})*(?!\w)/g;
const MIN_CARD_DIGITS = 13;

/**
 * Mask secrets in a log line or alert text: card-like numbers (13–19 digits, spaces or hyphens allowed), the values
 * of Authorization and Cookie, and the values of fields named password / secret / key / token / hashKey / hashIV
 * (and names ending in them) in key=value, JSON ("key":"value") and header ("Key: value") forms.
 */
export function redact(s: string): string {
  return s
    .replace(JSON_FIELD, (_m, head: string) => `${head}"${REDACTED}"`)
    .replace(AUTH_HEADER, (_m, pre: string, name: string, sep: string) => `${pre}${name}${sep}${REDACTED}`)
    .replace(SECRET_HEADER, (_m, pre: string, name: string, sep: string) => `${pre}${name}${sep}${REDACTED}`)
    .replace(KEY_VALUE, (_m, pre: string, name: string, sep: string) => `${pre}${name}${sep}${REDACTED}`)
    .replace(DIGIT_RUN, (m) => (m.replace(/\D/g, "").length >= MIN_CARD_DIGITS ? REDACTED : m));
}

/** redact for any log argument: strings and Error messages/stacks are masked; plain data is masked through JSON. */
export function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redact(v);
  if (v instanceof Error) return redactError(v, 0);
  if (v === null || typeof v !== "object") return v;
  let json: string | undefined;
  try {
    json = JSON.stringify(v);
  } catch {
    return redact(String(v));
  }
  if (json === undefined) return v;
  const masked = redact(json);
  if (masked === json) return v;
  try {
    return JSON.parse(masked);
  } catch {
    return masked;
  }
}

/** How deep an Error's cause chain is followed (drizzle wraps the SQLite/D1 error one level down). */
const MAX_CAUSE_DEPTH = 5;

/**
 * A redacted copy of an Error: message and stack masked, name kept, and its `cause` chain kept (each cause redacted
 * the same way, up to MAX_CAUSE_DEPTH levels), so a DrizzleQueryError still shows the SQLite/D1 reason underneath.
 */
function redactError(e: Error, depth: number): Error {
  const copy = new Error(redact(e.message));
  copy.name = e.name;
  copy.stack = e.stack === undefined ? undefined : redact(e.stack);
  if (e.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    copy.cause = e.cause instanceof Error ? redactError(e.cause, depth + 1) : redactValue(e.cause);
  }
  return copy;
}
