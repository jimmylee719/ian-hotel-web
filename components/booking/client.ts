"use client";

import type { ReservationView } from "@/lib/booking/manage";
import type { ChargeStart } from "@/lib/payments/types";

/** What the details page keeps in sessionStorage for a booking, so the return page can show it and retry payment. */
export type StoredBooking = { email: string; body: unknown };
const key = (code: string) => `nk-booking:${code.toUpperCase()}`;

export function rememberBooking(code: string, b: StoredBooking) {
  try {
    sessionStorage.setItem(key(code), JSON.stringify(b));
  } catch {
    /* private mode: the pages fall back to asking for the email */
  }
}

export function recallBooking(code: string): StoredBooking | null {
  try {
    const raw = sessionStorage.getItem(key(code));
    return raw ? (JSON.parse(raw) as StoredBooking) : null;
  } catch {
    return null;
  }
}

/** Send the browser to the payment page the way the gateway asked for. */
export function followChargeStart(start: ChargeStart) {
  if (start.kind === "redirect") {
    window.location.assign(start.url);
    return;
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = start.action;
  for (const [name, value] of Object.entries(start.fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

export type StatusView = ReservationView & { paymentState: "succeeded" | "failed" | "pending" };
export type StatusResult =
  | { ok: true; view: StatusView }
  | { ok: false; error: "NOT_FOUND" | "NETWORK" }
  | { ok: false; error: "RATE_LIMITED"; retryAfterMs: number };

export async function fetchStatus(code: string, email: string): Promise<StatusResult> {
  try {
    const res = await fetch(`/api/bookings/${encodeURIComponent(code)}/status?email=${encodeURIComponent(email)}`, { cache: "no-store" });
    if (res.status === 404) return { ok: false, error: "NOT_FOUND" };
    if (res.status === 429) {
      const sec = Number(res.headers.get("Retry-After"));
      return { ok: false, error: "RATE_LIMITED", retryAfterMs: Number.isFinite(sec) && sec > 0 ? sec * 1000 : 5000 };
    }
    if (!res.ok) return { ok: false, error: "NETWORK" };
    return { ok: true, view: (await res.json()) as StatusView };
  } catch {
    return { ok: false, error: "NETWORK" };
  }
}

/** POST /api/bookings with a stored body (idempotent: the same key restarts the same booking's payment). */
export async function startBooking(body: unknown): Promise<{ ok: true; code: string; start: ChargeStart } | { ok: false; status: number; error?: string; detail?: string }> {
  try {
    const res = await fetch("/api/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { code?: string; start?: ChargeStart; error?: string; detail?: string };
    if (res.ok && json.code && json.start) return { ok: true, code: json.code, start: json.start };
    return { ok: false, status: res.status, error: json.error, detail: json.detail };
  } catch {
    return { ok: false, status: 0 };
  }
}
