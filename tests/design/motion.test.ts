import { describe, expect, it } from "vitest";
import { REVEAL_OBSERVER, revealEnabled } from "@/lib/design/motion";

describe("revealEnabled", () => {
  it("is false when the visitor prefers reduced motion", () => {
    expect(revealEnabled((q) => ({ matches: q.includes("reduce") }))).toBe(false);
  });

  it("is true otherwise", () => {
    expect(revealEnabled(() => ({ matches: false }))).toBe(true);
  });

  it("asks for the reduced-motion media query", () => {
    const asked: string[] = [];
    revealEnabled((q) => {
      asked.push(q);
      return { matches: false };
    });
    expect(asked).toEqual(["(prefers-reduced-motion: reduce)"]);
  });
});

describe("REVEAL_OBSERVER", () => {
  it("triggers on any visible part, so a block taller than several viewports still reveals", () => {
    // A ratio threshold above 0 is unreachable for a block taller than 1/threshold viewports.
    expect(REVEAL_OBSERVER.threshold).toBe(0);
  });
  it("waits until the block is a little way into the viewport", () => {
    expect(REVEAL_OBSERVER.rootMargin).toBe("0px 0px -10% 0px");
  });
});
