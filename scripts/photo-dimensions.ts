/**
 * Generates lib/content/photo-dimensions.json: pixel size of every file under content/images,
 * keyed "<dir>/<file>" (the R2 key format). Run: npx tsx scripts/photo-dimensions.ts
 */
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import sharp from "sharp";

const ROOT = join(process.cwd(), "content/images");
const OUT = join(process.cwd(), "lib/content/photo-dimensions.json");

async function main() {
  const out: Record<string, { w: number; h: number }> = {};
  for (const dir of readdirSync(ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(ROOT, dir.name))) {
      const meta = await sharp(join(ROOT, dir.name, f)).metadata();
      if (!meta.width || !meta.height) throw new Error(`no dimensions: ${dir.name}/${f}`);
      out[`${dir.name}/${f}`] = { w: meta.width, h: meta.height };
    }
  }
  const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`wrote ${Object.keys(sorted).length} entries`);
}

main();
