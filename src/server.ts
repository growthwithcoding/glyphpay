/**
 * GlyphPay connector, server half. Holds the dgsvc_ service credential, so it
 * must only ever run on the client site's server (route handlers, API routes).
 * Runtime-agnostic: uses fetch + Web Crypto (Node 20+, Next.js, edge, Workers).
 */

const DEFAULT_BASE_URL = "https://designglyph.web.app";
const MAX_BODY_BYTES = 1_000_000;

export interface GlyphPayOptions {
  /** Service credential from Design Glyph admin (dgsvc_test_… / dgsvc_live_…). Never ship to the browser. */
  token: string | undefined;
  /** Signing secret shown when the callback URL was saved in Design Glyph admin. Needed for `webhook`. */
  callbackSecret?: string;
  /** Defaults to the Design Glyph production origin. Non-HTTPS is allowed only for loopback development. */
  baseUrl?: string;
  /** Additional browser origins allowed to call the checkout route. Defaults to same-origin only. */
  allowedCheckoutOrigins?: string[];
  /**
   * Optional hook for rate limiting, a bot challenge, or a cart/session check
   * before a PaymentIntent is created. Throw `RateLimitError` for a 429, or
   * `CheckoutError` for a 400 with its message shown to the shopper.
   */
  beforeCheckout?: (req: Request) => Promise<void> | void;
  /**
   * Price the order from YOUR data (DB, cart, CMS). Never trust an amount sent by the browser.
   * `orderId` must change whenever the amount or description changes (e.g. `${cartId}-v${version}`):
   * GlyphPay ties one payment to one orderId and rejects a changed amount with a 409.
   * Throw `CheckoutError` to show the shopper a message.
   */
  priceOrder?: (body: unknown, req: Request) => Promise<Order> | Order;
  /**
   * Optional fast-path check. Return true when this event id was already
   * processed. This is check-then-act, not an atomic guard: two concurrent
   * deliveries can both see false. The correctness guard must be an atomic
   * insert-if-absent on `event.id` in `onEvent`, in the same transaction as
   * the order update.
   */
  seen?: (eventId: string) => Promise<boolean> | boolean;
  /**
   * Catch-all handler for verified callbacks. A named `onPayment*` handler,
   * when provided, takes precedence for that event type. Delivery is
   * at-least-once, so dedupe on `event.id`. Throw to have it retried.
   */
  onEvent?: (event: GlyphPayEvent) => Promise<void> | void;
  /** Runs for `payment.succeeded`; falls back to `onEvent` when omitted. */
  onPaymentSucceeded?: (event: Extract<GlyphPayEvent, { type: "payment.succeeded" }>) => Promise<void> | void;
  /** Runs for `payment.failed`; falls back to `onEvent` when omitted. */
  onPaymentFailed?: (event: Extract<GlyphPayEvent, { type: "payment.failed" }>) => Promise<void> | void;
  /** Runs for `payment.processing`; falls back to `onEvent` when omitted. */
  onPaymentProcessing?: (event: Extract<GlyphPayEvent, { type: "payment.processing" }>) => Promise<void> | void;
  /** Runs for `payment.canceled`; falls back to `onEvent` when omitted. */
  onPaymentCanceled?: (event: Extract<GlyphPayEvent, { type: "payment.canceled" }>) => Promise<void> | void;
  /** Runs for `payment.refund_updated`; falls back to `onEvent` when omitted. */
  onPaymentRefundUpdated?: (event: Extract<GlyphPayEvent, { type: "payment.refund_updated" }>) => Promise<void> | void;
  /** Runs for `payment.dispute_updated`; falls back to `onEvent` when omitted. */
  onPaymentDisputeUpdated?: (event: Extract<GlyphPayEvent, { type: "payment.dispute_updated" }>) => Promise<void> | void;
  /** Runs for `payment.updated`; falls back to `onEvent` when omitted. */
  onPaymentUpdated?: (event: Extract<GlyphPayEvent, { type: "payment.updated" }>) => Promise<void> | void;
}

export interface Order { orderId: string; amountCents: number; description: string }

export interface CheckoutSession { id: string; paymentIntentId: string; clientSecret: string; publishableKey: string; stripeAccount: string }

export type PaymentStatus = "creating" | "requires_payment_method" | "processing" | "succeeded" | "canceled" | "failed";

export interface Payment {
  id: string;
  orderId: string;
  status: PaymentStatus;
  amountCents: number;
  applicationFeeCents: number;
  currency: "usd";
  refundedCents: number;
  refunds: { stripeRefundId: string | null; amountCents: number; status: string }[];
  disputes: { status: string; amountCents: number }[];
  /** True while not terminal. Callbacks (or polling) are the source of truth, never the browser redirect. */
  stale: boolean;
  updatedAt: string;
}

export interface Refund { paymentId: string; refundId: string; amountCents: number; status: string }

export type GlyphPayEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "payment.processing"
  | "payment.canceled"
  | "payment.refund_updated"
  | "payment.dispute_updated"
  | "payment.updated"
  | "webhook.test";

interface GlyphPayEventBase {
  id: string;
  createdAt: string;
  livemode: boolean;
  data: Payment;
}

export type GlyphPayEvent = {
  [K in GlyphPayEventType]: GlyphPayEventBase & { type: K };
}[GlyphPayEventType];

/** Error from the GlyphPay API (status/message are the API's). */
export class GlyphPayError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Throw from `priceOrder` or `beforeCheckout` to send `message` to the shopper with a 400. */
export class CheckoutError extends Error {}

/** Options for `RateLimitError`; `message` is shown to the shopper. */
export interface RateLimitErrorOptions {
  message?: string;
  retryAfterSeconds?: number;
}

/**
 * Throw from `beforeCheckout` to tell the shopper to retry later; returns HTTP 429.
 * Accepts `(message, retryAfterSeconds)` or `{ message, retryAfterSeconds }`.
 */
export class RateLimitError extends Error {
  public retryAfterSeconds: number;

  constructor(
    messageOrOptions: string | RateLimitErrorOptions = "Too many checkout attempts. Please try again shortly.",
    retryAfterSeconds = 60
  ) {
    const options = typeof messageOrOptions === "object" && messageOrOptions !== null ? messageOrOptions : undefined;
    super(
      options?.message ??
        (typeof messageOrOptions === "string"
          ? messageOrOptions
          : "Too many checkout attempts. Please try again shortly.")
    );
    this.name = "RateLimitError";
    this.retryAfterSeconds = options?.retryAfterSeconds ?? retryAfterSeconds;
  }
}

/** Validate and normalize the API origin. HTTPS is required outside loopback development. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GlyphPayError(500, "GlyphPay baseUrl is not a valid URL.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new GlyphPayError(500, "GlyphPay baseUrl must use https (http is allowed only for localhost).");
  }
  if (url.username || url.password) {
    throw new GlyphPayError(500, "GlyphPay baseUrl must not contain credentials.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  const normalized = `${url.origin}${path}`;
  if (normalized !== DEFAULT_BASE_URL) console.warn(`GlyphPay: using non-default API origin ${normalized}.`);
  return normalized;
}

async function readBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<string> {
  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0) throw new GlyphPayError(400, "Invalid Content-Length.");
    if (length > maxBytes) throw new GlyphPayError(413, "Request body is too large.");
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GlyphPayError(413, "Request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function readJson(req: Request): Promise<unknown> {
  const text = await readBody(req);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function checkoutOriginAllowed(req: Request, allowed: string[]): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // server-to-server callers do not send Origin
  try {
    return origin === new URL(req.url).origin || allowed.includes(origin);
  } catch {
    return false;
  }
}

const EVENT_TYPES = new Set<GlyphPayEventType>([
  "payment.succeeded",
  "payment.failed",
  "payment.processing",
  "payment.canceled",
  "payment.refund_updated",
  "payment.dispute_updated",
  "payment.updated",
  "webhook.test",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape check after signature verification. A malformed body is a permanent
 * 400 (the signature proved it came from GlyphPay, so retrying cannot fix it);
 * `livemode` is checked separately so a backend serializer bug still retries.
 */
function isValidEventPayload(event: unknown): event is GlyphPayEvent {
  if (!isRecord(event)) return false;
  if (typeof event.id !== "string" || event.id.length === 0) return false;
  if (typeof event.type !== "string" || !EVENT_TYPES.has(event.type as GlyphPayEventType)) return false;
  if (typeof event.createdAt !== "string" || event.createdAt.length === 0) return false;
  if (typeof event.livemode !== "boolean") return false;
  if (!isRecord(event.data)) return false;
  if (event.type !== "webhook.test" && (typeof event.data.orderId !== "string" || event.data.orderId.length === 0)) {
    return false;
  }
  return true;
}

/** Named handlers win for their own event type; `onEvent` is the fallback. */
async function dispatchEvent(options: GlyphPayOptions, event: GlyphPayEvent): Promise<void> {
  switch (event.type) {
    case "payment.succeeded":
      if (options.onPaymentSucceeded) { await options.onPaymentSucceeded(event); return; }
      break;
    case "payment.failed":
      if (options.onPaymentFailed) { await options.onPaymentFailed(event); return; }
      break;
    case "payment.processing":
      if (options.onPaymentProcessing) { await options.onPaymentProcessing(event); return; }
      break;
    case "payment.canceled":
      if (options.onPaymentCanceled) { await options.onPaymentCanceled(event); return; }
      break;
    case "payment.refund_updated":
      if (options.onPaymentRefundUpdated) { await options.onPaymentRefundUpdated(event); return; }
      break;
    case "payment.dispute_updated":
      if (options.onPaymentDisputeUpdated) { await options.onPaymentDisputeUpdated(event); return; }
      break;
    case "payment.updated":
      if (options.onPaymentUpdated) { await options.onPaymentUpdated(event); return; }
      break;
  }
  await options.onEvent?.(event);
}

export function glyphPay(options: GlyphPayOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    // Checked per call, not at construction, so `next build` works without env vars.
    if (!/^dgsvc_(test|live)_/.test(options.token ?? "")) throw new GlyphPayError(500, "GlyphPay token is missing or not a dgsvc_ service credential.");
    const res = await fetch(`${baseUrl}/api/client/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${options.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: { message?: string } } | null;
    if (!res.ok || !json?.ok) throw new GlyphPayError(res.status, json?.error?.message ?? `GlyphPay request failed (HTTP ${res.status}).`);
    return json.data as T;
  }

  const id = (paymentId: string) => encodeURIComponent(paymentId);

  const api = {
    /** Idempotent per orderId: calling again returns the same payment. */
    createPayment: (order: Order) => call<CheckoutSession>("POST", "/payments", { ...order, currency: "usd" }),
    getPayment: (paymentId: string) => call<Payment>("GET", `/payments/${id(paymentId)}`),
    /** Omit amountCents to refund the remaining balance. Reusing an idempotencyKey replays the same refund. */
    refund: (paymentId: string, input: { idempotencyKey: string; amountCents?: number }) => call<Refund>("POST", `/payments/${id(paymentId)}/refunds`, input),
    /** Re-read the payment from Stripe if a callback looks missed. */
    reconcile: (paymentId: string) => call<Payment>("POST", `/payments/${id(paymentId)}/reconcile`),
  };

  return {
    ...api,

    /** Route handler: `export const POST = glyphpay.checkout`. Prices the order, returns what the browser needs. */
    checkout: async (req: Request): Promise<Response> => {
      try {
        if (!options.priceOrder) throw new Error("GlyphPay: priceOrder is required for checkout.");
        if (!checkoutOriginAllowed(req, options.allowedCheckoutOrigins ?? [])) {
          return Response.json({ error: "Checkout requests must come from this site." }, { status: 403 });
        }
        const contentType = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        if (contentType && contentType !== "application/json") {
          return Response.json({ error: "Checkout requires application/json." }, { status: 415 });
        }
        const body = await readJson(req);
        await options.beforeCheckout?.(req);
        const session = await api.createPayment(await options.priceOrder(body, req));
        const { clientSecret, publishableKey, stripeAccount } = session;
        return Response.json({ clientSecret, publishableKey, stripeAccount, paymentId: session.id }, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        if (error instanceof RateLimitError) {
          return Response.json(
            { error: error.message },
            {
              status: 429,
              headers: {
                "cache-control": "no-store",
                "retry-after": String(Math.max(1, Math.floor(error.retryAfterSeconds))),
              },
            }
          );
        }
        if (error instanceof CheckoutError) return Response.json({ error: error.message }, { status: 400 });
        if (error instanceof GlyphPayError && error.status === 413) {
          return Response.json({ error: "Checkout request is too large." }, { status: 413 });
        }
        console.error("GlyphPay checkout failed:", error instanceof Error ? error.message : error);
        return Response.json({ error: "Checkout is unavailable right now. Please try again." }, { status: 502 });
      }
    },

    /** Route handler for the callback URL registered in Design Glyph admin: `export const POST = glyphpay.webhook`. */
    webhook: async (req: Request): Promise<Response> => {
      // 5xx makes GlyphPay retry (up to 72h), so config and handler errors don't lose events. A bad signature is a permanent 400.
      if (!options.callbackSecret) return new Response("GlyphPay callback secret not configured", { status: 500 });
      let rawBody: string;
      try {
        rawBody = await readBody(req);
      } catch (error) {
        const tooLarge = error instanceof GlyphPayError && error.status === 413;
        return new Response(tooLarge ? "Payload too large" : "Bad request", { status: tooLarge ? 413 : 400 });
      }
      let event: GlyphPayEvent;
      try {
        event = await verifyCallback(rawBody, req.headers, options.callbackSecret);
      } catch {
        return new Response("Invalid signature", { status: 400 });
      }
      if (!isRecord(event)) return new Response("Invalid event payload", { status: 400 });
      const tokenMode = /^dgsvc_(test|live)_/.exec(options.token ?? "")?.[1];
      if (!tokenMode) return new Response("GlyphPay token not configured", { status: 500 });
      // A missing/non-boolean mode is a malformed event, not proof of forgery.
      // Retry (5xx) so a backend serializer bug does not permanently lose it.
      if (typeof event.livemode !== "boolean") {
        return new Response("Event livemode is missing or invalid", { status: 500 });
      }
      if (event.livemode !== (tokenMode === "live")) {
        return new Response("Event mode does not match this credential", { status: 400 });
      }
      if (!isValidEventPayload(event)) return new Response("Invalid event payload", { status: 400 });
      try {
        if (options.seen && (await options.seen(event.id))) return new Response(null, { status: 204 });
        await dispatchEvent(options, event);
      } catch (error) {
        console.error(`GlyphPay event ${event.id} handler failed:`, error instanceof Error ? error.message : error);
        return new Response("Handler failed", { status: 500 });
      }
      return new Response(null, { status: 204 });
    },
  };
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Standard Webhooks key: the decoded `whsec_` bytes. */
function secretKeyBytes(secret: string): Uint8Array<ArrayBuffer> | null {
  if (!secret.startsWith("whsec_")) return null;
  try {
    const decoded = base64ToBytes(secret.slice(6));
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function parseEvent(rawBody: string): GlyphPayEvent {
  try {
    return JSON.parse(rawBody) as GlyphPayEvent;
  } catch {
    throw new GlyphPayError(400, "Invalid GlyphPay payload.");
  }
}

async function verifyStandardSignature(rawBody: string, headers: Headers, secret: string): Promise<GlyphPayEvent | null> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatureHeader = headers.get("webhook-signature");
  if (!id || !timestamp || !signatureHeader) return null;
  if (!/^\d{1,12}$/.test(timestamp)) return null;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return null;

  const signatures = signatureHeader
    .split(/\s+/)
    .map((part) => {
      const [version, value] = part.split(",", 2);
      return version === "v1" && value && /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
    })
    .filter((value): value is string => value !== null);
  if (signatures.length === 0) return null;

  const keyBytes = secretKeyBytes(secret);
  if (!keyBytes) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signed = enc.encode(`${id}.${timestamp}.${rawBody}`);
  for (const signature of signatures) {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = base64ToBytes(signature);
    } catch {
      continue;
    }
    // subtle.verify compares in constant time.
    if (await crypto.subtle.verify("HMAC", key, bytes, signed)) {
      const event = parseEvent(rawBody);
      if (event.id !== id) throw new GlyphPayError(400, "Invalid GlyphPay signature.");
      return event;
    }
  }
  return null;
}

/**
 * Verifies a Standard Webhooks callback (`webhook-id`, `webhook-timestamp`,
 * `webhook-signature`) against a `whsec_` secret. Rejects >5 min skew.
 */
export async function verifyCallback(rawBody: string, headers: Headers, secret: string): Promise<GlyphPayEvent> {
  if (!secret || !secret.startsWith("whsec_")) throw new GlyphPayError(400, "Invalid GlyphPay signature.");
  const event = await verifyStandardSignature(rawBody, headers, secret);
  if (!event) throw new GlyphPayError(400, "Invalid GlyphPay signature.");
  return event;
}
