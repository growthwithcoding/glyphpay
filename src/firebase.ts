/**
 * Server-only Firestore invoice adapter + Firebase HTTPS request adapter.
 *
 * This module is exported as `glyphpay/firebase`. It must never be imported by
 * a browser entry point: it handles authoritative pricing, authorization,
 * transactional payment application, and delivery deduplication.
 *
 * Design rules:
 *  - Every financial or access-control mapping is explicit configuration. The
 *    adapter never infers meaning from a field called `total`, `status`, or
 *    `owner`.
 *  - The browser may send an invoice reference and a capability, never an
 *    amount. Pricing is read from Firestore.
 *  - One internal application path (`applyVerifiedPayment`) is used by signed
 *    callbacks and reconciliation results. Delivery identity and payment
 *    identity are tracked separately.
 *  - External effects never run inside the transaction. An optional outbox row
 *    is written atomically; delivery workers must be retry-safe.
 *  - Firestore server SDKs bypass Security Rules, so a successful lookup is
 *    not authorization. `authorize` is required and runs before any invoice
 *    detail is returned.
 */

import { CheckoutError, type GlyphPayEvent, type Order, type PaymentMethod } from "./server.js";

/* ------------------------------------------------------------------ */
/* Firestore structural types (no firebase-admin dependency)           */
/* ------------------------------------------------------------------ */

export type FirestoreData = Record<string, unknown>;

export interface FirestoreSnapshotLike {
  readonly exists: boolean;
  readonly id: string;
  data(): FirestoreData | undefined;
}

export interface FirestoreDocumentReferenceLike {
  readonly id: string;
  readonly path: string;
  get(): Promise<FirestoreSnapshotLike>;
}

export interface FirestoreTransactionLike {
  get(reference: FirestoreDocumentReferenceLike): Promise<FirestoreSnapshotLike>;
  create(reference: FirestoreDocumentReferenceLike, data: FirestoreData): unknown;
  set(reference: FirestoreDocumentReferenceLike, data: FirestoreData, options?: { merge?: boolean }): unknown;
}

export interface FirestoreLike {
  doc(path: string): FirestoreDocumentReferenceLike;
  runTransaction<T>(updateFunction: (transaction: FirestoreTransactionLike) => Promise<T>): Promise<T>;
}

/**
 * Cast a `firebase-admin` Firestore instance to the narrow port this adapter
 * uses. The Admin SDK is not a dependency of glyphpay; the caller supplies it.
 */
export function asFirestoreLike(value: unknown): FirestoreLike {
  const candidate = value as Partial<FirestoreLike> | null;
  if (!candidate || typeof candidate.doc !== "function" || typeof candidate.runTransaction !== "function") {
    throw new Error("A Firestore instance with doc() and runTransaction() is required.");
  }
  return candidate as FirestoreLike;
}

/* ------------------------------------------------------------------ */
/* Public configuration                                                */
/* ------------------------------------------------------------------ */

export type InvoiceRecord = Record<string, unknown>;

export interface FirestoreInvoiceFieldMap {
  /** Integer minor units still due. Required. */
  outstandingCents: string;
  /** Human-readable description shown on the payment receipt. Required. */
  description: string;
  /** Invoice status value. Required. */
  status: string;
  /** ISO currency code (lowercase). Required. */
  currency: string;
  /** Tenant/business id of the invoice. Required. */
  businessId: string;
  /** "test" | "live" for this invoice. Required. */
  environment: string;
}

export interface FirestoreInvoiceStatusMap {
  /** Statuses that may start a payment. */
  payable: readonly string[];
  /** Statuses that mean the invoice is settled. */
  paid: readonly string[];
  /** Statuses that mean the invoice must not be paid (voided/canceled). */
  void: readonly string[];
  /** Statuses that mean a payment is already in flight. */
  processing?: readonly string[];
}

export interface InvoiceAuthorizationInput<TInvoice> {
  invoiceId: string;
  invoice: TInvoice;
  /** Parsed JSON body sent by the browser. Never trust amounts from it. */
  body: FirestoreData;
  req: Request;
}

export type InvoiceAuthorization =
  | { allowed: true }
  | {
      allowed: false;
      /** Shopper-safe message. Never include invoice details here. */
      message?: string;
      status?: 400 | 401 | 403 | 404;
    };

export type InvoiceOrderRevision = string;

export interface PaymentRefundFact {
  /** Stable key: the Stripe refund id when GlyphPay exposes one. */
  key: string;
  amountCents: number;
  status: string;
}

export interface PaymentDisputeFact {
  key: string;
  status: string;
  amountCents: number;
}

/** One verified payment fact. Produced only from a signed callback or a trusted API read. */
export interface VerifiedPaymentFacts {
  paymentIntentId: string;
  orderId: string;
  status: "succeeded" | "processing" | "failed" | "canceled";
  /**
   * Rail the customer paid on, when the callback says. Absent on older events,
   * which were card payments. Lets the invoice record show the real method.
   */
  paymentMethod?: "card" | "us_bank_account" | "crypto";
  amountCents: number;
  currency: string;
  refundedCents: number;
  refunds: PaymentRefundFact[];
  disputes: PaymentDisputeFact[];
  livemode: boolean;
}

export interface ApplyPaymentInput<TInvoice> {
  invoice: TInvoice;
  invoiceId: string;
  /** The verified fact. Never a browser-supplied amount. */
  payment: VerifiedPaymentFacts;
  /** Delivery identity, when this application came from a callback. */
  deliveryId: string | null;
  /** True when this payment was already recorded for the invoice. */
  alreadyRecorded: boolean;
  now: string;
}

export type PaymentApplicationStatus =
  | "applied"
  | "recorded"
  | "ignored"
  | "duplicate_delivery"
  | "duplicate_payment"
  | "unapplied"
  | "rejected";

export interface PaymentApplicationResult {
  status: PaymentApplicationStatus;
  invoiceId: string | null;
  paymentIntentId: string | null;
  reason?: string;
  changed: boolean;
}

export interface InvoiceStatusProjection {
  invoiceId: string;
  status: string;
  canPay: boolean;
  outstandingCents: number;
  currency: string;
  description: string;
  businessId: string;
}

export interface FirestoreInvoiceAdapterConfig<TInvoice extends object> {
  firestore: FirestoreLike;
  /** The only environment this adapter may touch. Required. */
  environment: "test" | "live";
  currency?: string;
  invoices: {
    collection: string;
    /** Map the field the browser sends to a document id. Defaults to the reference itself. */
    resolveId?: (reference: string) => string | null;
    /** Body field carrying the invoice reference. Defaults to "invoiceId". */
    referenceField?: string;
    /** Derived immutable payment-attempt revision. Defaults to amount + description hash. */
    revision?: (invoice: TInvoice, invoiceId: string) => InvoiceOrderRevision;
    fields: FirestoreInvoiceFieldMap;
    statuses: FirestoreInvoiceStatusMap;
  };
  /** Authorization policy. Required: a server lookup is not authorization. */
  authorize: (input: InvoiceAuthorizationInput<TInvoice>) => Promise<InvoiceAuthorization> | InvoiceAuthorization;
  payments: {
    /** One row per PaymentIntent: the durable business-effect ledger. */
    collection: string;
  };
  deliveries: {
    /** One row per callback delivery id: the durable delivery ledger. */
    collection: string;
  };
  /**
   * Apply the verified facts to the invoice. MUST be pure: no email, HTTP,
   * shipping, or entitlement calls. Return the next invoice, or null when no
   * invoice change is needed. Runs inside the Firestore transaction and may be
   * re-run on retry.
   */
  applyPayment: (input: ApplyPaymentInput<TInvoice>) => TInvoice;
  /** Optional fulfillment outbox row, written atomically with the invoice. */
  fulfillment?: {
    collection: string;
    build: (input: ApplyPaymentInput<TInvoice>) => FirestoreData | null;
  };
  /** Runs after a committed change. Keep it retry-safe; it is not transactional. */
  onApplied?: (input: ApplyPaymentInput<TInvoice>) => Promise<void> | void;
  /** Runs after a committed unapplied payment (for example, a late success on a void invoice). */
  onUnapplied?: (input: ApplyPaymentInput<TInvoice>) => Promise<void> | void;
  /** Optional safe projection returned by the status endpoint. */
  projectStatus?: (invoice: TInvoice, invoiceId: string) => Record<string, unknown>;
  now?: () => Date;
}

export interface FirestoreInvoiceAdapter<TInvoice extends object> {
  /** Pass to `glyphPay({ priceOrder })`. Authorizes, then reads authoritative pricing. */
  priceOrder: (body: unknown, req: Request) => Promise<Order>;
  /** Pass to `glyphPay({ onEvent })`. Applies only verified callback events. */
  onEvent: (event: GlyphPayEvent) => Promise<PaymentApplicationResult>;
  /** Apply a trusted reconciliation result through the same path. */
  applyVerifiedPayment: (input: VerifiedPaymentInput) => Promise<PaymentApplicationResult>;
  /** Authorized, server-derived status. A return redirect must never set this. */
  status: (input: InvoiceStatusInput) => Promise<InvoiceStatusProjection>;
  /** Deterministic order id for a revision. Exposed for reconciliation tooling. */
  orderIdFor: (invoiceId: string, invoice: TInvoice) => string;
  /** Deterministic revision for the invoice's current balance/description. */
  revisionFor: (invoiceId: string, invoice: TInvoice) => InvoiceOrderRevision;
}

export interface VerifiedPaymentInput {
  payment: VerifiedPaymentFacts;
  /** Delivery id for callbacks. Omit for reconciliation (no synthetic event id needed). */
  deliveryId?: string;
  /** Recorded for audit. Defaults to "callback" when a deliveryId is present. */
  source?: "callback" | "reconciliation";
}

export interface InvoiceStatusInput {
  /** Invoice reference from the browser. */
  reference: string;
  req: Request;
}

/* ------------------------------------------------------------------ */
/* Order-id encoding                                                   */
/* ------------------------------------------------------------------ */

const INVOICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const ORDER_ID_PATTERN = /^gp1\.([A-Za-z0-9][A-Za-z0-9_-]{0,99})\.([a-z0-9]{1,24})$/;
const PAYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const REFUND_KEY_PATTERN = /^[A-Za-z0-9_:.-]{1,160}$/;
const ORDER_PREFIX = "gp1";

export function invoiceOrderId(invoiceId: string, revision: InvoiceOrderRevision): string {
  if (!INVOICE_ID_PATTERN.test(invoiceId)) throw new Error("Invoice id is not a valid document id.");
  if (!/^[a-z0-9]{1,24}$/.test(revision)) throw new Error("Invoice revision must be 1-24 lowercase letters or digits.");
  return `${ORDER_PREFIX}.${invoiceId}.${revision}`;
}

export function parseInvoiceOrderId(orderId: string): { invoiceId: string; revision: string } | null {
  const match = ORDER_ID_PATTERN.exec(orderId);
  return match ? { invoiceId: match[1], revision: match[2] } : null;
}

/** FNV-1a, used only to detect description changes, never for security. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function defaultRevision(amountCents: number, currency: string, description: string): string {
  return `r${amountCents.toString(36)}d${fingerprint(`${currency}|${description}`)}`;
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(invoice: object, field: string): string | null {
  const value = (invoice as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function integerField(invoice: object, field: string): number | null {
  const value = (invoice as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function uniqueStatuses(statuses: FirestoreInvoiceStatusMap): string[] {
  return [...statuses.payable, ...statuses.paid, ...statuses.void, ...(statuses.processing ?? [])];
}

function validateConfig<TInvoice extends object>(config: FirestoreInvoiceAdapterConfig<TInvoice>): void {
  if (config.environment !== "test" && config.environment !== "live") {
    throw new Error("GlyphPay invoice adapter requires an explicit test or live environment.");
  }
  if (!config.invoices.collection.trim()) throw new Error("invoices.collection is required.");
  if (!config.payments.collection.trim()) throw new Error("payments.collection is required.");
  if (!config.deliveries.collection.trim()) throw new Error("deliveries.collection is required.");
  if (config.fulfillment && !config.fulfillment.collection.trim()) throw new Error("fulfillment.collection is required.");
  if (typeof config.authorize !== "function") {
    throw new Error("authorize is required: a Firestore lookup does not prove the requester may pay this invoice.");
  }
  if (typeof config.applyPayment !== "function") throw new Error("applyPayment is required.");
  for (const [name, field] of Object.entries(config.invoices.fields)) {
    if (typeof field !== "string" || !field.trim()) {
      throw new Error(`invoices.fields.${name} must name a real invoice field.`);
    }
  }
  const groups: Array<[string, readonly string[]]> = [
    ["payable", config.invoices.statuses.payable],
    ["paid", config.invoices.statuses.paid],
    ["void", config.invoices.statuses.void],
    ["processing", config.invoices.statuses.processing ?? []],
  ];
  for (const [name, values] of groups) {
    if (values.length === 0 && name !== "processing") {
      throw new Error(`invoices.statuses.${name} must list at least one invoice status.`);
    }
    if (values.some((value) => typeof value !== "string" || !value)) {
      throw new Error(`invoices.statuses.${name} must contain non-empty status strings.`);
    }
  }
  const seen = new Map<string, string>();
  for (const [name, values] of groups) {
    for (const value of values) {
      const other = seen.get(value);
      if (other && other !== name) {
        throw new Error(`Invoice status "${value}" is configured as both ${other} and ${name}; its meaning must be unambiguous.`);
      }
      seen.set(value, name);
    }
  }
}

function normalizePayment(event: GlyphPayEvent): VerifiedPaymentFacts {
  const data = event.data as unknown as Record<string, unknown>;
  const rawStatus = stringField(data, "status") ?? "processing";
  const status: VerifiedPaymentFacts["status"] =
    rawStatus === "succeeded"
      ? "succeeded"
      : rawStatus === "processing" || rawStatus === "creating"
        ? "processing"
        : rawStatus === "canceled"
          ? "canceled"
          : "failed";
  const refunds = Array.isArray(data.refunds) ? data.refunds : [];
  const disputes = Array.isArray(data.disputes) ? data.disputes : [];
  const paymentIntentId = stringField(data, "id") ?? "";
  const orderId = stringField(data, "orderId") ?? "";
  const paymentMethod = stringField(data, "paymentMethod");
  return {
    paymentIntentId,
    orderId,
    status,
    ...(paymentMethod === "card" || paymentMethod === "us_bank_account" || paymentMethod === "crypto"
      ? { paymentMethod }
      : {}),
    amountCents: integerField(data, "amountCents") ?? -1,
    currency: stringField(data, "currency") ?? "",
    refundedCents: integerField(data, "refundedCents") ?? 0,
    refunds: refunds.flatMap((raw, index) => {
      if (!isRecord(raw)) return [];
      const amountCents = integerField(raw, "amountCents");
      if (amountCents === null) return [];
      const stripeRefundId = stringField(raw, "stripeRefundId");
      const key = stripeRefundId && REFUND_KEY_PATTERN.test(stripeRefundId)
        ? stripeRefundId
        : `${paymentIntentId}:refund:${index}:${amountCents}`;
      return [{ key, amountCents, status: stringField(raw, "status") ?? "unknown" }];
    }),
    disputes: disputes.flatMap((raw, index) => {
      if (!isRecord(raw)) return [];
      const amountCents = integerField(raw, "amountCents");
      if (amountCents === null) return [];
      return [{ key: `${paymentIntentId}:dispute:${index}`, status: stringField(raw, "status") ?? "unknown", amountCents }];
    }),
    livemode: event.livemode,
  };
}

const REFUND_STATUSES = new Set(["succeeded", "pending"]);

/** Refunded total from the verified refund facts, ignoring failed/canceled refunds. */
export function verifiedRefundedTotal(payment: VerifiedPaymentFacts): number {
  const fromRefunds = payment.refunds
    .filter((refund) => REFUND_STATUSES.has(refund.status))
    .reduce((sum, refund) => sum + refund.amountCents, 0);
  return Math.max(fromRefunds, payment.refundedCents >= 0 ? payment.refundedCents : 0);
}

function sameFacts(
  stored: Record<string, unknown>,
  payment: VerifiedPaymentFacts
): boolean {
  return (
    stored.status === payment.status &&
    stored.amountCents === payment.amountCents &&
    stored.refundedCents === verifiedRefundedTotal(payment) &&
    JSON.stringify(stored.refunds ?? []) === JSON.stringify(payment.refunds) &&
    JSON.stringify(stored.disputes ?? []) === JSON.stringify(payment.disputes)
  );
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export function createFirestoreInvoiceAdapter<TInvoice extends object>(
  config: FirestoreInvoiceAdapterConfig<TInvoice>
): FirestoreInvoiceAdapter<TInvoice> {
  validateConfig(config);

  const currency = (config.currency ?? "usd").toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new Error("currency must be a lowercase three-letter ISO code.");
  const now = config.now ?? (() => new Date());
  const referenceField = config.invoices.referenceField ?? "invoiceId";
  const invoicePath = (invoiceId: string) => `${config.invoices.collection}/${invoiceId}`;
  const paymentPath = (paymentIntentId: string) => `${config.payments.collection}/${paymentIntentId}`;
  const deliveryPath = (deliveryId: string) => `${config.deliveries.collection}/${deliveryId}`;
  const fulfillmentPath = (paymentIntentId: string) => `${config.fulfillment!.collection}/${paymentIntentId}`;

  function resolveReference(reference: unknown): string | null {
    if (typeof reference !== "string") return null;
    const trimmed = reference.trim();
    if (!trimmed) return null;
    const resolved = config.invoices.resolveId ? config.invoices.resolveId(trimmed) : trimmed;
    return resolved && INVOICE_ID_PATTERN.test(resolved) ? resolved : null;
  }

  function revisionFor(invoiceId: string, invoice: TInvoice): InvoiceOrderRevision {
    const revision = config.invoices.revision
      ? config.invoices.revision(invoice, invoiceId)
      : defaultRevision(
          integerField(invoice, config.invoices.fields.outstandingCents) ?? 0,
          stringField(invoice, config.invoices.fields.currency) ?? currency,
          stringField(invoice, config.invoices.fields.description) ?? ""
        );
    if (!/^[a-z0-9]{1,24}$/.test(revision)) {
      throw new Error("invoices.revision must return 1-24 lowercase letters or digits.");
    }
    return revision;
  }

  function orderIdFor(invoiceId: string, invoice: TInvoice): string {
    return invoiceOrderId(invoiceId, revisionFor(invoiceId, invoice));
  }

  async function readInvoice(invoiceId: string): Promise<TInvoice | null> {
    const snapshot = await config.firestore.doc(invoicePath(invoiceId)).get();
    if (!snapshot.exists) return null;
    return (snapshot.data() ?? {}) as unknown as TInvoice;
  }

  function statusOf(invoice: TInvoice): string | null {
    return stringField(invoice, config.invoices.fields.status);
  }

  async function authorizedInvoice(
    reference: unknown,
    body: FirestoreData,
    req: Request
  ): Promise<{ invoiceId: string; invoice: TInvoice; authorization: InvoiceAuthorization }> {
    const invoiceId = resolveReference(reference);
    if (!invoiceId) throw new CheckoutError("That invoice reference is not valid.");
    const invoice = await readInvoice(invoiceId);
    if (!invoice) throw new CheckoutError("Invoice not found.", 404);
    const authorization = await config.authorize({ invoiceId, invoice, body, req });
    return { invoiceId, invoice, authorization };
  }

  async function priceOrder(body: unknown, req: Request): Promise<Order> {
    const record = isRecord(body) ? body : {};
    const reference = record[referenceField];
    const { invoiceId, invoice, authorization } = await authorizedInvoice(reference, record, req);
    if (!authorization.allowed) {
      throw new CheckoutError(
        authorization.message ?? "You are not authorized to pay this invoice.",
        authorization.status ?? 403
      );
    }

    const environment = stringField(invoice, config.invoices.fields.environment);
    if (environment !== config.environment) throw new CheckoutError("This invoice cannot be paid in this environment.");
    const invoiceCurrency = stringField(invoice, config.invoices.fields.currency);
    if (!invoiceCurrency || invoiceCurrency.toLowerCase() !== currency) {
      throw new CheckoutError("This invoice uses a currency this checkout does not support.");
    }

    const status = statusOf(invoice);
    if (!status) throw new CheckoutError("This invoice is unavailable.");
    if (config.invoices.statuses.payable.includes(status)) {
      // payable
    } else if (config.invoices.statuses.paid.includes(status)) {
      throw new CheckoutError("This invoice has already been paid.");
    } else if (config.invoices.statuses.void.includes(status)) {
      throw new CheckoutError("This invoice is no longer payable.");
    } else if ((config.invoices.statuses.processing ?? []).includes(status)) {
      throw new CheckoutError("A payment for this invoice is already processing.");
    } else {
      throw new CheckoutError("This invoice is not currently payable.");
    }

    const amountCents = integerField(invoice, config.invoices.fields.outstandingCents);
    if (amountCents === null || amountCents <= 0) throw new CheckoutError("This invoice has no balance due.");

    // The rail is the shopper's choice; the amount is always the invoice's. An
    // unknown value falls back to card so older checkouts keep working.
    const requestedMethod = record.paymentMethod;
    const paymentMethod: PaymentMethod =
      requestedMethod === "us_bank_account" || requestedMethod === "crypto" ? requestedMethod : "card";
    // GlyphPay identifies one payment by order id and rejects reusing it with a
    // different rail. Non-card rails therefore get their own revision; card
    // keeps the existing id so accounting and reconciliation links stay put.
    const orderId =
      paymentMethod === "card"
        ? orderIdFor(invoiceId, invoice)
        : invoiceOrderId(
            invoiceId,
            `r${fingerprint(`rail|${revisionFor(invoiceId, invoice)}|${paymentMethod}`)}`
          );

    const description = stringField(invoice, config.invoices.fields.description) ?? "";
    return {
      orderId,
      amountCents,
      description: description.trim() || `Invoice ${invoiceId}`,
      paymentMethod,
    };
  }

  async function applyVerifiedPayment(input: VerifiedPaymentInput): Promise<PaymentApplicationResult> {
    const { payment } = input;
    const base: PaymentApplicationResult = {
      status: "rejected",
      invoiceId: null,
      paymentIntentId: null,
      changed: false,
    };

    if (payment.livemode !== (config.environment === "live")) {
      return { ...base, reason: "environment_mismatch" };
    }
    if (!PAYMENT_ID_PATTERN.test(payment.paymentIntentId)) return { ...base, reason: "invalid_payment_id" };
    if (
      !Number.isSafeInteger(payment.amountCents) ||
      payment.amountCents < 0 ||
      (payment.status === "succeeded" && payment.amountCents <= 0)
    ) {
      return { ...base, reason: "invalid_amount" };
    }
    const parsedOrder = parseInvoiceOrderId(payment.orderId);
    if (!parsedOrder) return { ...base, reason: "invalid_order_id" };
    if (payment.currency.toLowerCase() !== currency) return { ...base, reason: "currency_mismatch" };

    const deliveryId = input.deliveryId ?? null;
    if (deliveryId !== null && !PAYMENT_ID_PATTERN.test(deliveryId)) return { ...base, reason: "invalid_delivery_id" };

    const result = await config.firestore.runTransaction(async (tx) => {
      // Every read happens before the first write (a Firestore requirement).
      const deliverySnapshot = deliveryId !== null ? await tx.get(config.firestore.doc(deliveryPath(deliveryId))) : null;
      const invoiceReference = config.firestore.doc(invoicePath(parsedOrder.invoiceId));
      const invoiceSnapshot = await tx.get(invoiceReference);
      const paymentReference = config.firestore.doc(paymentPath(payment.paymentIntentId));
      const paymentSnapshot = await tx.get(paymentReference);
      const fulfillmentReference = config.fulfillment
        ? config.firestore.doc(fulfillmentPath(payment.paymentIntentId))
        : null;
      const fulfillmentSnapshot = fulfillmentReference ? await tx.get(fulfillmentReference) : null;

      const recordDelivery = (state: string, reason?: string): void => {
        if (!deliveryId) return;
        tx.create(config.firestore.doc(deliveryPath(deliveryId)), {
          id: deliveryId,
          source: input.source ?? "callback",
          state,
          ...(reason ? { reason } : {}),
          invoiceId: parsedOrder.invoiceId,
          paymentIntentId: payment.paymentIntentId,
          createdAt: now().toISOString(),
        });
      };

      if (deliverySnapshot?.exists) {
        return { ...base, invoiceId: parsedOrder.invoiceId, status: "duplicate_delivery", reason: "delivery_already_recorded" } as PaymentApplicationResult;
      }
      if (!invoiceSnapshot.exists) {
        recordDelivery("orphaned", "invoice_not_found");
        return { ...base, invoiceId: parsedOrder.invoiceId, status: "ignored", reason: "invoice_not_found" } as PaymentApplicationResult;
      }

      const invoice = (invoiceSnapshot.data() ?? {}) as unknown as TInvoice;
      const invoiceEnvironment = stringField(invoice, config.invoices.fields.environment);
      if (invoiceEnvironment !== config.environment) {
        recordDelivery("rejected_environment", "invoice_environment_mismatch");
        return { ...base, invoiceId: parsedOrder.invoiceId, status: "rejected", reason: "invoice_environment_mismatch" } as PaymentApplicationResult;
      }
      const invoiceCurrency = stringField(invoice, config.invoices.fields.currency);
      if (!invoiceCurrency || invoiceCurrency.toLowerCase() !== payment.currency.toLowerCase()) {
        recordDelivery("rejected_currency", "currency_mismatch");
        return { ...base, invoiceId: parsedOrder.invoiceId, status: "rejected", reason: "currency_mismatch" } as PaymentApplicationResult;
      }

      const stored = paymentSnapshot.exists ? paymentSnapshot.data() ?? {} : null;
      const alreadyRecorded = stored !== null;
      const storedApplied = stored ? stored.applied === true && stored.status === "succeeded" : false;
      const incomingSucceeded = payment.status === "succeeded";

      if (storedApplied && !incomingSucceeded) {
        // Never downgrade a settled payment because a late failure arrived.
        recordDelivery("ignored", "terminal_payment_kept");
        return { ...base, invoiceId: parsedOrder.invoiceId, status: "duplicate_payment", reason: "terminal_payment_kept" } as PaymentApplicationResult;
      }
      if (storedApplied && incomingSucceeded && sameFacts(stored!, payment)) {
        recordDelivery("duplicate");
        return { ...base, invoiceId: parsedOrder.invoiceId, status: "duplicate_payment", reason: "payment_already_recorded" } as PaymentApplicationResult;
      }

      const status = statusOf(invoice) ?? "";
      // A refund or dispute fact for a payment that is already credited must
      // still be applied, even though the invoice is now paid in full.
      const creditAlreadyApplied = storedApplied;
      let unappliedReason: string | null = null;
      if (incomingSucceeded && !creditAlreadyApplied) {
        if (config.invoices.statuses.void.includes(status)) unappliedReason = "invoice_void";
        else if (config.invoices.statuses.paid.includes(status)) unappliedReason = "invoice_already_paid";
        else if (!config.invoices.statuses.payable.includes(status) && !(config.invoices.statuses.processing ?? []).includes(status)) {
          return { ...base, invoiceId: parsedOrder.invoiceId, status: "rejected", reason: "invoice_status_unknown" } as PaymentApplicationResult;
        }
      }

      const applicationInput: ApplyPaymentInput<TInvoice> = {
        invoice,
        invoiceId: parsedOrder.invoiceId,
        payment,
        deliveryId,
        alreadyRecorded,
        now: now().toISOString(),
      };
      const applied = incomingSucceeded && (creditAlreadyApplied || unappliedReason === null);
      let changed = false;
      if (applied || unappliedReason === null) {
        // Non-settling facts (processing/failed/canceled) are still offered to
        // the domain ledger so it can record an attempt or derive its own
        // status. They are never reported as applied credit.
        const next = config.applyPayment(applicationInput);
        if (next && JSON.stringify(next) !== JSON.stringify(invoice)) {
          tx.set(invoiceReference, next as FirestoreData);
          changed = true;
        }
      }

      tx.set(paymentReference, {
        paymentIntentId: payment.paymentIntentId,
        invoiceId: parsedOrder.invoiceId,
        orderId: payment.orderId,
        status: incomingSucceeded ? "succeeded" : payment.status,
        applied,
        ...(unappliedReason ? { unappliedReason } : {}),
        amountCents: payment.amountCents,
        currency: payment.currency,
        refundedCents: verifiedRefundedTotal(payment),
        refunds: payment.refunds,
        disputes: payment.disputes,
        lastDeliveryId: deliveryId,
        updatedAt: applicationInput.now,
        ...(stored ? { firstRecordedAt: stored.firstRecordedAt ?? applicationInput.now } : { firstRecordedAt: applicationInput.now }),
      });
      changed = true;

      if (applied && config.fulfillment && fulfillmentReference && !fulfillmentSnapshot?.exists) {
        const row = config.fulfillment.build(applicationInput);
        if (row) {
          tx.create(fulfillmentReference, {
            ...row,
            paymentIntentId: payment.paymentIntentId,
            invoiceId: parsedOrder.invoiceId,
            createdAt: applicationInput.now,
          });
        }
      }

      const outcome: PaymentApplicationStatus = unappliedReason
        ? "unapplied"
        : applied
          ? "applied"
          : "recorded";
      recordDelivery(outcome, unappliedReason ?? undefined);
      return {
        status: outcome,
        invoiceId: parsedOrder.invoiceId,
        paymentIntentId: payment.paymentIntentId,
        ...(unappliedReason ? { reason: unappliedReason } : {}),
        changed,
        applicationInput,
      } as PaymentApplicationResult & { applicationInput: ApplyPaymentInput<TInvoice> };
    });

    const application = (result as PaymentApplicationResult & { applicationInput?: ApplyPaymentInput<TInvoice> }).applicationInput;
    if (application) {
      // External effects run only after a successful commit. A hook failure must
      // not make the delivery fail (the ledger is already correct); a durable
      // outbox is the way to guarantee delivery.
      const hook = result.status === "unapplied" ? config.onUnapplied : config.onApplied;
      if (hook && (result.status === "applied" || result.status === "unapplied")) {
        try {
          await hook(application);
        } catch (error) {
          console.error("GlyphPay invoice hook failed:", error instanceof Error ? error.message : error);
        }
      }
    }
    const { applicationInput: _omit, ...clean } = result as PaymentApplicationResult & { applicationInput?: unknown };
    return clean;
  }

  async function status(input: InvoiceStatusInput): Promise<InvoiceStatusProjection> {
    const reference = input.reference;
    const invoiceId = resolveReference(reference);
    if (!invoiceId) throw new CheckoutError("That invoice reference is not valid.");
    const invoice = await readInvoice(invoiceId);
    if (!invoice) throw new CheckoutError("Invoice not found.", 404);
    const authorization = await config.authorize({ invoiceId, invoice, body: { [referenceField]: reference }, req: input.req });
    if (!authorization.allowed) {
      throw new CheckoutError(
        authorization.message ?? "You are not authorized to view this invoice.",
        authorization.status ?? 403
      );
    }
    const status = statusOf(invoice) ?? "unknown";
    return {
      invoiceId,
      status,
      canPay:
        config.invoices.statuses.payable.includes(status) &&
        (integerField(invoice, config.invoices.fields.outstandingCents) ?? 0) > 0,
      outstandingCents: integerField(invoice, config.invoices.fields.outstandingCents) ?? 0,
      currency: stringField(invoice, config.invoices.fields.currency) ?? currency,
      description: stringField(invoice, config.invoices.fields.description) ?? "",
      businessId: stringField(invoice, config.invoices.fields.businessId) ?? "",
      ...(config.projectStatus ? config.projectStatus(invoice, invoiceId) : {}),
    };
  }

  return {
    priceOrder,
    applyVerifiedPayment,
    orderIdFor,
    revisionFor,
    status,
    onEvent: async (event) => {
      // Diagnostic events must never touch an invoice, balance, or fulfillment.
      if (event.type === "webhook.test") {
        return { status: "ignored", invoiceId: null, paymentIntentId: null, reason: "diagnostic_event", changed: false };
      }
      return applyVerifiedPayment({
        payment: normalizePayment(event),
        deliveryId: event.id,
        source: "callback",
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Firebase HTTPS request adapter                                      */
/* ------------------------------------------------------------------ */

export interface FirebaseHttpsRequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  protocol?: string;
  headers?: Record<string, string | string[] | undefined>;
  rawBody?: Uint8Array;
  body?: unknown;
  get?(name: string): string | undefined;
}

export interface FirebaseHttpsResponseLike {
  status(code: number): void;
  setHeader(name: string, value: string): void;
  send(body?: Uint8Array): void;
  end?(body?: string): void;
}

export interface FirebaseHttpsRoutes {
  checkout?: string;
  webhook?: string;
  status?: string;
}

export interface FirebaseHttpsHandlerOptions {
  checkout?: (req: Request) => Promise<Response>;
  webhook?: (req: Request) => Promise<Response>;
  status?: (req: Request) => Promise<Response>;
  routes?: FirebaseHttpsRoutes;
}

export const DEFAULT_FIREBASE_ROUTES: Required<FirebaseHttpsRoutes> = {
  checkout: "/api/glyphpay/checkout",
  webhook: "/api/glyphpay/webhook",
  status: "/api/glyphpay/status",
};

function headerOf(req: FirebaseHttpsRequestLike, name: string): string | undefined {
  if (typeof req.get === "function") {
    const value = req.get(name);
    if (typeof value === "string") return value;
  }
  const raw = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

function requestBodyBytes(req: FirebaseHttpsRequestLike, isWebhook: boolean): Uint8Array | undefined {
  if (isWebhook) {
    // Signed payloads must be verified against the wire bytes Firebase attached.
    if (!(req.rawBody instanceof Uint8Array) || req.rawBody.byteLength === 0) {
      throw new Error("Firebase did not expose req.rawBody; the webhook signature cannot be verified safely.");
    }
    return req.rawBody;
  }
  if (req.rawBody instanceof Uint8Array && req.rawBody.byteLength > 0) return req.rawBody;
  if (typeof req.body === "string") return new TextEncoder().encode(req.body);
  if (req.body instanceof Uint8Array) return req.body;
  if (req.body === undefined || req.body === null) return undefined;
  return new TextEncoder().encode(JSON.stringify(req.body));
}

/**
 * Adapts Firebase `onRequest` (v2) to the connector's two route handlers.
 * - Preserves `req.rawBody` for webhook signature verification (never
 *   re-serializes parsed JSON).
 * - Builds the public origin from forwarded headers so checkout Origin checks
 *   see the site's origin behind Hosting.
 * - Returns 404 for unknown paths; it never falls through to a generic proxy.
 */
export function createFirebaseHttpsHandler(
  options: FirebaseHttpsHandlerOptions
): (req: FirebaseHttpsRequestLike, res: FirebaseHttpsResponseLike) => Promise<void> {
  const routes = { ...DEFAULT_FIREBASE_ROUTES, ...(options.routes ?? {}) };
  return async (req, res) => {
    const rawUrl = req.originalUrl ?? req.url ?? "/";
    let parsed: URL;
    try {
      parsed = new URL(rawUrl, "https://placeholder.invalid");
    } catch {
      res.status(400);
      res.send(new TextEncoder().encode("Bad request"));
      return;
    }
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const kind =
      path === routes.checkout.replace(/\/+$/, "")
        ? "checkout"
        : path === routes.webhook.replace(/\/+$/, "")
          ? "webhook"
          : path === routes.status.replace(/\/+$/, "")
            ? "status"
            : null;
    if (!kind) {
      res.status(404);
      res.send(new TextEncoder().encode("Not found"));
      return;
    }
    const handler = options[kind];
    if (!handler) {
      res.status(404);
      res.send(new TextEncoder().encode("Not found"));
      return;
    }

    const protocol = headerOf(req, "x-forwarded-proto")?.split(",")[0].trim() || "https";
    const host = headerOf(req, "x-forwarded-host")?.split(",")[0].trim() || headerOf(req, "host");
    if (!host) {
      res.status(500);
      res.send(new TextEncoder().encode("Cannot determine request host."));
      return;
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      if (value === undefined) continue;
      for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
    }
    if (!headers.has("host")) headers.set("host", host);

    const method = (req.method ?? "GET").toUpperCase();
    let body: Uint8Array | undefined;
    try {
      body = requestBodyBytes(req, kind === "webhook");
    } catch (error) {
      res.status(500);
      res.send(new TextEncoder().encode(error instanceof Error ? error.message : "Missing raw body"));
      return;
    }

    const request = new Request(`${protocol}://${host}${parsed.pathname}${parsed.search}`, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" || !body ? {} : { body: new Uint8Array(body) }),
    });

    try {
      const response = await handler(request);
      res.status(response.status);
      response.headers.forEach((value, name) => res.setHeader(name, value));
      res.send(new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      console.error(`GlyphPay ${kind} handler failed:`, error instanceof Error ? error.message : error);
      res.status(500);
      res.send(new TextEncoder().encode("Handler failed"));
    }
  };
}
