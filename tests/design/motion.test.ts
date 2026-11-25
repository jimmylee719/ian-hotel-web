import { describe, expect, it } from "vitest";
import { revealEnabled } from "@/lib/design/motion";

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
