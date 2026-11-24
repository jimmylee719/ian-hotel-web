import { expect, test } from "vitest";
import { assertTwd, percentOf } from "@/lib/domain/money";

test("percentOf rounds to whole NT dollars", () => {
  expect(percentOf(1999, 10)).toBe(200);
});
test("assertTwd rejects fractions", () => {
  expect(() => assertTwd(1.5)).toThrow();
});
test("assertTwd rejects negatives", () => {
  expect(() => assertTwd(-1)).toThrow();
});
test("assertTwd passes integers through", () => {
  expect(assertTwd(4960)).toBe(4960);
});
