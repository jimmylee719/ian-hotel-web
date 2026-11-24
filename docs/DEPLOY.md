# Deploying NK Hostel

## Environments (read this first)

| | default env (`nk-booking`) | `env.production` (`nk-booking-production`) |
|---|---|---|
| Used for | `wrangler dev`, `npm run preview`, a private staging Worker | the public site |
| `ENVIRONMENT` | `local` | `production` |
| `PAYMENT_MODE` | `mock` | **unset** |
| `CHANNEL_MODE` | `mock` | **unset** |
| `workers_dev` | `false` | `false` (use a custom domain) |
| D1 `database_id` | `local` (local only) | `REPLACE_WITH_PRODUCTION_D1_ID` in `wrangler.jsonc` |

- **Never deploy `PAYMENT_MODE=mock` to a public host.** `/dev/pay` would let anyone mark a booking as
  paid. `npm run deploy` always targets `--env production`, so it never ships the mock vars.
- Wrangler does not inherit bindings, vars or triggers into an env, which is why `env.production`
  repeats them. `wrangler dev --env production` warns that top-level vars are not inherited; that is intended.
- Online booking is on only when **both** `PAYMENT_MODE` and `CHANNEL_MODE` are set, and a `mock` value is
  accepted only when `ENVIRONMENT=local`. Anything else (`PAYMENT_MODE_NOT_SET`, `CHANNEL_MODE_NOT_SET`,
  `MOCK_MODE_IN_PRODUCTION`) makes `getDeps` throw and the routes answer 503. `/dev/pay` also 404s whenever
  `ENVIRONMENT=production`. The default env has `workers_dev: false` and `ENVIRONMENT=local`, so a stray bare
  `wrangler deploy` neither gets a public workers.dev URL nor can take bookings.
- The cron never fails as a whole on config: if payments or the channel are missing or broken it logs a
  warning and skips only the sync retry; hold expiry, pre-arrival emails and pruning still run.
- While booking is off, production fails closed: `/api/bookings`, `/api/payments/notify` and
  cancel answer `503 BOOKING_DISABLED`, and `/book` and `/book/details` show an "online booking is coming
  soon, please contact us" notice in all four languages. Content pages, `/api/inquiry` (group inquiry
  email) and the cron worker keep running. To open booking, Plan 5 sets `PAYMENT_MODE=sinopac` in
  `env.production.vars` with its secrets.
- Locally, `.dev.vars` is read for the default env and also for `--env production` unless a
  `.dev.vars.production` exists. To test production's fail-closed behaviour locally, create an empty
  `.dev.vars.production` first (and delete it after).

## First-time setup

Use `--env production` on every `wrangler` command that touches production. Nothing below has been run
by the build; each step is yours to run.

1. **D1.** `npx wrangler d1 create nk-booking`, then put the returned `database_id` in
   `env.production.d1_databases` in `wrangler.jsonc` (replacing `REPLACE_WITH_PRODUCTION_D1_ID`).
2. **R2.** `npx wrangler r2 bucket create nk-media`.
3. **Secrets** (`npx wrangler secret put <NAME> --env production`):
   `RESEND_API_KEY`, `STAFF_EMAILS` (comma-separated), and optionally `EMAIL_FROM`.
   **`BASE_URL`** (for example `https://www.nkhostel.com`) is also required: the cron worker has no
   request to take the site's address from, and the pre-arrival email's "manage booking" link uses it.
   Without it, production keeps booking off (`BASE_URL_NOT_SET`) and the cron skips every email job
   with a `console.error`, rather than sending links to localhost.
   Set it as a var in `env.production.vars` or as a secret. `.dev.vars.example` lists the local equivalents.
   Do **not** set `PAYMENT_MODE` or `CHANNEL_MODE` yet.
4. **Migrations.** `npx wrangler d1 migrations apply nk-booking --remote --env production`.
   - Verified: all 9 migrations apply on a fresh local D1 (`wrangler d1 migrations apply nk-booking --local --persist-to <empty dir>`)
     and on better-sqlite3 with `foreign_keys` both ON and OFF. That includes 0004, which adds
     `property_id text DEFAULT '' NOT NULL REFERENCES properties(id)`; some SQLite builds refuse to add a
     REFERENCES column with a non-NULL default when foreign keys are enforced.
   - **`--remote` was not run, so test it on a staging D1 first**: create a throwaway database
     (`wrangler d1 create nk-booking-staging`), apply with `--remote` against it, and only then apply to
     production. If 0004 is rejected there, make `notifications.property_id` nullable or rebuild the
     table in that migration (it is safe to edit before it has been applied anywhere).
5. **Content.** The site content (property, rooms, pages, FAQs, news) comes from `seedNk` and
   `seedContent` (`lib/db/seed-nk.ts`, `lib/db/seed-content.ts`). There is no production import script
   yet. Do **not** run `scripts/seed-local.ts` against production: it is local-only, wipes tables
   (bookings included) and adds fake availability and a placeholder promo code. Produce the INSERTs the
   way that script does but without those parts, load them with
   `wrangler d1 execute nk-booking --remote --env production --file <sql>` (staging D1 first), and set
   real availability and promo codes through the admin (Plan 3).
6. **Photos.** `npm run media:variants -- --remote` (see the checklist).
7. **Deploy.** `npm run deploy` (fetches fonts, builds with OpenNext, deploys `--env production`). The
   cron trigger (`*/5 * * * *`) is part of the same deploy.
8. **Domain.** Add the custom domain to the Worker (Workers & Routes, Custom Domains), or a route in
   `env.production` if the zone is on Cloudflare.

## Scheduled worker

`worker.ts` is the Worker entry point: `fetch` goes to OpenNext, `scheduled` runs `lib/jobs/cron.ts`
every 5 minutes: `runExpireHolds`, `runSyncRetry`, `runPreArrival`, then prunes `rate_limits` rows
older than a day. Each job runs on its own, so one failing does not stop the others. It logs one line,
`scheduled: expired=… attempted=… preArrival=… pruned=…`.

- Pre-arrival: confirmed bookings checking in on Taipei today + 3 get one email (directions, check-in
  time, contact details) in the guest's language. `sendOnce` makes it at most once per booking; a send the
  provider refused is recorded and not retried.
- Try it locally: `npx opennextjs-cloudflare build`, apply migrations to a local D1 with
  `--persist-to <dir>`, `npx wrangler dev --test-scheduled --persist-to <dir>`, then
  `curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`.

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
- [ ] Run `npm run media:variants -- --remote` against the production bucket after every photo change
  and before the first deploy (see the first item), and again after `npm run deploy` if photos changed.
- [ ] `npm run deploy` runs `scripts/fetch-fonts.ts` itself before the build (as does `npm run preview`),
  so the machine running it needs internet access.
- [ ] `BASE_URL` is set for `env.production` (cron emails link to it).
- [ ] Confirm production has no `PAYMENT_MODE`/`CHANNEL_MODE`, and `ENVIRONMENT=production` (`npx wrangler secret list --env production` and
  `vars` in `wrangler.jsonc`) until SinoPac is configured; `/dev/pay/x` must answer 404 and
  `POST /api/bookings` must answer 503.
- [ ] Resend: verify the sending domain (SPF, DKIM) for `EMAIL_FROM`, then send a test inquiry.
- [ ] Cloudflare Access in front of the staff and admin paths (Plan 3).
- [ ] Switch to the real modes once their plans land: `PAYMENT_MODE=sinopac` with SinoPac credentials
  (Plan 5) and `CHANNEL_MODE=siteminder` (Plan 4). Both throw `*_NOT_CONFIGURED` until then.
