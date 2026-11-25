/** UTF-8 byte order mark: makes Excel (zh-TW included) read the file as UTF-8 instead of Big5. */
const BOM = "﻿";

/**
 * Formula-injection guard: a cell Excel or Sheets would read as a formula (leading = + - @, tab or CR) gets a `'`
 * in front. Applies to every string cell (numeric-looking strings and header labels too); real numbers are not text and stay raw.
 */
const guard = (s: string): string => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

/** RFC 4180: quote a field that holds a comma, a quote or a line break, doubling the quotes inside. */
const quote = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Finite JS numbers are written raw (a negative net stays a number Excel can add up); everything else is text and guarded. */
const cell = (v: unknown): string =>
  v === null || v === undefined ? "" : typeof v === "number" && Number.isFinite(v) ? String(v) : quote(guard(String(v)));

/**
 * Rows as CSV for Excel: a BOM, CRLF line endings (a trailing one included), RFC 4180 quoting and the
 * formula-injection guard on every cell. The header row comes from the columns' labels.
 */
export function toCsv(rows: Record<string, unknown>[], columns: { key: string; label: string }[]): string {
  const lines = [columns.map((c) => cell(c.label)), ...rows.map((r) => columns.map((c) => cell(r[c.key])))];
  return BOM + lines.map((l) => l.join(",") + "\r\n").join("");
}
