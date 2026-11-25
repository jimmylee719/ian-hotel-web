/**
 * Pre-generates WebP width variants of every photo in content/images and uploads them to the R2
 * bucket nk-media under `_w{width}/{key}.webp` (see lib/media.ts). The site requests these by
 * default (unless NEXT_PUBLIC_CF_IMAGES=1); a missing variant falls back to the original photo.
 *
 *   npm run media:variants                # local R2 (also run by scripts/seed-local.ts)
 *   npm run media:variants -- --remote    # the production bucket (docs/DEPLOY.md launch checklist)
 *   npm run media:variants -- --remote --env staging   # env.staging's bucket (read from wrangler.jsonc)
 *
 * Never upscales: a variant wider than its source is written at the source width.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { VARIANT_WIDTHS, variantKey } from "../lib/media";

const run = promisify(execFile);
const SRC = path.resolve("content/images");
const OUT = path.resolve(".wrangler/tmp/media-variants");
const remote = process.argv.includes("--remote");
const envName = process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : undefined;
const BUCKET = envName ? envBucket(envName) : "nk-media";

/** The MEDIA bucket of a wrangler env (`--env staging` → nk-media-staging). Comment lines are stripped first. */
function envBucket(name: string): string {
  const cfg = JSON.parse(readFileSync(path.resolve("wrangler.jsonc"), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"));
  const bucket = cfg.env?.[name]?.r2_buckets?.find((b: { binding: string }) => b.binding === "MEDIA")?.bucket_name;
  if (!bucket) throw new Error(`wrangler.jsonc has no MEDIA bucket for env "${name}"`);
  return bucket;
}

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
    await run("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/${v.key}`, "--file", path.join(OUT, v.key), "--content-type", "image/webp", remote ? "--remote" : "--local"]);
    if ((i + 1) % 50 === 0) console.log(`${i + 1} of ${variants.length} uploaded`);
  }
  console.log(`done: ${variants.length} variants of ${files.length} images`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
