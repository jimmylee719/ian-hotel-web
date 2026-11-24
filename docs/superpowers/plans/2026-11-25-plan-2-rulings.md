# Plan 2 — executor rulings and deferred minors

Decisions made during execution on the owner's behalf, and review findings deliberately deferred. Keep this list in view for Plans 3–4 and launch.

## Rulings
- Ruling: execution order T1(proposals only, publish, don't block) → T2..T6 → [owner pick needed] → T1 Step3-4 → T7..T10 — backend tasks don't depend on visual direction; maximises progress while owner decides — cost if wrong: none.
- Ruling: T3 mock pay page lives at app/dev/pay/[ref]/page.tsx (no [locale]) with ?locale= param — avoids depending on T7 layout — cost: page is unlocalised chrome, dev-only anyway.
- Task 1 (Step 1 only): proposals committed b972b79. Ruling: no code review for static mockups — owner's choice is the gate — cost: none. Ruling: implementer swapped brief's image URLs (notice image/icons) for real room photos from old site — brief URLs were wrong — none. Concern parked for owner: source photos ≤1100px → recommend reshoot/originals.
- Task 2: Ruling: hand-edited migration 0003 guest_email_lower DEFAULT '' (SQLite can't add NOT NULL col w/o default); schema has no default so TS forces a value — no prod DB yet — cost: none. Ruling: idempotencyKey nullable+unique (T4 always sets it) — none.
- Task 2: review → spec ✅, quality needs fixes. Ruling: reviewer Important (paymentEvents lacks propertyId) vs brief column list — global constraint wins: add nullable propertyId to paymentEvents, NOT NULL to notifications — cost: one migration.
- Task 3: Ruling: staff-facing emails zh-TW only — staff are Taiwanese — cost: trivial to add later.
- Ruling: children count toward room occupancy (adults+children ≤ maxOccupancy per room) — hotel norm, rooms are sized by heads — implement in Task 9 (search API + createReservation pass children) — cost if wrong: families over-filtered; easy to relax.
- Ruling: implementer concern #2 (inventory leak on crash between transition and release) accepted for now — next SiteMinder ARI sync overwrites local inventory — cost: rooms unsellable until next sync (minutes).
- Ruling: release inventory before channel cancel (brief order reversed) accepted — no functional difference — none.
- Ruling: staff get guest "cancelled" email rendered in zh-TW — no staff template yet — cost: cosmetic.
- Task 6: Ruling: pending refund rows block further refunds until staff reconcile — Plan 3 admin must ship a reconcile action for pending refunds — cost: stuck refunds need manual DB fix until Plan 3.
- Ruling: refundAndFail key is fail:<resId>:<chargeId> (loops per charge) — justified — none.
- Ruling: --color-muted fails AA for body text (4.12:1) — use a darker muted token for informational text — none.
- Ruling: Task 7 uploads images to LOCAL R2 only (`wrangler r2 object put --local`); remote upload is a deploy step in docs/DEPLOY.md — avoids touching cloud resources without the user — cost: none.
- Ruling: old FAQ cancellation rule (first-night based) vs seeded direct-flex (100/50/0 of paid) — policy is data (ratePlans.cancelPolicy), seed stays as placeholder; OWNER must confirm real policy before launch — surfaced to user at end — cost: wrong refunds if launched unconfirmed.
- Ruling: privacy/terms pages are drafts → owner/legal review before launch.
- Ruling: room photos via roomImages(slug) from content/old-site.json for now; DB images column deferred to Plan 3 admin (photo management) — cost: photo changes need redeploy until Plan 3.
- Ruling: occupancy data (seed maxOccupancy vs descriptions with extra beds) is OWNER data — surface to user; keep seed — cost: Deluxe w/ extra bed not bookable for 3-4 until corrected.
- Ruling: awards on reviews page read from old certificate images → owner to confirm before launch.
- Ruling: ja/ko room names still English (seedNk) — fix in Task 9 dispatch via seedContent translations (guest-facing text must be 4 languages) — cost: small.
- Ruling: getDeps throws PAYMENT_MODE_NOT_SET when unset (fail closed vs accepting notices signed with public default secret) — Task 10 adds PAYMENT_MODE to wrangler vars — none.
- Task 9: review → spec ✅, quality needs fixes. Important: (1) return-page polling exhausts status rate limit [plan-level conflict]; (2) stale "payment failed" after retry. Ruling: upgraded Minor "back from pay page → new idempotency key → second hold" to Important (Review Focus #3). Fix round 1: split limits (success per IP+code 60/min, failures per IP 10/min, quote 30/min), lastChargeStartedAt + paymentState, sessionStorage-stable key.
- Ruling: plan said status 10/IP/min — superseded by split limits (enumeration guard kept on failures) — cost: none.
- Final for this finding: Ruling: return-page "retry payment" intentionally replays the SAME booking (same key) — it is a payment retry, not a new booking; if the booking already expired it shows "retryGone" which sends the guest back to search — a fresh key there would silently create a second booking — cost: guest re-searches after expiry (rare).
- Task 10: Ruling: upgraded Minors (a) cron deps built outside isolation, (b) workers_dev mock deploy risk → required in fix round 1 (safety of production payments).

## Deferred minors
- Task 2: minor (deferred): guest_email_lower DEFAULT '' only in hand-edited migration (snapshot drift)
- Task 2: minor (deferred): no test covers paymentEvents verdict enum values
- Task 2: minor (deferred): migration 0004 `ADD ... DEFAULT '' NOT NULL REFERENCES` rejected by some SQLite builds with FKs on; local D1 + better-sqlite3 accept — FINAL REVIEW: verify against remote D1 before deploy (Task 10)
- Task 3: minor (deferred): mock pay page fetch/redirect use unvalidated notifyUrl/returnUrl (dev-only, 404 unless PAYMENT_MODE=mock); hard-coded "mock-secret" fallback
- Task 3: minor (deferred): mock pay page ignores notify response; reservationCodeFromRef unused; ResendEmailSender untested
- Task 4: minor (deferred): releaseInventory in catch could mask original error (moot after atomic batch)
- Task 4: minor (deferred): replay of pending_payment with holdExpiresAt past re-issues charge
- Task 4: minor (deferred): promo codes case-sensitive — normalise to upper case at create+lookup
- Task 4: minor (deferred): reservation code collision → 500 instead of retry (~1e-9)
- Task 4: minor (deferred): "concurrent" transition test is sequential on better-sqlite3 (name overstates)
- Task 4: minor (deferred): replayOr NOT_AVAILABLE branch untested
- Task 5: minor (deferred): crash after recordCharge on an already-expired booking recovers only via provider resend (runExpireHolds scans pending_payment only)
- Task 5: minor (deferred): two concurrent distinct charges on pending_payment → refundAndFail refunds both + refundStray over-refund attempt (gateway rejection is backstop) — partly mitigated in round 2 (skip when remaining ≤ 0)
- Task 5: minor (deferred): sendOnce writes "sent" before send; failed rows never retried
- Task 5: minor (deferred): stray charge whose refund failed/crashed is not retried by provider resend once booking is past pending/expired (staff alerted via STRAY_REFUND_FAILED) — Plan 3 admin should surface it
- Task 6: minor (deferred): post-lease takeover race can end cancelled with cancelledAt=null + spurious staff alert (no double refund)
- Task 7: minor (deferred): /media 500 on malformed percent-encoding, no key-guard tests
- Task 7: minor (deferred): LocaleSwitcher drops query string (matters for /book links — Task 9 should preserve it)
- Task 7: minor (deferred): SITE_URL fallback is old domain; locale list hardcoded twice; footer contact duplicated
- Task 7: minor (deferred): seedContent re-run overwrites owner-edited content (Plan 3 CMS must stop using it)
- Task 8: minor (deferred): /api/inquiry lacks rate limit → Task 9 must apply checkRate to inquiry too (carry)
- Task 8: minor (deferred): partial staff send failure can duplicate first email; #hotel @id only defined on home; FAQ JSON-LD has markdown markers; BookingDock inert until hydration; inquiry form focus; all DB pages force-dynamic
- Task 8: minor (deferred): fetch-fonts retries permanent 404s; drops stacks; DEPLOY.md wording reversed (99 vs 64-66)
- Task 9: minor (deferred): search-results prices computed outside quote(); mock pay page posts to form notifyUrl; notify body size cap; rate_limits never pruned; NOT_CANCELLABLE refetch-failure shows nothing; "only N left" comment mismatch; appEnv falls back to process.env on any error; promo case collision ambiguity
- Task 9: minor (deferred): ReturnStatus back-to-back fetches in final 500ms; 10 failed lookups lock out successful ones for the window (intended)
- Task 9: minor (deferred): BookingForm hidden-field key state can lag sent key (no functional break)
- Task 10: minor (deferred): failed pre-arrival sends never retried; T-3 exact-day only (late confirmations miss it); worker.ts `env as never`; cloudflare-env.d.ts generated with local .dev.vars
- Task 10: minor (deferred): /dev/pay renders with ENVIRONMENT unset + PAYMENT_MODE=mock (cannot mark paid — notify refuses)
- Final: minor (deferred): local refund/cancel vs SiteMinder divergence (timed-out-but-succeeded push, push after cancel) → Plan 4 idempotent push + queued channel cancel
- Final: minor (deferred): duplicate detection ignores notice status — real SinoPac adapter must use unique ref per attempt (Plan 4)
- Final: minor (deferred): amount-mismatch refund sends guest no email
- Final: minor (deferred): failed email sends never retried → Plan 3 admin resend
- Final: minor (deferred): in-flight cancel claim made on check-in day with pending refund can be taken over on a later night (narrow: pending refund + expired lease)
- Final: minor (deferred): return-page retry on a paid booking shows "retry gone" (status still correct); EXPIRED/ALREADY_PAID keep 400; t()-key scan is heuristic
