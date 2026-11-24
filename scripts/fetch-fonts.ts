/**
 * Self-hosts the CJK web fonts (design/tokens.md section 2) as public/fonts/{zh,ja,ko}.css plus
 * their unicode-range woff2 slices. Runs before `next build` (npm "prebuild"); skips fonts already
 * downloaded unless --force.
 *
 * Why not next/font: next/font puts every @font-face of every family into render-blocking CSS on
 * every page (about 600 KB uncompressed for Noto Serif TC + Shippori Mincho + Gowun Batang), which
 * kept mobile First Contentful Paint above 3 s. components/layout/CjkFonts.tsx loads these sheets
 * without blocking rendering, and only the ja / ko sheet on its own locale.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const FAMILIES = {
  zh: "Noto+Serif+TC:wght@400;500;600",
  ja: "Shippori+Mincho:wght@400;500",
  ko: "Gowun+Batang:wght@400;700",
} as const;

// A current desktop Chrome UA makes Google Fonts answer with woff2 and unicode-range slices.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const OUT = path.resolve("public/fonts");
const force = process.argv.includes("--force");

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init).catch((e: unknown) => e as Error);
    if (res instanceof Response && res.ok) return res;
    if (attempt === 3) throw new Error(`GET ${url} failed: ${res instanceof Response ? res.status : res.message}`);
  }
}

async function selfHost(id: keyof typeof FAMILIES) {
  const cssFile = path.join(OUT, `${id}.css`);
  if (existsSync(cssFile) && !force) return console.log(`fonts: ${id} already present`);

  const css = await (await fetchOk(`https://fonts.googleapis.com/css2?family=${FAMILIES[id]}&display=swap`, { headers: { "user-agent": UA } })).text();
  const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/g)].map((m) => m[1]))];
  if (!urls.length) throw new Error(`fonts: no woff2 files in the ${id} stylesheet`);

  mkdirSync(path.join(OUT, id), { recursive: true });
  const local = new Map<string, string>();
  const queue = [...urls];
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        const name = url.split("/").slice(-2).join("-"); // the last two path parts are unique per slice
        writeFileSync(path.join(OUT, id, name), Buffer.from(await (await fetchOk(url)).arrayBuffer()));
        local.set(url, `/fonts/${id}/${name}`);
      }
    }),
  );
  writeFileSync(cssFile, css.replace(/https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2/g, (u) => local.get(u)!));
  console.log(`fonts: ${id} self-hosted (${urls.length} files)`);
}

async function main() {
  for (const id of Object.keys(FAMILIES) as (keyof typeof FAMILIES)[]) await selfHost(id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
