/** Scroll reveals run only when the visitor has not asked for reduced motion. Pass `q => window.matchMedia(q)`. */
export function revealEnabled(matchMedia: (q: string) => { matches: boolean }): boolean {
  return !matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * IntersectionObserver options for scroll reveals: a block counts as in view once any part of it is above the bottom
 * 10% of the viewport. A ratio threshold (e.g. 0.15) would never be reached by a block taller than 1/ratio viewports,
 * leaving it hidden for good; a margin works at any height.
 */
export const REVEAL_OBSERVER: IntersectionObserverInit = { threshold: 0, rootMargin: "0px 0px -10% 0px" };
