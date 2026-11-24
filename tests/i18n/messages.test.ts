import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { LOCALES } from "@/lib/db/schema";

type Tree = { [k: string]: string | Tree };

function load(locale: string): Tree {
  return JSON.parse(readFileSync(path.resolve(__dirname, `../../messages/${locale}.json`), "utf8"));
}

function flatten(tree: Tree, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v as Tree, key));
    else out[key] = v;
  }
  return out;
}

describe("messages", () => {
  const flat = Object.fromEntries(LOCALES.map((l) => [l, flatten(load(l))]));

  test("every locale has exactly the same keys", () => {
    const reference = Object.keys(flat["zh-TW"]).sort();
    expect(reference.length).toBeGreaterThan(20);
    for (const l of LOCALES) expect(Object.keys(flat[l]).sort(), l).toEqual(reference);
  });

  test("every value is a non-empty string", () => {
    for (const l of LOCALES)
      for (const [k, v] of Object.entries(flat[l])) {
        expect(typeof v, `${l}:${k}`).toBe("string");
        expect((v as string).trim(), `${l}:${k}`).not.toBe("");
      }
  });
});
