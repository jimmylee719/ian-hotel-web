/**
 * Pre-generates WebP width variants of every photo in content/images and uploads them to the R2
 * bucket nk-media under `_w{width}/{key}.webp` (see lib/media.ts). Used when the site runs with
 * NEXT_PUBLIC_MEDIA_VARIANTS=1, i.e. without Cloudflare Images transformations.
 *
 *   npx tsx scripts/media-variants.ts            # local R2 (wrangler --local)
 *   npx tsx scripts/media-variants.ts --remote   # the real bucket
 *
 * Never upscales: a variant wider than its source is written at the source width.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { VARIANT_WIDTHS, variantKey } from "../lib/media";

const run = promisify(execFile);
const SRC = path.resolve("content/images");
const OUT = path.resolve(".wrangler/tmp/media-variants");
const remote = process.argv.includes("--remote");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(jpe?g|png|webp)$/i.test(name) ? [p] : [];
  });
}

async function main() {
  const files = walk(SRC);
  const variants = files.flatMap((file) => {
    const key = path.relative(SRC, file).split(path.sep).join("/");
    return VARIANT_WIDTHS.map((width) => ({ file, width, key: variantKey(key, width) }));
  });

  // Resizing runs in parallel; uploads one at a time (concurrent `wrangler r2 object put --local` fails).
  await Promise.all(
    variants.map(async (v) => {
      const out = path.join(OUT, v.key);
      mkdirSync(path.dirname(out), { recursive: true });
      await sharp(v.file).resize({ width: v.width, withoutEnlargement: true }).webp({ quality: 72 }).toFile(out);
    }),
  );
  for (const [i, v] of variants.entries()) {
    await run("npx", ["wrangler", "r2", "object", "put", `nk-media/${v.key}`, "--file", path.join(OUT, v.key), "--content-type", "image/webp", remote ? "--remote" : "--local"]);
    if ((i + 1) % 50 === 0) console.log(`${i + 1} of ${variants.length} uploaded`);
  }
  console.log(`done: ${variants.length} variants of ${files.length} images`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
