# glyphpay

Drop-in connector that lets a website take payments through [GlyphPay](https://glyphpay.net) by Design Glyph. Payments go to the site owner's own Stripe connected account.

| Import | Runs on | What it gives you |
| --- | --- | --- |
| `glyphpay/server` | Site's server | `glyphPay()`: `checkout` and `webhook` route handlers, plus `createPayment`, `getPayment`, `refund`, `reconcile` |
| `glyphpay/react` | Browser | `<GlyphPayCheckout />` |
| `glyphpay/browser` | Browser, any site | `mountCheckout(el, options)` for sites without React |

The CLI covers setup, diagnostics, and credential lifecycle:

| Command | What it does |
| --- | --- |
| `glyphpay connect` | Pair a site through the browser and write the server credential. |
| `glyphpay doctor` | Check env, token, Stripe readiness, webhook URL, and an optional signed test event. |
| `glyphpay rotate` | Re-pair the site and replace the credential. |
| `glyphpay disconnect` | Revoke the credential and remove the local keys. |
| `glyphpay deliveries` | Page/filter webhook deliveries and retry one with `--retry <id>`. |
| `glyphpay init` | Scaffold routes for Next.js, Remix, Astro, SvelteKit, Hono, or Express. |

## 1.0 compatibility

`glyphpay` 1.x follows Semantic Versioning. The documented package exports and the `/api/client/v1` and `/api/cli/v1` HTTP contracts accept additive changes only; ignore unknown response fields and event types. Breaking changes ship under a new API version with an overlap period.

The CLI supports **Node 18+**. The server connector (`glyphpay/server`) uses `fetch` and Web Crypto and targets **Node 20+**, Next.js, edge runtimes, and Cloudflare Workers. A 1.0 release is a code and contract milestone: live payments remain gated by sandbox acceptance, deployment verification, and written approval.

## Connect a site from the CLI

```sh
npx glyphpay connect --url https://client-site.com
```

The command opens Glyph Pay in your browser. Sign in as the client's billing email (or a Design Glyph admin), pick the client account, confirm the webhook URL and approve the pairing code. The terminal receives a test service credential and, when a webhook URL was registered, its signing secret. It writes both to the site's own env file: the CLI scans the project root for `.env`, `.env.local`, `.env.development.local` and friends, preferring a file that already holds a Glyph Pay key. When several candidates exist it asks which file to use; without a terminal it uses the first match and prints the choice.

```sh
GLYPHPAY_TOKEN=dgsvc_test_...
GLYPHPAY_CALLBACK_SECRET=whsec_...
```

- `--url <site>` registers `<site>/api/glyphpay/webhook`. Pass a full URL to use a different route.
- `--env <path>` targets another env file; `--print` prints the values instead of writing.
- After writing, `connect` appends `GLYPHPAY_TOKEN=` and `GLYPHPAY_CALLBACK_SECRET=` placeholders to the matching example file (`.env.example`, `.env.local.example`, `.env.sample`, or `.env.template`, created if missing) and adds the credential file to the nearest `.gitignore`. Existing values and unrelated lines are preserved, and `.env.example` stays unignored.
- `--no-open`, `--base-url` and `--timeout` help scripts and local testing.
- `--non-interactive` prints the verification URL, user code, device code, expiry, and a `--poll` command as JSON, then exits. Run that command on the same machine to wait for approval and write the credential.
- Codes expire after ten minutes. Approving again rotates the token: the previous token stops working immediately.
- Pairing is disabled while the platform is in live mode.
- **Only approve a code you generated in your own terminal.** Glyph Pay never calls, emails, or messages you to approve a pairing code. Check the webhook domain before approving; approval rotates the credential and can replace the old webhook.
- `--base-url` and `GLYPHPAY_API_URL` must use HTTPS; loopback HTTP is accepted only for local development. A non-default origin is printed.

The browser never receives the credential. Keep the token in server environment variables and never prefix it with `NEXT_PUBLIC_`, `VITE_` or `PUBLIC_`.

## Check, rotate, and disconnect

```sh
npx glyphpay doctor
npx glyphpay doctor --json
npx glyphpay rotate
npx glyphpay disconnect
```

`doctor` verifies the local env file, warns when it is not ignored by git, checks for credentials leaked into public-prefixed variables, validates the token with Glyph Pay, checks Stripe charge readiness and the registered webhook, and optionally sends a signed test event:

```sh
npx glyphpay doctor --send-test-event
```

The test event has type `webhook.test`, a zero-dollar `data` payload, and `data.status: "test"`, so a handler that checks status cannot mistake it for a real payment. Ignore event types you do not handle in `onEvent`.

`rotate` re-runs browser approval and reuses the registered callback URL when the current token is still valid. `disconnect` revokes the credential immediately and removes `GLYPHPAY_TOKEN` and `GLYPHPAY_CALLBACK_SECRET` from the env file; pass `--yes` in scripts or `--keep-env` to leave the local values in place.

## Inspect and retry webhook deliveries

```sh
npx glyphpay deliveries
npx glyphpay deliveries --retry evt_...
```

`deliveries` pages through callback outbox records for the credential's client and environment: event type, delivery state, attempt count, timestamp, and the last error. Filter with `--state pending|delivered|failed`, control the page with `--limit 1..100`, and pass the returned `--cursor` for the next page. A retry re-sends the stored event body with a fresh signature and timestamp, then persists the result. Retry is one attempt; fix the endpoint first. The admin **Connections** tab exposes the same filtering, pagination, and retry operations.

## Scaffold a site

```sh
npx glyphpay init
```

The command detects the project framework from `package.json`. It creates a server connector plus the framework-native checkout and webhook entry points, and appends placeholders to `.env.example` without changing existing values. Supported targets:

- **Next.js App Router** — `app/api/glyphpay/*` or `src/app/api/glyphpay/*` route handlers.
- **SvelteKit** — `src/routes/api/glyphpay/*/+server.ts` with `src/lib/server/glyphpay.ts`.
- **Astro** — `src/pages/api/glyphpay/*.ts`; use server/SSR output and an adapter.
- **Remix** — `app/routes/api.glyphpay.*.ts` with `app/lib/glyphpay.server.ts`.
- **Hono** — `src/glyphpay-routes.ts`; mount it with `app.route("/api/glyphpay", glyphpayRoutes)`.
- **Express** — `src/glyphpay-routes.ts`; mount it with `app.use("/api/glyphpay", glyphpayRoutes)`. The webhook route uses `express.raw` so signatures verify against the original bytes. The adapter honors `X-Forwarded-Proto`/`X-Forwarded-Host` only when `app.set("trust proxy", 1)` is enabled, so set it when TLS ends at a proxy; otherwise `Origin` checks fail closed.

It refuses to overwrite existing files unless you pass `--force`; use `--dry-run` to preview. Then run `glyphpay connect` and wire `priceOrder()` and `onEvent()` to your order database.

## Typed setup: Firebase Functions + Firestore invoices

`setup` is the deployment-aware version of `init`. It detects the frontend separately from the backend target, then generates the server integration where it can actually run:

```sh
npx glyphpay setup \
  --target firebase-functions \
  --preset firestore-invoices \
  --ui react
```

If the project is a static Next.js export (`output: "export"`), `setup --target next` fails with an explanation instead of writing route handlers that can never run. Supported targets are `firebase-functions`, `next`, `remix`, `astro`, `sveltekit`, `hono`, and `express`; `--preset custom` keeps the generic `init` scaffold.

For Firebase Functions, `setup`:

- writes `functions/src/glyphpay/config.ts`: explicit invoice collection and field mappings, disjoint status groups, the authorization policy, and a pure `applyInvoicePayment`;
- writes `functions/src/glyphpay/functions.ts`: `defineSecret("GLYPHPAY_TOKEN")`, `defineSecret("GLYPHPAY_CALLBACK_SECRET")`, `createFirebaseHttpsHandler`, and an authorized `status` route;
- appends one export to the existing Functions entry point (`index.ts`) and adds `glyphpay` to the Functions and site packages;
- adds only the checkout, webhook and status Hosting rewrites, ahead of catch-alls. Unrelated rewrites, redirects and headers are preserved, and an existing `/api/glyphpay{,/**}` rewrite to the same function is reused;
- writes a small React `InvoicePayment` wrapper around `GlyphPayCheckout` that never reads `window` while rendering;
- writes `functions/.env.example` placeholders only, never secret values.

Use `--dry-run` and `--json` to preview, `--force` to replace generated files you edited, `--functions-dir`, `--function-id`, `--region` and `--checkout-path`/`--webhook-path`/`--status-path` for layout. A differing generated file is a hard error without `--force`, and an existing exact rewrite owned by another function is always an error: setup never shadows another route.

The generated config still starts in a safe, broken state: `assertConfigured()` refuses to boot until `CONFIGURED` is `true` and the collection, field names and status groups are reviewed. `authorize` is required because the Admin SDK bypasses Firestore Security Rules; a server lookup is not authorization.

### Invoice adapter

`glyphpay/firebase` exports `createFirestoreInvoiceAdapter`, `asFirestoreLike`, and the adapter types. The adapter supplies `priceOrder`, `onEvent`, `status`, `applyVerifiedPayment`, `orderIdFor` and `revisionFor`:

- the browser sends only `{ invoiceId }` (or a custom reference); pricing always comes from the invoice document;
- unrelated field names are never inferred: `outstandingCents`, `description`, `status`, `currency`, `businessId` and `environment` are explicit, and a status may belong to only one of `payable`, `paid`, `void`, `processing`;
- a payment attempt is identified by `gp1.<invoiceId>.<revision>`, where the default revision hashes the outstanding balance, currency and description, so a changed balance produces a new order instead of charging a stale amount;
- the durable business ledger is one document per PaymentIntent (`payments`), delivery identity is one document per callback id (`deliveries`), and `applyPayment` runs inside the transaction, may be re-run, and must stay free of email/HTTP/entitlement calls;
- duplicate deliveries, different event ids for the same payment, out-of-order events, environment/currency/amount/order mismatches, and `webhook.test` diagnostics are handled before the invoice is touched. Late success on a void or paid invoice is recorded as `unapplied` and never credited;
- refunds and disputes are recorded as facts; they do not re-credit the invoice or re-run fulfillment. Optional fulfillment outbox rows and `onApplied` hooks run only after commit.

### Payment-link capabilities

`glyphpay/capability` exports `createPaymentLinkCapability` and `verifyPaymentLinkCapability`: an HMAC-SHA256 token (`gpcap.<payload>.<sig>`) bound to an invoice id, optional immutable revision and expiry, with a minimum 32-byte secret and constant-time verification. Mint it on the server when an authorized user requests a link; verify it in the adapter's `authorize` before pricing or serving status. The capability replaces a session, it does not replace business authorization.

### Firebase secrets

`glyphpay connect` writes local development values (the detected env file, or `--env <path>`). Those are not production secrets. Production values belong in Secret Manager:

```sh
firebase functions:secrets:set GLYPHPAY_TOKEN
firebase functions:secrets:set GLYPHPAY_CALLBACK_SECRET
```

Uploading secrets, pairing approval, deployment and live activation are separate, explicitly approved actions.

## Manual setup: connect the client in Design Glyph admin

1. **Admin → Clients → (client)**: make sure Stripe onboarding is complete (charges enabled).
2. **Issue a service credential** (test first). Copy the `dgsvc_test_…` token. It is shown only once.
3. **Set the callback URL** to `https://<client-site>/api/glyphpay/webhook`. Check the domain before saving; saving replaces the previous callback. Copy the signing secret. It is also shown only once.

## Add to the client site

```sh
pnpm add glyphpay
```

`.env` (server only, never `NEXT_PUBLIC_`):

```sh
GLYPHPAY_TOKEN=dgsvc_test_...
GLYPHPAY_CALLBACK_SECRET=...
```

`lib/glyphpay.ts`

```ts
import { glyphPay, CheckoutError } from "glyphpay/server";

export const glyphpay = glyphPay({
  token: process.env.GLYPHPAY_TOKEN,
  callbackSecret: process.env.GLYPHPAY_CALLBACK_SECRET,

  // Price the order from YOUR data. Never trust an amount sent by the browser.
  async priceOrder(body, req) {
    const cartId = (body as { cartId?: string }).cartId;
    // Load from the shopper's session, or verify ownership; never fetch by a guessable id alone.
    const cart = cartId ? await db.carts.getForShopper(cartId, req) : null;
    if (!cart?.items.length) throw new CheckoutError("Your cart is empty.");
    // orderId must change whenever the total changes, or GlyphPay returns 409.
    return { orderId: `${cart.id}-v${cart.version}`, amountCents: cart.totalCents, description: `Order ${cart.id}` };
  },

  // Optional fast path only. It is check-then-act, so two concurrent deliveries
  // can both read false; never use it as the durable dedupe guard.
  seen: (eventId) => db.processedEvents.has(eventId),

  // Signed and verified, delivered at least once. The durable guard is an atomic
  // insert-if-absent on event.id in the same transaction as the order update.
  // Act only when the insert reports that it created a new row. Throw to retry.
  async onEvent(event) {
    await db.transaction(async (tx) => {
      const firstDelivery = await tx.processedEvents.insertIfAbsent(event.id);
      if (!firstDelivery) return; // a concurrent or earlier delivery handled it
      if (event.type === "payment.succeeded") {
        await tx.orders.markPaid(event.data.orderId, event.data.id);
      }
      if (event.type === "payment.failed") await tx.orders.markFailed(event.data.orderId);
    });
  },
});
```

Named hooks take precedence over `onEvent` for their event type: `onPaymentSucceeded`, `onPaymentFailed`, `onPaymentProcessing`, `onPaymentCanceled`, `onPaymentRefundUpdated`, `onPaymentDisputeUpdated`, and `onPaymentUpdated`. Use `onEvent` for the rest or to handle everything in one place.

`app/api/glyphpay/checkout/route.ts`

```ts
import { glyphpay } from "@/lib/glyphpay";
export const POST = glyphpay.checkout;
```

`app/api/glyphpay/webhook/route.ts`

```ts
import { glyphpay } from "@/lib/glyphpay";
export const POST = glyphpay.webhook;
```

The checkout route requires `application/json`, checks the request `Origin`, caps the body at 1 MB, and calls `beforeCheckout(req)` when you provide it. Throw `RateLimitError` from that hook for HTTP 429 with `retry-after` and no-store. `message` is shown to the shopper; the constructor also accepts `(message, retryAfterSeconds)`:

```ts
import { RateLimitError } from "glyphpay/server";

export const glyphpay = glyphPay({
  // ...token, callbackSecret, priceOrder
  async beforeCheckout(req) {
    // Count per IP and per session in your database or cache. A per-process Map
    // is not enough: every instance would start with a fresh limit.
    const key = `${clientIp(req)}:${await sessionId(req)}`;
    if (!(await limiter.hit(key, { limit: 20, windowSeconds: 60 }))) {
      throw new RateLimitError({ message: "Too many attempts. Try again shortly.", retryAfterSeconds: 30 });
    }
  },
});
```

Add a bot challenge (for example Turnstile) after repeated failures, and enable Stripe Radar rules on every connected account. If a proxy rewrites the public origin, pass the site origin in `allowedCheckoutOrigins`.

The webhook route caps bodies at 1 MB, accepts multiple `v1` signatures during secret rotation, and rejects a `livemode` that disagrees with the credential. A missing or non-boolean `livemode` returns 500 so the delivery is retried. After verification it validates the event shape (`id`, `type`, `createdAt`, and `data.orderId` for payment events) and returns 400 before `seen` or any handler runs; `webhook.test` events may omit `orderId`. `seen` is consulted as a fast path only, and `onEvent` dedupes durably with an atomic insert on `event.id`.

### Webhook signatures

The webhook route accepts Standard Webhooks only:

- `webhook-id`, `webhook-timestamp`, and `webhook-signature: v1,<base64 HMAC-SHA256(key, "id.timestamp.body")>`.

Callback credentials are `whsec_` base64 secrets, so the HMAC key is the decoded secret bytes. `verifyCallback(rawBody, req.headers, secret)` verifies the request headers; the route handler does this automatically. The route accepts multiple space-separated `v1` signatures during rotation.

Checkout page:

```tsx
import { GlyphPayCheckout } from "glyphpay/react";

<GlyphPayCheckout order={{ cartId }} returnUrl={`/thank-you?cart=${cartId}`} appearance={{ theme: "stripe" }} />
```

`returnUrl` must stay on the site's origin unless you set `allowCrossOriginReturn`. A redirect is never payment proof; verify the payment on the server.

Style the button with `.glyphpay button { … }`. Errors appear in `.glyphpay [role=alert]`.

Without React:

```html
<div id="pay"></div>
<script type="module">
  import { mountCheckout } from "glyphpay/browser";
  // cartId comes from the shopper's server-rendered session, not a URL parameter.
  mountCheckout(document.getElementById("pay"), { order: { cartId: "session-cart-id" }, returnUrl: "/thank-you" });
</script>
```

The route handlers take a standard `Request` and return a `Response`, so the same two lines work in Remix, Astro, Hono, SvelteKit, and Cloudflare Workers. In Express, `glyphpay init` generates a small adapter that preserves the raw webhook body and builds the public request URL from `req.protocol` and `Host`, honoring `X-Forwarded-Proto`/`X-Forwarded-Host` only when `app.set("trust proxy", 1)` is enabled; set that behind a TLS-terminating proxy.

## Crypto (stablecoin) payments

`quote()` returns the crypto total, or `null` when the rail is unavailable:

```ts
const quote = await glyphpay.quote(cart.totalCents);
if (!quote.crypto) {
  // Offer card or bank only.
}
```

When it is quoted, let the shopper choose it and pass that rail through your
order. The browser's order object is opaque to the package, so naming the rail
there is enough for `priceOrder` to price and return it:

```tsx
// Checkout page: render this only when quote.crypto is non-null.
<GlyphPayCheckout
  order={{ cartId, paymentMethod: "crypto" }}
  returnUrl={`/thank-you?cart=${cartId}`}
/>
```

```ts
// Site server: the rail comes from the browser, the amount never does.
async priceOrder(body) {
  const rail = (body as { paymentMethod?: PaymentMethod }).paymentMethod === "crypto" ? "crypto" : "card";
  if (rail === "crypto" && cart.totalCents > 1_000_000) {
    throw new CheckoutError("Crypto payments are capped at $10,000.");
  }
  return {
    orderId: `${cart.id}-v${cart.version}-${rail}`,
    amountCents: cart.totalCents,
    description: `Order ${cart.id}`,
    paymentMethod: rail,
  };
}
```

`orderId` includes the rail so a shopper switching from card to crypto gets a
new payment instead of the card intent. Import `type PaymentMethod` from
`glyphpay/server` for the union. With `glyphpay/firebase`, the generated
`priceOrder` reads `paymentMethod` from the order body, defaults to card, and
adds its own rail-specific order id, so the adapter is ready for this without a
custom pricing function.

- The customer pays in USDC, and Stripe sends them to its own crypto page and
  back to `returnUrl`. **The redirect is not proof of payment** - keep verifying
  through the webhook or `getPayment()`.
- The payment settles in USD, so amounts, webhooks, refunds and the callback
  body keep the same shape as a card payment.
- Processing is a flat 1.5% with no fixed fee, and the customer is capped at USD
  10,000 per transaction. Do not offer the rail above that total.
- There are no chargebacks. A refund is returned as stablecoin to the wallet that
  paid, so tell customers to keep access to that wallet.
- Availability is per deployment **and** per merchant account. Call `quote()`
  instead of assuming the rail exists.

## How a payment flows

1. The component POSTs `order` to `/api/glyphpay/checkout`. `priceOrder` sets the amount, and the site's server calls GlyphPay with the token.
2. The browser gets back only `clientSecret`, `publishableKey`, and `stripeAccount`, then mounts Stripe's Payment Element.
3. The shopper pays, and Stripe redirects to `returnUrl`. **The redirect doesn't prove payment.**
4. GlyphPay POSTs `payment.succeeded` to `/api/glyphpay/webhook`, and `onEvent` marks the order paid. The thank-you page reads the order status from your database, or calls `glyphpay.getPayment(paymentId)` after checking that the payment belongs to that shopper.

Refunds run server-side:

```ts
await glyphpay.refund(paymentId, { idempotencyKey: `${orderId}-refund-1` });
```

## Develop

```sh
cd packages/glyphpay && npm install && npm test
```
