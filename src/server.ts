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
  /** Runs once per verified callback. Delivery is at-least-once, so dedupe on `event.id`. Throw to have it retried. */
  onEvent?: (event: GlyphPayEvent) => Promise<void> | void;
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

export interface GlyphPayEvent {
  id: string;
  type: "payment.succeeded" | "payment.failed" | "payment.processing" | "payment.canceled" | "payment.refund_updated" | "payment.dispute_updated";
  createdAt: string;
  livemode: boolean;
  data: Payment;
}

/** Error from the GlyphPay API (status/message are the API's). */
export class GlyphPayError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Throw from `priceOrder` or `beforeCheckout` to send `message` to the shopper with a 400. */
export class CheckoutError extends Error {}

/** Throw from `beforeCheckout` to tell the shopper to retry later; returns HTTP 429. */
export class RateLimitError extends Error {
  constructor(message = "Too many checkout attempts. Please try again shortly.", public retryAfterSeconds = 60) {
    super(message);
    this.name = "RateLimitError";
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

interface SignatureHeader {
  timestamp: string | null;
  signatures: string[];
}

/** Parse `t=…,v1=…,v1=…` without object keys, so header values cannot pollute prototypes. */
function parseSignatureHeader(header: string | null): SignatureHeader {
  const result: SignatureHeader = { timestamp: null, signatures: [] };
  for (const raw of (header ?? "").split(",")) {
    const index = raw.indexOf("=");
    if (index < 1) continue;
    const key = raw.slice(0, index).trim();
    const value = raw.slice(index + 1).trim();
    if (key === "t" && result.timestamp === null) result.timestamp = value;
    if (key === "v1") result.signatures.push(value);
  }
  return result;
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
        event = await verifyCallback(rawBody, req.headers.get("designglyph-signature"), options.callbackSecret);
      } catch {
        return new Response("Invalid signature", { status: 400 });
      }
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
      try {
        if (options.seen && (await options.seen(event.id))) return new Response(null, { status: 204 });
        await options.onEvent?.(event);
      } catch (error) {
        console.error(`GlyphPay event ${event.id} handler failed:`, error instanceof Error ? error.message : error);
        return new Response("Handler failed", { status: 500 });
      }
      return new Response(null, { status: 204 });
    },
  };
}

/**
 * Verifies `Designglyph-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "t.body")>`.
 * Multiple `v1` values are accepted so a secret can be rotated with an overlap.
 * Rejects >5 min skew and returns the parsed event.
 */
export async function verifyCallback(rawBody: string, header: string | null, secret: string): Promise<GlyphPayEvent> {
  if (!secret) throw new GlyphPayError(400, "Invalid GlyphPay signature.");
  const { timestamp, signatures } = parseSignatureHeader(header);
  const timestampNumber = Number(timestamp);
  const fresh = typeof timestamp === "string" && /^\d{1,12}$/.test(timestamp) &&
    Math.abs(Date.now() / 1000 - timestampNumber) <= 300;
  const validHex = signatures.filter((signature) => /^[0-9a-f]{64}$/.test(signature));
  if (!fresh || validHex.length === 0) throw new GlyphPayError(400, "Invalid GlyphPay signature.");

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signed = enc.encode(`${timestamp}.${rawBody}`);
  let matched = false;
  for (const signature of validHex) {
    const bytes = Uint8Array.from(signature.match(/../g)!, (hex) => parseInt(hex, 16));
    // subtle.verify compares in constant time.
    if (await crypto.subtle.verify("HMAC", key, bytes, signed)) {
      matched = true;
      break;
    }
  }
  if (!matched) throw new GlyphPayError(400, "Invalid GlyphPay signature.");
  return JSON.parse(rawBody) as GlyphPayEvent;
}
