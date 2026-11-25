# Plan 4 — executor rulings and deferred minors (Tasks 1, 2, 6, 8)

Tasks 3, 4, 5, 7, 9 not yet executed (blocked on SiteMinder/SinoPac docs and Cloudflare authorisation).

## Rulings
- Ruling: T1/T2 may modify confirm.ts, sync-retry.ts and their callers even though not in Files — the Interfaces text mandates the behaviour — cost if wrong: none.
- Ruling: T6 adds crons to top-level and env.production only; staging gets them in T7 — env.staging doesn't exist yet — cost: T7 must copy them (noted for T7).
- Ruling: T6 may implement the 15-min / daily cadence either as new wrangler cron expressions dispatched by event.cron in worker.ts, or as gating inside the existing */5 tick; implementer picks the one consistent with worker.ts — cost: small.
- Ruling: T8 item 7 script defaults to staging but staging doesn't exist yet; script must only print/dry-run without remote access in tests — cost: none.
- Ruling (T1-I2): queue the post-refund channel check only when a push could have reached the channel (syncAttempts>0 or a sync lease was taken); never-pushed refunds (AMOUNT_MISMATCH/SOLD_OUT before push) keep syncState failed — keeps ops signal — cost if wrong: a never-pushed booking that somehow landed is caught by T6 daily reconcile.
- Ruling (T8 item 7): import script requires --apply (+ --yes for production); stricter than brief, fail-safe — runbook (T9) must use `--env production --apply --yes`.
- Ruling (final I1): in the reconcile job, not_found leaves the refund pending (Task 6 text + Review Focus 4 govern over Task 2's refundOnce wording for unattended jobs); definite `failed` → markRefundFailed + staff alert — cost if wrong: a truly-never-made refund waits for manual reconcile instead of auto-retry.
- Ruling (final I4): fix now — SYNC_LEASE_MS raised to 3 min (≥2×60s+margin) and doc comment corrected — cost: post-refund channel check / retries 1 min later.
- Ruling (final I5): add queryTransaction conformance rules now rather than in Task 5 — cheap, and Task 6 money path depends on it.
- Ruling (final minors): include reconcile-job wall-clock deadline + stop after consecutive errors, and settle_offline querying failed rows too, in the single fix wave; other minors stay deferred per reviewer triage.
- Ruling (R1): real and load-bearing (money) — NOT parked; surfaced to user with the smallest fix: sweep skips fail: bookings with any sibling fail:<id>:% row failed or pending. Branch must not merge before it.

## Deferred minors
- Task 1: minor (deferred): lookup+push = 2×timeoutMs can reach SYNC_LEASE_MS; doc "push never outlives lease" now false
- Task 1: minor (deferred): lastSyncError overwritten by LOOKUP_FAILED on refunded booking check
- Task 1: minor (deferred): syncAttempts reset on refund loses attempt count
- Task 1: minor (deferred → Task 3): rule 4 checks declared timeoutMs only, no slow-endpoint test
- Task 1: minor (deferred): rule 2 cancel check weak (no idempotent second cancel)
- Task 1: minor (deferred): pre-push reason prefixes duplicated as strings in mayHaveReachedChannel (fails safe)
- Task 1: minor (deferred): modify.ts NO_SM_CONFIRMATION branch untested
- Task 2: minor (deferred): sync throw from gateway.refund escapes refundOnce (.catch only)
- Task 2: minor (deferred): startCharge gate race branches untested
- Task 2: minor (deferred → Task 5): conformance rules 2/4 can't detect double refund; adapter test must
- Task 2: minor (deferred): query-settled refund may have null providerRef (no note)
- Task 2: minor (deferred → Task 5): not_found-after-timeout = failed relies on gateway key dedupe; SinoPac must return pending when unsure
- Task 2: minor (deferred): defaultTamper replaces first substring match
- Task 6: minor (deferred): channel re-push takes no lease → cancel during push can leave phantom active booking up to 24h
- Task 6: minor (deferred): 50/run limits oldest-first can starve newer rows
- Task 6: minor (deferred): finishFlow throwing after settleRefundRow leaves flow unfinished, no alert
- Task 6: minor (deferred): chargesApplied counts duplicate/mismatch verdicts
- Task 6: minor (deferred): layering jobs↔admin (finishFlow in lib/admin)
- Task 6: minor (deferred): stale channel_mismatch if later runs fail; system-status last job shows any job
- Task 6: minor (deferred): test gaps (fail: refund via job, multi-attempt race)
- Task 6: minor (deferred): candidate DB reads uncapped (24h window bounds it)
- Task 6: minor (deferred → Task 5): failed-notice row with merchantOrderNo stops further queries of that attempt; confirm SinoPac semantics
- Task 6: minor (deferred): backoff `floor(age/15m)%4` coupled to 15-min cron by comment only; cron period change silently starves >1h attempts
- Task 6: minor (deferred): no test of >50 attempts older than 1h
- Task 8: minor (deferred): offline-mode fail: flow blocked by other charge has no re-trigger after settle
- Task 8: minor (deferred): pending-row dialog says "will query gateway" even when PAYMENT_MODE unset
- Task 8: minor (deferred): frontDesk read-back after transition not atomic (emails only)
- Task 8: minor (deferred): dry run lists slugs/counts; full SQL in .wrangler/import-content-<env>.sql
- Final re-review minors (deferred): sweep starvation (limit before per-booking dedupe); CHANNEL_MISSING never auto-clears when later lookup matches; flowsFinished overcounts; lookup-error email reuses staff_sync_failed; budget counts local errors.
- R1 re-review: ADDRESSED (+ minor 2, minor 4). Residual minors (deferred): sweep grace per row not per booking; alert ref min(id) can change → duplicate email; "unfinished" results not counted by error budget; staff retry/mark_succeeded on one fail: sibling still reopens other failed siblings (human action, intentional).

## Carried into later tasks
- Task 3: real adapter must enforce smConfirmation on modify/cancel; supply timingOut fixture; slow-endpoint timeout test; idempotent second cancel; confirm SiteMinder behaviour when re-pushing a code it holds as cancelled.
- Task 5: adapter must fill PaymentNotice.merchantOrderNo; queryTransaction providerRef must equal the notice's; return pending (not not_found) while unsure; provider-side single-refund check; paidAttempt fixture; confirm a failed attempt can never later succeed.
- Task 7: copy crons */5, */15, 0 20 * * * into env.staging.
- Task 9: runbook uses `npm run content:import-remote -- --env production --apply --yes`.

## Task 7 (code part) — rulings and deferred minors
- Ruling: only Steps 1–4 and 7 done; Steps 5–6 (create Cloudflare resources, secrets, remote migrations incl. 0022, deploy) are ★ and wait for owner authorisation.
- Ruling: vendor host allow-lists in lib/runtime/config-guard.ts start empty; production refuses any vendor endpoint not on the production list, staging requires a sandbox-list host (stricter, fail-closed). Tasks 3/5 must fill both lists.
- Request guard lives in worker.ts (withConfigGuard) because middleware skips /api, /admin, /media. Unset/unknown ENVIRONMENT is treated as production; a mock mode outside local 503s the whole site and skips crons.
- Ops alert dedupe uses a new ops_alerts table (migration 0022) since notifications requires a reservation.
- Deferred minors: hour-boundary dedupe race; redact over-masks some UUIDs / 13-digit epochs / idempotencyKey & R2 key values; URL-encoded card numbers unmasked; endpoint var pattern `(ENDPOINT|URL)` would catch our own SINOPAC_RETURN_URL etc. — narrow before Tasks 3/5 add such vars; CONFIG_REFUSED runs count toward the cron_failed streak; ops_alerts not pruned; DEPLOY.md note on local --env production + mock; Error own props (e.g. driver code) not kept.
