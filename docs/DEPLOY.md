# Deploying NK Hostel

## Environments (read this first)

| | default env (`nk-booking`) | `env.staging` (`nk-booking-staging`) | `env.production` (`nk-booking-production`) |
|---|---|---|---|
| Used for | `wrangler dev`, `npm run preview` | vendor sandboxes, migration rehearsals ([Staging](#staging)) | the public site |
| `ENVIRONMENT` | `local` | `staging` | `production` |
| `PAYMENT_MODE` | `mock` | **unset** (until the SinoPac adapter, Task 5) | **unset** |
| `CHANNEL_MODE` | `mock` | **unset** (until the SiteMinder adapter, Task 3) | **unset** |
| `workers_dev` | `false` | `false` | `false` (use a custom domain) |
| D1 | `nk-booking`, `database_id` `local` (local only) | `nk-booking-staging`, `REPLACE_WITH_STAGING_D1_ID` | `nk-booking`, `REPLACE_WITH_PRODUCTION_D1_ID` |
| R2 `MEDIA` | `nk-media` (local) | `nk-media-staging` | `nk-media` |

- **Never deploy `PAYMENT_MODE=mock` to a public host.** `/dev/pay` would let anyone mark a booking as
  paid. `npm run deploy` always targets `--env production`, so it never ships the mock vars.
- Wrangler does not inherit bindings, vars or triggers into an env, which is why `env.production`
  repeats them. `wrangler dev --env production` warns that top-level vars are not inherited; that is intended.
- Online booking is on only when **both** `PAYMENT_MODE` and `CHANNEL_MODE` are set, and a `mock` value is
  accepted only when `ENVIRONMENT=local` (so never on staging either; staging also needs `BASE_URL`, like production). Anything else (`PAYMENT_MODE_NOT_SET`, `CHANNEL_MODE_NOT_SET`,
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

## Config guard (fails closed)

Every entry point checks the whole config first (`assertConfig` / `configRefusal` in `lib/runtime/config-guard.ts`):
`worker.ts` wraps `fetch` with `withConfigGuard`, and `runCron` / `runCronTrigger` (`lib/jobs/cron.ts`) check it
before every cron run. The rules, by `ENVIRONMENT`:

| `ENVIRONMENT` | refused |
|---|---|
| `local` | nothing |
| `staging` | `PAYMENT_MODE` or `CHANNEL_MODE` = `mock`; a vendor endpoint that is not `https`, or whose host is on that vendor's **production** list or not on its **sandbox** list |
| `production`, or unset / anything else (treated as production) | `PAYMENT_MODE` or `CHANNEL_MODE` = `mock`; a vendor endpoint that is not `https` or whose host is not on that vendor's **production** list |

- Vendor endpoints are every var or secret named `SITEMINDER_…ENDPOINT` / `SINOPAC_…ENDPOINT` (or `…_URL`), e.g.
  `SITEMINDER_ENDPOINT`, `SINOPAC_ENDPOINT`. Unset ones are not checked. The host lists are `SITEMINDER_HOSTS` and
  `SINOPAC_HOSTS` in `lib/runtime/config-guard.ts` (exact hostnames). **They are empty until the vendor docs arrive**
  (Tasks 3 and 5 fill them), so until then any configured vendor endpoint is refused outside local.
- When refused, every request that reaches the Worker answers **503** (`Retry-After: 300`; the body names no setting)
  and the reason is logged (`request refused: CONFIG_REFUSED: …`). Static assets served by the assets layer are not
  affected. Each cron run is skipped and recorded in `job_runs` as `{ skipped: "CONFIG_REFUSED", error: "…" }`
  (shown on `/admin/system` — which itself answers 503 while refused, so read it from the logs or D1), and ops are
  emailed (`config_refused`, at most once an hour).
- This is stricter than the booking switch: a production or staging Worker with a mock mode no longer just turns
  booking off, it stops serving altogether. Today neither env sets a mode or an endpoint, so both pass.

## Ops alerts and log redaction

- **`OPS_EMAILS`** (comma-separated, a var or secret per env) receives ops alerts (`lib/ops/alerts.ts`,
  `notifyOps`). Unset = alerts are only logged (`console.warn`). Each alert kind (per job, where it has one) is
  emailed at most **once an hour**, deduplicated in the `ops_alerts` table (migration 0022; `notifications` cannot
  hold them, its rows belong to a reservation). The email goes through the same Resend sender as the other emails.
  Alerts:
  - `cron_failed:<job>` — a cron job (`cron`, `gateway_reconcile`, `channel_reconcile`) failed 3 runs in a row
    (its latest 3 `job_runs` rows are all errors);
  - `config_refused` — the config guard skipped a cron run;
  - `reconcile_mismatch:<job>` — a reconcile run found what it also tells staff about (channel mismatches,
    CHANNEL_MISSING re-push / cancel failures, channel lookup errors; refunds marked failed, flows that would not
    finish). Staff still get their per-booking emails; ops get one summary per job per hour;
  - `ari_unknown_code` — reserved for the SiteMinder ARI inbound endpoint (Task 4), which calls `notifyOps` itself.
- **Redaction.** Everything under `lib/` and `worker.ts` logs through `lib/runtime/log.ts`, which passes every argument
  through `redact` (`lib/runtime/redact.ts`): card-like numbers (13–19 digits, spaces or hyphens allowed), the values
  of `Authorization` / `Cookie`, and the values of fields named `password`, `secret`, `key`, `token`, `hashKey`,
  `hashIV` (and names ending in them) in `key=value`, JSON and header forms. Alert details and the error text stored in
  `job_runs` are redacted too. New adapter code must log through `log`, never `console` directly.

## Staging

`env.staging` in `wrangler.jsonc` is a full copy of production on its own resources: Worker `nk-booking-staging`,
D1 `nk-booking-staging`, R2 bucket `nk-media-staging`, the `IMAGES` binding, the same three crons (`*/5`, `*/15`,
`0 20`), `workers_dev: false`, `ENVIRONMENT=staging`, empty `CF_ACCESS_*`. It sets no `PAYMENT_MODE` /
`CHANNEL_MODE`, so booking is off there until the sandbox adapters exist (mock modes are refused outside local). It
may only talk to the **SiteMinder sandbox and the SinoPac test environment** (config guard above). Its secrets mirror
production's, with staging / sandbox values only — never production credentials.

What exists in the repo: the config above, `npm run deploy:staging` (the same as `npm run deploy`: tests, type check,
fonts, OpenNext build, deploy, all with `--env staging`), and `npm run media:variants -- --remote --env staging`
(uploads the photo variants to `nk-media-staging`). Nothing has been created in Cloudflare and nothing has been run
against a remote.

★ What the owner does (in this order; each needs its own go-ahead):

1. **Create the resources**: `npx wrangler d1 create nk-booking-staging` (put the id in `env.staging.d1_databases`,
   replacing `REPLACE_WITH_STAGING_D1_ID`), `npx wrangler r2 bucket create nk-media-staging`, Cloudflare Images on the
   account (shared with production), and a **separate** Access application for the staging hostname (same policies as
   [Cloudflare Access 設定](#cloudflare-access-設定); fill `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` in
   `env.staging.vars`).
2. **Secrets** (`npx wrangler secret put <NAME> --env staging`): `BASE_URL` (the staging hostname; required, as in
   production), `RESEND_API_KEY`, `EMAIL_FROM`, `STAFF_EMAILS`, `OPS_EMAILS`, and later the vendors' **sandbox**
   endpoints and credentials. Never `DEV_STAFF_EMAIL`, never `PAYMENT_MODE=mock`.
3. **Migrations**: `npx wrangler d1 migrations apply nk-booking-staging --env staging --remote`. Then rehearse the
   Plan 3 case-collision rollbacks of 0015 and 0017 on staging data.
4. **Deploy**: `npm run deploy:staging`, `npm run media:variants -- --remote --env staging`, content import and the
   first owner (the SQL in [建立第一位 owner](#建立第一位-owner) with `nk-booking-staging --env staging`).
5. **Check**: `/admin/system` shows `ENVIRONMENT` staging, and a cron run within 5 minutes; a request answers 200
   (not the config guard's 503).

## First-time setup

Use `--env production` on every `wrangler` command that touches production. Nothing below has been run
by the build; each step is yours to run.

1. **D1.** `npx wrangler d1 create nk-booking`, then put the returned `database_id` in
   `env.production.d1_databases` in `wrangler.jsonc` (replacing `REPLACE_WITH_PRODUCTION_D1_ID`).
2. **R2.** `npx wrangler r2 bucket create nk-media`.
3. **Secrets** (`npx wrangler secret put <NAME> --env production`):
   `RESEND_API_KEY`, `STAFF_EMAILS` (comma-separated), `OPS_EMAILS` (comma-separated, ops alerts), and optionally
   `EMAIL_FROM`.
   **`BASE_URL`** (for example `https://www.nkhostel.com`) is also required: the cron worker has no
   request to take the site's address from, and the pre-arrival email's "manage booking" link uses it.
   Without it, production keeps booking off (`BASE_URL_NOT_SET`) and the cron skips every email job
   with a `console.error`, rather than sending links to localhost.
   Set it as a var in `env.production.vars` or as a secret. `.dev.vars.example` lists the local equivalents.
   Do **not** set `PAYMENT_MODE` or `CHANNEL_MODE` yet.
4. **Migrations.** `npx wrangler d1 migrations apply nk-booking --remote --env production`.
   - Verified: all 18 migrations (through 0017) apply on a fresh local D1 (`wrangler d1 migrations apply nk-booking --local --persist-to <empty dir>`)
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
6. **Photos.** Upload the originals and their variants to the production bucket **before** anyone edits
   rooms in the admin (see "Photos before admin room edits" in the checklist).
7. **Cloudflare Access** for `/admin*` and `/api/admin*`: see [Cloudflare Access 設定](#cloudflare-access-設定).
8. **First owner**: see [建立第一位 owner](#建立第一位-owner). Every later account is added in `/admin/staff`.
9. **Deploy.** `npm run deploy` (runs `vitest run` and `tsc --noEmit`, so a failing test or an unknown
   translation key stops it; then fetches fonts, builds with OpenNext, deploys `--env production`). The
   cron trigger (`*/5 * * * *`) is part of the same deploy.
10. **Domain.** Add the custom domain to the Worker (Workers & Routes, Custom Domains), or a route in
   `env.production` if the zone is on Cloudflare.

## Scheduled worker

`worker.ts` is the Worker entry point: `fetch` goes to OpenNext, `scheduled` runs `lib/jobs/cron.ts`
every 5 minutes: `runExpireHolds`, `runSyncRetry`, `runPreArrival`, then prunes `rate_limits` rows
older than a day. Each job runs on its own, so one failing does not stop the others. It logs one line,
`scheduled: expired=… attempted=… preArrival=… pruned=…`, and writes one `job_runs` row per run (name `cron`,
start and finish time, the counts or the error as JSON); rows older than 30 days are pruned by the same run.
`/admin/system` shows the latest one.

- Pre-arrival: confirmed bookings checking in on Taipei today + 3 get one email (directions, check-in
  time, contact details) in the guest's language. `sendOnce` makes it at most once per booking; a send the
  provider refused is recorded and not retried.
- Try it locally: `npx opennextjs-cloudflare build`, apply migrations to a local D1 with
  `--persist-to <dir>`, `npx wrangler dev --test-scheduled --persist-to <dir>`, then
  `curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`.

## Cloudflare Access 設定

The admin (`/admin…`) and its API (`/api/admin…`) trust only a Cloudflare Access JWT
(`Cf-Access-Jwt-Assertion`, verified against `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`). Access decides who
may sign in; the `staff` table decides what each person may do. While either variable is empty every admin
request answers 401 (fails closed). Do this before the first deploy that people will use; nothing here is done
by the build.

1. **Create the application.** Cloudflare dashboard → Zero Trust → Access → Applications → Add an application →
   **Self-hosted**. Name it e.g. `NK admin`. Add two public hostnames on the **production** hostname (repeat for
   every hostname that serves the production Worker, such as the apex and `www`):
   - `www.nkhostel.com` with path `/admin*`
   - `www.nkhostel.com` with path `/api/admin*`
   Session duration: 8 to 24 hours. Leave the identity providers you will use enabled (one-time PIN by email,
   and/or Google Workspace).
   **Cookie settings** (the application's Settings → Advanced settings → Cookie settings): set **SameSite
   Attribute** to **Lax** (or Strict) and turn **HTTP Only** on. With SameSite=None the `CF_Authorization` cookie
   travels on requests other sites make, and Access would add a valid JWT to a forged admin POST. The app also
   refuses any non-GET admin request whose `Origin` / `Sec-Fetch-Site` is not this site (403 `CSRF_REJECTED`) and
   any JSON body not sent as `application/json` (415), but the cookie setting is the first line of defence.
2. **Policy for owners and managers, with MFA.** Add an **Allow** policy, e.g. `owners-managers`:
   - Include → Emails: every owner's and manager's address.
   - Require → Authentication method → `mfa` (Google Workspace accounts need 2-Step Verification on;
     one-time PIN alone does not count as MFA).
   Keep this list in step with the roles in `/admin/staff`: when someone becomes owner or manager, add them here.
3. **Policy for the other staff.** Add a second **Allow** policy, e.g. `staff`:
   - Include → Emails (each front-desk / marketing address) **or** Emails ending in → your Google Workspace domain
     (e.g. `@nkhostel.com`).
   - Exclude → Emails: the same owner and manager addresses as policy 2. Without this exclusion an owner who fails
     the MFA requirement would still get in through this policy (Access allows a user who matches any Allow policy).
     Simpler alternative: require MFA in this policy too.
   Being allowed by Access is not enough to use the admin: the address must also be an active row in `staff`.
4. **Copy the two values into the Worker.** In the application's Overview copy the **Application Audience (AUD)
   Tag**; the team domain is under Zero Trust → Settings → Custom Pages (`<team>.cloudflareaccess.com`). Put them in
   `env.production.vars` in `wrangler.jsonc`:
   `"CF_ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com", "CF_ACCESS_AUD": "<aud tag>"`
   (or set them with `npx wrangler secret put CF_ACCESS_AUD --env production` and the same for
   `CF_ACCESS_TEAM_DOMAIN`, after removing the empty vars). Redeploy.
5. **Check.** In a private window open `https://www.nkhostel.com/admin`: Access must ask you to sign in first.
   `curl -i https://www.nkhostel.com/api/admin/staff -X POST` must be redirected to Access (or 401/403), never
   reach the app unauthenticated. After signing in, `/admin/system` must show Cloudflare Access「已設定」. In the
   browser's dev tools, the `CF_Authorization` cookie must show `SameSite=Lax` (or `Strict`) and `HttpOnly`.

**`DEV_STAFF_EMAIL` must never be set as a deployed secret** (production or any staging Worker). It is the local
sign-in shortcut: with `ENVIRONMENT=local` it makes every request that staff member without any Access check. It
is ignored when `ENVIRONMENT` is anything else, but the default env *is* `ENVIRONMENT=local`, so a staging deploy
of it with this secret would be an open admin. Check with `npx wrangler secret list --env production` (and without
`--env` for any staging Worker); `/admin/system` warns when it is set outside local.

## 建立第一位 owner

The first owner cannot be added through the admin (nobody can sign in yet). After the migrations and the content
import (the `properties` rows must exist), **the owner runs this themselves** against the production D1; the build
and `scripts/create-owner.ts` never touch a remote database. Replace the email and name (double any `'` inside the
name, e.g. `'O''Brien'`). The email is stored lowercase and must be the address the owner signs in to Access with.

```sh
npx wrangler d1 execute nk-booking --remote --env production --command "
INSERT INTO staff (id, email, name, role, property_ids, active)
SELECT lower(hex(randomblob(16))), lower(trim('owner@example.com')), '店主姓名', 'owner', json_group_array(id), 1
FROM properties HAVING count(*) > 0;"
```

Check it (one row, `role = owner`, `active = 1`, every property id in `property_ids`):

```sh
npx wrangler d1 execute nk-booking --remote --env production --command "SELECT id, email, role, property_ids, active FROM staff;"
```

If the INSERT reports `UNIQUE constraint failed`, that address is already a staff row: make it an owner with
`UPDATE staff SET role = 'owner', active = 1 WHERE email = lower('owner@example.com');`. If it inserts 0 rows, no
property exists yet: import the content first. Then sign in at `/admin`, add the second owner in `/admin/staff`
(the system never lets the last active owner be demoted or deactivated, so keep two), and add the rest of the staff
there. Every change in `/admin/staff` is in `/admin/audit` (owner-only rows).

Locally the same insert is `npx tsx scripts/create-owner.ts <email> <name>` (local D1 only; it refuses flags such
as `--remote`).

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
- [ ] `OPS_EMAILS` is set for `env.production` (and staging), so a failing cron or a reconcile mismatch reaches ops.
- [ ] `SITEMINDER_HOSTS` / `SINOPAC_HOSTS` (`lib/runtime/config-guard.ts`) hold the vendors' production and sandbox
  hosts from their docs before any `SITEMINDER_…ENDPOINT` / `SINOPAC_…ENDPOINT` is set; otherwise the Worker 503s.
- [ ] Confirm production has no `PAYMENT_MODE`/`CHANNEL_MODE`, and `ENVIRONMENT=production` (`npx wrangler secret list --env production` and
  `vars` in `wrangler.jsonc`) until SinoPac is configured; `/dev/pay/x` must answer 404 and
  `POST /api/bookings` must answer 503.
- [ ] Resend: verify the sending domain (SPF, DKIM) for `EMAIL_FROM`, then send a test inquiry.
- [ ] Cloudflare Access application for `/admin*` and `/api/admin*` on the production hostname, owner/manager
  policy requiring MFA, cookie **SameSite=Lax (or Strict) and HTTP Only**, `CF_ACCESS_TEAM_DOMAIN` and
  `CF_ACCESS_AUD` filled in ([Cloudflare Access 設定](#cloudflare-access-設定)).
- [ ] The `IMAGES` binding (`wrangler.jsonc`) needs **Cloudflare Images enabled on the account** (dashboard →
  Images). Without it the binding cannot transform, so admin uploads store only the original (each failed variant
  is logged, the upload still succeeds) and `/media` serves the full-size original in place of the WebP variants.
  After enabling it, upload one photo in `/admin/content` and check that `/media/_w480/<key>.webp` answers 200.
- [ ] First owner created by the owner with the `--remote` SQL template ([建立第一位 owner](#建立第一位-owner)),
  and a second owner added in `/admin/staff`.
- [ ] `DEV_STAFF_EMAIL` is **not** among the deployed secrets (`npx wrangler secret list --env production`).
- [ ] Photos before admin room edits: upload every original in `content/images` to the production bucket
  **before** staff edit rooms in `/admin/content`. Saving a room checks that each of its photo keys exists in R2
  and refuses the save (`IMAGE_NOT_FOUND`) otherwise, and the public room pages would show broken photos:
  ```sh
  (cd content/images && find . -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \) \
    | sed 's|^\./||' | while read -r k; do npx wrangler r2 object put "nk-media/$k" --file "$k" --remote; done)
  npm run media:variants -- --remote
  ```
  Photos uploaded later through the admin go straight to R2 (with their variants when the `IMAGES` binding works).
- [ ] After deploying, `/admin/system` shows: `ENVIRONMENT` production, Access 已設定, migrations
  applied = shipped, and a cron run within the last 5 minutes.
- [ ] Switch to the real modes once their plans land: `PAYMENT_MODE=sinopac` with SinoPac credentials
  (Plan 5) and `CHANNEL_MODE=siteminder` (Plan 4). Both throw `*_NOT_CONFIGURED` until then.
