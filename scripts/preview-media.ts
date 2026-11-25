/**
 * For the public preview (wrangler env.preview, no R2): writes every photo in content/images, plus its WebP width
 * variants, into the built static assets at .open-next/assets/media/, so /media/... is served straight from Workers
 * static assets. Run after `opennextjs-cloudflare build --env preview` and before deploy (npm run deploy:preview).
 * Never upscales: a variant wider than its source is written at the source width.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { VARIANT_WIDTHS, variantKey } from "../lib/media";

const SRC = path.resolve("content/images");
const ASSETS = path.resolve(".open-next/assets");
const OUT = path.join(ASSETS, "media");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(jpe?g|png|webp)$/i.test(name) ? [p] : [];
  });
}

async function main() {
  if (!existsSync(ASSETS)) throw new Error("no .open-next/assets: run `opennextjs-cloudflare build --env preview` first");
  const files = walk(SRC);
  let n = 0;
  await Promise.all(
    files.map(async (file) => {
      const key = path.relative(SRC, file).split(path.sep).join("/");
      const original = path.join(OUT, key);
      mkdirSync(path.dirname(original), { recursive: true });
      copyFileSync(file, original);
      for (const width of VARIANT_WIDTHS) {
        const out = path.join(OUT, variantKey(key, width));
        mkdirSync(path.dirname(out), { recursive: true });
        await sharp(file).resize({ width, withoutEnlargement: true }).webp({ quality: 72 }).toFile(out);
        n++;
      }
    }),
  );
  console.log(`preview media: ${files.length} photos and ${n} variants in ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
