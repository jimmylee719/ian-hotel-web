export type HeaderTheme = "ink" | "paper";

/** Locale-less path prefixes whose pages keep the paper header (booking and manage flows). */
const PAPER_PREFIXES = ["/book", "/manage"] as const;

/**
 * The header variant for a locale-less pathname (next-intl's `usePathname`): `"paper"` on the
 * booking and manage flows, `"ink"` everywhere else. A prefix only matches a whole path segment,
 * so `/booking-terms` stays ink.
 */
export function headerTheme(pathname: string): HeaderTheme {
  return PAPER_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ? "paper" : "ink";
}
