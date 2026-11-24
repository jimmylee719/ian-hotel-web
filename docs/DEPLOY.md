# Deploying NK Hostel

## Launch checklist

- [ ] Upload the photo variants to the production R2 bucket `nk-media`:
  `npm run media:variants -- --remote`
  The site requests `/media/_w480|_w800|_w1100/<key>.webp` for every photo by default (`lib/media.ts`).
  A missing variant still shows the photo, because `/media` falls back to the original JPEG. But
  originals are up to 380 KB, so mobile LCP rises from under 2 s to about 8 s (Lighthouse
  performance 64 to 66 instead of 99). Run this again whenever new photos are added to
  `content/images`.
  Alternative: if the zone has Cloudflare Images transformations enabled, build with
  `NEXT_PUBLIC_CF_IMAGES=1` to resize through `/cdn-cgi/image/` instead; then the variants are unused.
- [ ] The build downloads the CJK fonts from Google Fonts (`npm run build` runs
  `scripts/fetch-fonts.ts` as `prebuild`, into the gitignored `public/fonts/`), so the build machine
  needs internet access. It retries with backoff and then fails the build with a clear message.
- [ ] Set the group inquiry secrets on the Worker (`wrangler secret put`): `RESEND_API_KEY`,
  `EMAIL_FROM`, `STAFF_EMAILS` (comma-separated). Without `RESEND_API_KEY`, inquiries are only logged.
