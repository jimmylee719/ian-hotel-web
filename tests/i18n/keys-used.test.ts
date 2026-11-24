import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Every literal key passed to a translator in app/ and components/ must exist in zh-TW (the other
 * locales are held to zh-TW's key set by messages.test.ts). A text scan, not a type check, so it is
 * deliberately simple: a translator is a `const x = useTranslations("ns")` / `getTranslations(...)`
 * binding (or one element of a `Promise.all([...])` destructuring), and a call is `x("key")`,
 * `x.rich("key")`, `x.markup("key")` or `x.raw("key")` with a quoted literal. Each call is matched to
 * the nearest binding of that name above it. Template-literal (dynamic) keys and `x.has(...)` are skipped.
 */

const ROOT = path.resolve(__dirname, "../..");

type Tree = { [k: string]: string | Tree };

function hasKey(tree: Tree, dotted: string): boolean {
  let node: string | Tree = tree;
  for (const part of dotted.split(".")) {
    if (typeof node !== "object" || !(part in node)) return false;
    node = node[part];
  }
  return typeof node === "string";
}

/** The namespace a translator factory call names: `"ns"`, `{ locale, namespace: "ns" }`, or none (root). */
function namespaceOf(args: string): string | null {
  const ns = /namespace:\s*["']([^"']+)["']/.exec(args) ?? /^\s*["']([^"']+)["']\s*$/.exec(args);
  if (ns) return ns[1];
  return args.trim() === "" || /^\{\s*locale\s*\}$/.test(args.trim()) ? "" : null;
}

/** Split `a, f(b, c), [d]` on top-level commas. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

type Binding = { name: string; ns: string; at: number };
type Usage = { key: string; ns: string; at: number };

const FACTORY = /(?:useTranslations|getTranslations)\(([^()]*)\)/;

/** Translator bindings in a source file, in order. */
function bindings(src: string): Binding[] {
  const out: Binding[] = [];
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(([^()]*)\)/g)) {
    const ns = namespaceOf(m[2]);
    if (ns !== null) out.push({ name: m[1], ns, at: m.index! });
  }
  for (const m of src.matchAll(/(?:const|let)\s+\[([^\]]+)\]\s*=\s*await\s+Promise\.all\(\s*\[([\s\S]*?)\]\s*\)/g)) {
    const names = splitTopLevel(m[1]).map((n) => n.trim());
    splitTopLevel(m[2]).forEach((el, i) => {
      const f = FACTORY.exec(el);
      const ns = f ? namespaceOf(f[1]) : null;
      if (ns !== null && /^\w+$/.test(names[i] ?? "")) out.push({ name: names[i], ns, at: m.index! });
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Every literal-key translator call in `src`, resolved to its namespace. */
function literalKeyUsages(src: string): Usage[] {
  const bound = bindings(src);
  const out: Usage[] = [];
  for (const name of new Set(bound.map((b) => b.name))) {
    const call = new RegExp(`(?<![\\w.])${name}(?:\\.(?:rich|markup|raw))?\\(\\s*(["'])([^"'\`$]+)\\1`, "g");
    for (const m of src.matchAll(call)) {
      const binding = bound.filter((b) => b.name === name && b.at < m.index!).at(-1);
      if (binding) out.push({ key: binding.ns ? `${binding.ns}.${m[2]}` : m[2], ns: binding.ns, at: m.index! });
    }
  }
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const zhTW = JSON.parse(readFileSync(path.join(ROOT, "messages/zh-TW.json"), "utf8")) as Tree;

describe("translation keys used in the source", () => {
  test("the scanner resolves namespaces, nearest bindings and Promise.all destructuring, and skips dynamic keys", () => {
    const src = `
      const t = await getTranslations({ locale, namespace: "meta" });
      t("title");
      const [h, faqs, f] = await Promise.all([getTranslations({ locale, namespace: "home" }), loadFaqs(locale), getTranslations({ locale, namespace: "footer" })]);
      const t = useTranslations("manage");
      t("cancel"); t.rich('noSuchKey'); h("x.y"); f("z"); t(\`status_\${s}\`); t.has("maybe"); other.t("nope");
    `;
    expect(literalKeyUsages(src).map((u) => u.key).sort())
      .toEqual(["footer.z", "home.x.y", "manage.cancel", "manage.noSuchKey", "meta.title"]);
    const missing = literalKeyUsages(src).filter((u) => !hasKey(zhTW, u.key)).map((u) => u.key);
    expect(missing).toEqual(expect.arrayContaining(["manage.noSuchKey"]));
    expect(missing).not.toContain("manage.cancel");
  });

  test("every literal key used in app/ and components/ exists in zh-TW", () => {
    const files = [...sources(path.join(ROOT, "app")), ...sources(path.join(ROOT, "components"))];
    let checked = 0;
    const missing: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const u of literalKeyUsages(src)) {
        checked++;
        if (!hasKey(zhTW, u.key)) missing.push(`${path.relative(ROOT, file)}: ${u.key}`);
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });
});
