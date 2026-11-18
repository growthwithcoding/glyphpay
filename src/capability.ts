/**
 * Scoped payment-link capabilities.
 *
 * A capability is a short-lived, HMAC-signed token that authorizes paying one
 * invoice (optionally one immutable invoice revision). It lets a merchant send
 * a pay link to a shopper who has no account, without trusting an amount or an
 * invoice id from the browser.
 *
 * Format: `gpcap.<base64url(payload)>.<base64url(HMAC-SHA256(secret, payload))>`
 * Payload: `{ v: 1, i: invoiceId, r?: revision, exp: unixSeconds }`
 *
 * The secret is a server-only value (at least 32 bytes of entropy). Use Web
 * Crypto so this works in Node 20+, edge runtimes, and Workers.
 */

const VERSION = 1;
const PREFIX = "gpcap";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const INVOICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const REVISION_PATTERN = /^[a-z0-9]{1,24}$/;
const MAX_TOKEN_LENGTH = 1024;
const MAX_LIFETIME_SECONDS = 60 * 60 * 24 * 30;

export interface PaymentLinkCapability {
  /** Capability format version. */
  v: 1;
  /** Invoice document id the capability is scoped to. */
  i: string;
  /** Optional invoice revision; when set, the capability only authorizes that revision. */
  r?: string;
  /** Expiry, unix seconds. */
  exp: number;
}

export interface PaymentLinkCapabilityInput {
  secret: string;
  invoiceId: string;
  /** Lifetime in seconds. Defaults to 30 minutes; maximum 30 days. */
  expiresInSeconds?: number;
  /** Bind the capability to one invoice revision (recommended for payment links). */
  revision?: string;
  /** Fixed clock for tests. */
  now?: Date;
}

export type CapabilityFailure =
  | "malformed"
  | "unsupported_version"
  | "bad_signature"
  | "expired"
  | "invoice_mismatch"
  | "revision_mismatch";

export type CapabilityVerification =
  | { ok: true; capability: PaymentLinkCapability }
  | { ok: false; reason: CapabilityFailure };

function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  const bytes = encoder.encode(secret);
  if (bytes.byteLength < 32) {
    throw new Error("A payment-link capability secret must be at least 32 bytes of entropy.");
  }
  return bytes;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid base64url value.");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", secretBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Create a scoped capability. Server-only: never call this in the browser. */
export async function createPaymentLinkCapability(input: PaymentLinkCapabilityInput): Promise<string> {
  if (!INVOICE_ID_PATTERN.test(input.invoiceId)) throw new Error("Invoice id is not a valid document id.");
  if (input.revision !== undefined && !REVISION_PATTERN.test(input.revision)) {
    throw new Error("Invoice revision must be 1-24 lowercase letters or digits.");
  }
  const lifetime = input.expiresInSeconds ?? 30 * 60;
  if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > MAX_LIFETIME_SECONDS) {
    throw new Error(`Capability lifetime must be between 1 and ${MAX_LIFETIME_SECONDS} seconds.`);
  }
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const capability: PaymentLinkCapability = { v: VERSION, i: input.invoiceId, exp: nowSeconds + lifetime };
  if (input.revision) capability.r = input.revision;
  const payload = encoder.encode(JSON.stringify(capability));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(input.secret), payload);
  return `${PREFIX}.${base64UrlEncode(payload)}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export interface PaymentLinkVerifyOptions {
  /** Invoice id the caller is trying to pay. */
  invoiceId: string;
  /** Current invoice revision; when the capability is revision-bound this must match. */
  revision?: string;
  /** Tolerated clock skew. Defaults to 60 seconds. */
  clockSkewSeconds?: number;
  now?: Date;
}

/**
 * Verify a capability. Returns a reason instead of throwing so a caller can
 * log the failure without leaking which check failed to the shopper.
 */
export async function verifyPaymentLinkCapability(
  secret: string,
  token: unknown,
  options: PaymentLinkVerifyOptions
): Promise<CapabilityVerification> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };

  let payload: Uint8Array<ArrayBuffer>;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    payload = base64UrlDecode(parts[1]);
    signature = base64UrlDecode(parts[2]);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  let key: CryptoKey;
  try {
    key = await hmacKey(secret);
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  // subtle.verify compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", key, signature, payload))) return { ok: false, reason: "bad_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payload));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "malformed" };
  const capability = parsed as Partial<PaymentLinkCapability>;
  if (capability.v !== VERSION) return { ok: false, reason: "unsupported_version" };
  if (typeof capability.i !== "string" || !INVOICE_ID_PATTERN.test(capability.i)) return { ok: false, reason: "malformed" };
  if (capability.r !== undefined && (typeof capability.r !== "string" || !REVISION_PATTERN.test(capability.r))) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof capability.exp !== "number" || !Number.isSafeInteger(capability.exp)) return { ok: false, reason: "malformed" };

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const skew = Math.max(0, options.clockSkewSeconds ?? 60);
  if (capability.exp + skew < nowSeconds) return { ok: false, reason: "expired" };
  if (capability.i !== options.invoiceId) return { ok: false, reason: "invoice_mismatch" };
  if (capability.r !== undefined && options.revision !== undefined && capability.r !== options.revision) {
    return { ok: false, reason: "revision_mismatch" };
  }
  return { ok: true, capability: capability as PaymentLinkCapability };
}
