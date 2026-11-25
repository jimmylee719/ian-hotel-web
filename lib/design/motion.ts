/** Scroll reveals run only when the visitor has not asked for reduced motion. Pass `q => window.matchMedia(q)`. */
export function revealEnabled(matchMedia: (q: string) => { matches: boolean }): boolean {
  return !matchMedia("(prefers-reduced-motion: reduce)").matches;
}
