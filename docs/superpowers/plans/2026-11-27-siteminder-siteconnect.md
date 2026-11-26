# SiteMinder SiteConnect connection — implementation plan

Replaces Plan 4 Tasks 3 and 4 (docs/superpowers/plans/2026-11-27-plan-4-integrations-launch.md), which were written
before the SiteConnect docs were read. Source of truth for every SiteMinder value (message names, XPaths, error codes
and their exact texts, limits, timeouts): docs/integrations/siteminder.md (from the public docs, read 2026-11-26).
Anything that file marks "inferred" or lists in §7 open questions must be isolated behind one constant or function
with a comment `SITEMINDER-OPEN-Qn`, so the answer from SiteMinder is a one-line change.

**Owner decision (2026-11-27, "Confirm, keep retrying"):** a paid booking is confirmed to the guest locally; the
SiteMinder hand-off runs in the background and is retried durably until it succeeds; staff are alerted when it keeps
failing. A failed hand-off never refunds the guest.

## Global constraints
- No real SiteMinder traffic: there are no credentials and `SITEMINDER_HOSTS` (lib/runtime/config-guard.ts) stays
  empty, so CHANNEL_MODE=siteminder is refused in staging/production until hosts are known. Everything is tested
  against fixtures built from the doc's sample XML (credentials replaced by fake values).
- New dependency allowed: `fast-xml-parser` (pin exact version). No other new runtime dependency.
- All logs through `redact()`; never log credentials or full guest contact data.
- Preview keeps CHANNEL_MODE=mock; the mock must follow the new SiteMinder rules (below) so the preview behaves the
  same as the real thing.
- Every existing test stays green (869 at start); run full vitest, tsc, eslint before each commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Task 1: Confirm locally, hand off in the background
Change the booking flow so payment success → reservation confirmed immediately (guest sees 訂房完成, gets the email),
with the channel push queued.
- Push retry: the existing sync-retry cron (*/5) retries with backoff until success; after the doc's/our limit of
  failures (choose: alert at 3 consecutive failures and again daily, never give up silently) staff get an ops alert
  and the admin reservation page shows 「尚未同步到 SiteMinder」 with a manual retry.
- Remove refund-on-push-failure paths (keep refunds for genuine payment problems). Keep cancel/modify ordering: a
  modify or cancel waits until the original push succeeded; a cancel of a never-pushed booking sends nothing.
- One message in flight per hotel (doc §8.7): serialize channel calls per property (lease per property, not per
  booking), oldest first.
- No lookup for SiteMinder (doc §8.3): `lookupReservation` becomes optional in the ChannelManager interface (or returns
  an "unsupported" result); recovery after a timeout is re-sending the same UniqueID (SITEMINDER-OPEN-Q1).
- Never reuse an ID, never send after a cancel (doc §8.6): mock and conformance suite updated (cancelled code can
  never become active again; pushing an already-accepted code returns the same confirmation).
- Timeout: channel call timeout in the doc's allowed range (60–120 s) with SYNC_LEASE_MS recomputed per the existing
  lease rule.
- Tests: confirm-on-payment, retry/backoff, alert thresholds, per-hotel serialization, cancel-before-push, the
  updated conformance rules. Commit `feat(channel): confirm bookings locally and hand off to the channel in the background`.

## Task 2: Our codes and the Rooms and Rates endpoint
- Code rules (doc §8.1): HotelCode, RoomTypeCode, RatePlanCode are ours. Generate stable codes for existing rows where
  `smPropertyCode`/`smRoomCode`/rate-plan code is empty (format per the doc's allowed characters/length; derive from
  the slug, uppercase, no hyphens), store them, and make them read-only in admin once set (show them on the property,
  room and rate-plan admin pages so staff can give them to SiteMinder). Migration if a column is missing.
- Inbound SOAP endpoint `app/api/channel/siteminder/route.ts` (one URI, dispatch on the body's root element, doc §8.2):
  WS-Security username/password check against secrets `SITEMINDER_INBOUND_USERNAME` / `SITEMINDER_INBOUND_PASSWORD`
  (constant-time compare; failure = the doc's SOAP fault, Type 4 / Code 448, not HTTP 401); body size limit; rate limit.
- `OTA_HotelAvailRQ` (Rooms and Rates): reply with the property's active room types and rate plans per the doc's
  response format. Tests from doc sample XML. Commit `feat(channel): SiteMinder codes and Rooms and Rates endpoint`.

## Task 3: Outbound reservations adapter
`SiteMinderChannelManager implements ChannelManager` (`lib/channel/siteminder/{client,xml,map,errors}.ts`),
constructor `{ endpoint, username, password, hotelCode, fetch?, timeoutMs? }`, wired as CHANNEL_MODE=siteminder in
lib/runtime/deps.ts (with secrets SITEMINDER_USERNAME/PASSWORD and SITEMINDER_ENDPOINT).
- `OTA_HotelResNotifRQ` for new / modify / cancel exactly per doc §3 (ResStatus values, EchoToken, one reservation per
  request, WS-Security). UniqueID = our code without non-alphanumerics (SITEMINDER-OPEN-Q3), mapping kept in one function.
- Extend `ChannelReservation` with what the doc marks required (doc §8.8): guest counts, currency, create/last-modify
  times, room and rate names, special requests/comments, customer; fill them in `toChannelReservation`.
  Discounts go into totals + a comment, promo code in `RoomStay@PromotionCode`, add-ons in `Services` Inclusive,
  paid amount in DepositPayments (inferred — SITEMINDER-OPEN-Qn).
- Error classification per doc §5 (retryable vs not); timeouts via AbortController are retryable.
- Tests: XPath assertions for every mapped field, every error fixture's class, the conformance suite with a
  fixture-backed fetch, timeout. Commit `feat(channel): SiteMinder SiteConnect reservations adapter`.

## Task 4: Inbound ARI
In the same SOAP endpoint: the ARI messages named in doc §4.
- Expand inclusive date ranges into days (≤ the doc's max span); availability is per room type (no rate code needed) —
  change `applyAriUpdates`/`AriUpdate` accordingly; rates and restrictions per room+rate; add schema fields for max
  stay and any restriction the doc lists that we lack (migration), and apply min/max stay, CTA/CTD, stop sell in the
  booking search if not already.
- Unknown room/rate codes → the doc's exact error (402 / 249, case-sensitive text) so SiteMinder auto-disables them
  (doc §8.9); a whole-message validation failure applies nothing.
- Ordering: apply only if the message TimeStamp is ≥ the stored one per day/code (SITEMINDER-OPEN-Q5 isolated).
- Respond well inside the doc's limit (target 1–2 s): batch D1 writes (100/batch); test a 210-day × 8-room message.
- Admin system page shows the last ARI received and any rejected codes.
- Commit `feat(channel): SiteMinder ARI inbound`.

## After the tasks
Whole-branch review; update docs/integrations/siteminder.md §6 with the go-live checklist: WAF allow rule for
SiteMinder's User-Agent and IPs (doc §8.11), secrets to set, codes to hand to SiteMinder, config-guard host lists to
fill once SiteMinder answers.
