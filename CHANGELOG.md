# Changelog

All notable changes to GlyphPay are documented here. The package follows
[Semantic Versioning](https://semver.org/); the public compatibility rules are
in [`docs/versioning-policy.md`](docs/versioning-policy.md).

## [2.3.0] - 2026-11-17

Crypto (stablecoin) rail, additive only. `paymentMethod: "crypto"` is a new
accepted order value, `quote()` gains a `crypto` total, and `paymentMethod` on
a payment may now be `"crypto"`; nothing existing changes meaning. The rail is
only offered when the deployment and the merchant's connected account are
approved for it, so callers that ignore the new field keep working unchanged.

### Added

- `Order.paymentMethod` accepts `"crypto"`: the customer pays in USDC and the
  payment settles in USD, so amounts, webhooks and refunds keep the same shape.
- `quote()` returns `crypto: { chargedCents, processingFeeCents } | null` next to
  the card and bank totals. `null` means the rail is not available here.
- `CheckoutSession.paymentMethod` / `Payment.paymentMethod` document `"crypto"`
  as a possible value.
- Public `PaymentMethod` (`"card" | "us_bank_account" | "crypto"`) and
  `RailQuote` types, so consumers can name the rail they pass to
  `createPayment` without repeating the union.
- The Firestore invoice adapter's `priceOrder` forwards `paymentMethod` from
  the order body (defaulting to card) and gives bank/crypto their own order id,
  so a shopper can switch rails without colliding with the card payment.
- README section on the crypto rail: 1.5% processing, a USD 10,000
  per-transaction cap, no chargebacks, and refunds returned as stablecoin to the
  wallet that paid. It now shows the shopper's rail travelling through the
  browser order into `priceOrder` and out to `createPayment`.
- The browser connector documents that crypto is a redirect method: Stripe sends
  the shopper to its hosted crypto page and back to `returnUrl`, and a return is
  never proof of payment.

## [2.2.0] - 2026-11-09

CLI release, no package API changes: `connect`, `rotate`, `disconnect`,
`doctor` and `deliveries` now find the site's own env file instead of assuming
`.env.local`, and keep the example file and `.gitignore` in step with it.

### Added

- `connect` scans the project root for env files (`.env`, `.env.local`,
  `.env.development.local`, `.env.development`, `.env.production.local`,
  `.env.production`) and writes the credential to a file the site actually
  loads. A file that already holds a Glyph Pay key is preferred, so re-pairing
  updates it in place instead of splitting the credential across files.
- When several candidates exist the CLI asks which file to use; without a
  terminal it takes the first match and prints the choice and the `--env`
  escape hatch.
- After writing, `connect` adds `GLYPHPAY_TOKEN=` and
  `GLYPHPAY_CALLBACK_SECRET=` placeholders to the matching example file
  (`.env.example`, `.env.local.example`, `.env.sample`, `.env.template`,
  created when none exists) and adds the credential file to the nearest
  `.gitignore`, un-ignoring the example file when a broad rule like `.env*`
  would hide it. Existing values and unrelated lines are preserved, and a
  failure there never discards a credential that was already written.

### Changed

- `rotate`, `disconnect`, `doctor` and `deliveries` resolve the env file the
  same way. `--env <path>` still wins over detection.

## [2.0.0] - 2026-11-08

Release for Standard Webhooks-only callbacks. Removes the legacy callback path
shipped in 1.1.0, plus the 1.0.3 re-audit and pairing ergonomics from the
follow-up review. This contains a breaking callback change. Live activation
remains not approved.

### Added

- Named webhook handlers (`onPaymentSucceeded`, `onPaymentFailed`,
  `onPaymentProcessing`, `onPaymentCanceled`, `onPaymentRefundUpdated`,
  `onPaymentDisputeUpdated`, `onPaymentUpdated`) run instead of `onEvent` for
  their event type; `onEvent` remains the catch-all fallback.
- `glyphpay connect --non-interactive` prints the verification URL, user code,
  device code, expiry, and a `--poll` command as JSON, then exits without
  waiting. `--poll <device-code>` finishes the pairing and writes the
  credential.
- `GlyphPayEvent` now covers `payment.updated` and `webhook.test`.
- Standard Webhooks support: callbacks include `webhook-id`,
  `webhook-timestamp`, and a base64 `webhook-signature`. Callback credentials
  are `whsec_` base64 secrets, and `verifyCallback` accepts the request
  `Headers`.

### Removed

- The legacy `Designglyph-Signature` callback header and `dgcb_` callback
  secrets. Callback verification is Standard Webhooks only; this is a breaking
  change for 1.0.x callback integrations.

### Changed

- The webhook route validates the event shape after verifying the signature
  (`id`, `type`, `createdAt`, and `data.orderId` for payment events) and returns
  400 for a malformed payload before `seen` or any handler runs;
  missing/non-boolean `livemode` still returns 500 so the delivery retries.

### Fixed

- `RateLimitError` now accepts the documented
  `{ message, retryAfterSeconds }` options object as well as
  `(message, retryAfterSeconds)`, so copied examples return a real shopper
  message and the requested `Retry-After` instead of `[object Object]` and the
  60-second default.
- The generated Express adapter builds the public URL from `req.protocol` and
  `Host` and reads `X-Forwarded-Proto`/`X-Forwarded-Host` only when
  `app.set("trust proxy", 1)` is enabled. Without `trust proxy`, a
  client-supplied forwarded header is ignored, so integrator code that builds
  absolute URLs from the request is not exposed to host-header injection.
- Removed a duplicated compatibility sentence from the README.

## [1.1.0] - 2026-11-08

Published release. Added Standard Webhooks support alongside the legacy
`Designglyph-Signature` header and `dgcb_` callback secrets, named webhook
handlers, payload-shape validation, and `connect --non-interactive`/`--poll`.
Superseded by 2.0.0.

## [1.0.3] - 2026-11-08

Follow-up patch for the re-audit of 1.0.2. No package API changes. Live
activation remains not approved.

### Fixed

- Webhooks return 500, not a permanent 400, when `livemode` is missing or not
  a boolean, so GlyphPay retries. A boolean that disagrees with the
  credential's mode still returns 400.
- The generated Express adapter builds the request URL from the first
  `X-Forwarded-Proto` and `X-Forwarded-Host` header values, so checkout
  `Origin` checks pass behind a TLS-terminating proxy. `init` also prints
  `app.set("trust proxy", 1)` and `allowedCheckoutOrigins` guidance.
- `connect` opens a verification URL only when its origin matches the
  configured API origin or the fixed `designglyph.com` allowlist, so a
  compromised API cannot redirect developers to a look-alike sign-in page.
- The README no longer links repository-only `docs/` files, which npm users
  cannot open.

### Changed

- The README and setup guide replace the check-then-act `seen`/`onEvent`
  example with an atomic insert-if-absent on `event.id` inside the same
  transaction as the order update. `seen` is documented as a fast path only.
- The README carries an inline shared-limiter example for `beforeCheckout`,
  notes that a per-process `Map` is insufficient, and points at
  `RateLimitError` (HTTP 429) and Stripe Radar.
- The publish workflow refuses a dirty working tree and records the published
  commit, so npm's `gitHead` can be matched to a release commit. Publishing
  still requires trusted publishing/provenance setup and authorization.
- The `doctor` test event uses `data.status: "test"` instead of `"succeeded"`.

## [1.0.2] - 2026-11-08

Follow-up security patch for the package-side 1.0.0 audit findings that were not
in the published 1.0.1 package. Live activation remains not approved.

### Added

- `RateLimitError` lets `beforeCheckout` return HTTP 429 with `retry-after`.
  `docs/checkout-abuse-protection.md` documents an atomic shared limiter, a
  bot-challenge pattern, and Stripe Radar guidance.
- CLI pairing requests show the masked requester network, CLI version, request
  time, and the current webhook beside the requested one. A webhook host change
  requires an additional deliberate confirmation.
- Every CLI approval emails `business.billingContact.email` with the approving
  user, masked network, CLI, and webhook. A mail failure raises an `email_failed`
  billing alert without blocking the approval.

### Changed

- The manual GitHub Actions publish workflow uses npm trusted publishing (OIDC)
  and `--provenance`; it stores no npm token. The package now declares its
  GitHub repository and directory so npm can verify the trusted publisher.

## [1.0.1] - 2026-11-08

Security patch for the 1.0.0 audit. Backend callback delivery already resolved
DNS, rejected private/link-local/metadata addresses, refused redirects, and
stored status-only errors; these package and documentation changes close the
core package-side gaps.

### Fixed

- Webhooks cap the body at 1 MB before signature verification, reject events
  whose `livemode` does not match the credential, accept multiple `v1`
  signatures during secret rotation, and support an optional `seen(eventId)`
  replay guard.
- Checkout requires JSON, checks `Origin`, caps bodies, and exposes
  `beforeCheckout(req)` for rate limiting or a bot challenge.
- `returnUrl` stays on the site's origin unless `allowCrossOriginReturn` is set.
- The CLI rejects CR/LF/NUL in env values, validates token and secret formats,
  refuses non-HTTPS API and callback URLs outside loopback, opens browser URLs
  without `cmd.exe`, and strips control characters from server output.
- `doctor` refuses unsafe callback probes and warns when the env file is not
  ignored by git.
- Docs use session-scoped cart lookup, event-id dedupe, and fresh signatures for
  retries; delivery errors are documented as status-only.

### Changed

- `--base-url` and `GLYPHPAY_API_URL` must use HTTPS except for loopback
  development. A non-default API origin is printed.

## [1.0.0] - 2026-11-08

GlyphPay 1.0.0 is the first GA code line. It closes the remaining verified
billing defects, freezes the v1 HTTP contract, and adds an executable release
gate. It is a **code and contract** milestone: live payments remain subject to
the external sandbox, deployment, operational, and approval gates in
[`docs/live-activation-checklist.md`](docs/live-activation-checklist.md).

### Fixed

- **Payment attempts are counted from persisted attempts** (F-14). A canceled
  or abandoned PaymentIntent no longer depends on a webhook having populated
  `invoice.payments`; the next session uses the next stable idempotency key.
  Deployments without the attempt index still fall back to ledger payments.
- **Multi-refund audit collision recorded as resolved** (F-13). Refund audit ids
  are keyed by `${event.id}:${refundId}` and covered by a regression test.

### Changed

- Invoice numbers use one monotonic sequence per environment. The UTC year is
  a label in `DG-YYYY-NNNN`, never a reset boundary, so numbers are not reused
  across years.
- Documentation now distinguishes local code completion from deployed/live
  acceptance and removes stale claims that scheduled reconciliation did not
  exist.

### Added

- [`docs/versioning-policy.md`](docs/versioning-policy.md): SemVer,
  additive-only v1 APIs, deprecation windows, callback evolution, and runtime
  support.
- `scripts/check-release.mjs` and `release:check`: fail on version drift and
  missing package export targets; CI runs the gate after the package build.
- “1.0 compatibility” guidance in the package README and client setup guide.

### Compatibility

- `glyphpay` 1.x keeps the documented package exports and `/api/client/v1` /
  `/api/cli/v1` request/response shapes for additive changes only.
- CLI: Node 18+. Server connector: Node 20+, Next.js, edge runtimes, or
  Cloudflare Workers.

## [0.5.0] - 2026-11-08

### Added

- Opaque-cursor pagination and state filtering for callback deliveries across
  the in-memory and Firestore stores, admin API/UI, and `glyphpay deliveries`.
- A state/date composite index for filtered delivery history.
- Emulator and package tests for pagination and filtering.

## [0.4.0] - 2026-11-08

### Added

- Framework-aware `glyphpay init` for Next.js, Remix, Astro, SvelteKit, Hono,
  and Express.
- Callback delivery outbox, admin delivery table, manual replay, and
  `glyphpay deliveries`.
- Firestore composite indexes for delivery history and emulator-backed tests.
