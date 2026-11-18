import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFirestoreInvoiceAdapter,
  invoiceOrderId,
  parseInvoiceOrderId,
} from "../dist/firebase.js";
import { CheckoutError } from "../dist/server.js";

/* ------------------------------------------------------------------ */
/* Firestore double with optimistic concurrency + read-before-write    */
/* ------------------------------------------------------------------ */

class MemoryFirestore {
  constructor() {
    this.docs = new Map();
    this.version = 0;
    this.contendOnce = false;
  }
  snapshot(path) {
    const data = this.docs.get(path);
    return {
      exists: data !== undefined,
      id: path.split("/").pop(),
      data: () => (data === undefined ? undefined : structuredClone(data)),
    };
  }
  doc(path) {
    const store = this;
    return {
      id: path.split("/").pop(),
      path,
      get: async () => store.snapshot(path),
    };
  }
  async runTransaction(fn) {
    let lastError;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const startVersion = this.version;
      const writes = [];
      let writeStarted = false;
      const tx = {
        get: async (reference) => {
          if (writeStarted) throw new Error("Firestore transactions must read before writing.");
          await Promise.resolve();
          return this.snapshot(reference.path);
        },
        create: (reference, data) => {
          writeStarted = true;
          if (this.docs.has(reference.path)) {
            const error = new Error("ALREADY_EXISTS");
            error.code = 6;
            throw error;
          }
          writes.push({ path: reference.path, data: structuredClone(data) });
        },
        set: (reference, data) => {
          writeStarted = true;
          writes.push({ path: reference.path, data: structuredClone(data) });
        },
      };
      try {
        const result = await fn(tx);
        // Simulate a competing writer between read and commit exactly once.
        await Promise.resolve();
        if (this.contendOnce) {
          this.contendOnce = false;
          this.version += 1;
          continue;
        }
        if (this.version !== startVersion) continue;
        for (const write of writes) this.docs.set(write.path, write.data);
        this.version += 1;
        return result;
      } catch (error) {
        lastError = error;
        throw error;
      }
    }
    throw lastError ?? new Error("Transaction retries exhausted.");
  }
}

/* ------------------------------------------------------------------ */
/* Invoice fixture + explicit ledger                                   */
/* ------------------------------------------------------------------ */

const FIELDS = {
  outstandingCents: "amountRemainingCents",
  description: "description",
  status: "status",
  currency: "currency",
  businessId: "businessId",
  environment: "environment",
};

function invoice(overrides = {}) {
  return {
    id: "inv_petal_1",
    businessId: "biz_petal",
    environment: "test",
    status: "open",
    currency: "usd",
    description: "October maintenance retainer",
    totalCents: 5000,
    amountPaidCents: 0,
    amountRemainingCents: 5000,
    payments: [],
    refunds: [],
    disputes: [],
    ...overrides,
  };
}

/** Pure ledger used by the adapter; mirrors Design Glyph's recomputeInvoice rules. */
function applyInvoicePayment({ invoice: current, payment }) {
  const payments = (current.payments || []).filter((p) => p.key !== payment.paymentIntentId);
  if (payment.status === "succeeded" || payment.status === "processing" || payment.status === "failed") {
    payments.push({
      key: payment.paymentIntentId,
      status: payment.status,
      amountCents: payment.amountCents,
      currency: payment.currency,
    });
  }
  const paid = payments
    .filter((p) => p.status === "succeeded")
    .reduce((sum, p) => sum + p.amountCents, 0);
  const refunds = (current.refunds || []).filter((r) => !payment.refunds.some((incoming) => incoming.key === r.key));
  for (const refund of payment.refunds) refunds.push({ ...refund });
  const refunded = refunds
    .filter((r) => r.status === "succeeded" || r.status === "pending")
    .reduce((sum, r) => sum + r.amountCents, 0);
  const disputes = (current.disputes || []).filter(
    (d) => !payment.disputes.some((incoming) => incoming.key === d.key)
  );
  for (const dispute of payment.disputes) disputes.push({ ...dispute });

  const remaining = Math.max(0, current.totalCents - paid);
  const status = paid >= current.totalCents
    ? refunded >= paid
      ? "refunded"
      : refunded > 0
        ? "partially_refunded"
        : "paid"
    : "open";
  return {
    ...current,
    payments,
    refunds,
    disputes,
    amountPaidCents: paid,
    amountRemainingCents: remaining,
    status,
  };
}

function makeAdapter(config = {}) {
  const db = config.db ?? new MemoryFirestore();
  const hooks = { applied: 0, unapplied: 0, events: [] };
  const adapter = createFirestoreInvoiceAdapter({
    firestore: db,
    environment: "test",
    invoices: {
      collection: "invoices",
      fields: FIELDS,
      statuses: {
        payable: ["open", "failed"],
        paid: ["paid", "partially_refunded", "refunded"],
        void: ["canceled"],
        processing: ["processing"],
      },
      ...(config.invoices ?? {}),
    },
    authorize:
      config.authorize ??
      (({ invoice: current, body, req }) => {
        if (body.capability === "valid" && current.businessId === "biz_petal") return { allowed: true };
        if (req.headers.get("x-member") === current.businessId) return { allowed: true };
        return { allowed: false, status: 403 };
      }),
    payments: { collection: "glyphpay_payments" },
    deliveries: { collection: "glyphpay_deliveries" },
    applyPayment: config.applyPayment ?? applyInvoicePayment,
    fulfillment:
      config.fulfillment === null
        ? undefined
        : {
            collection: "glyphpay_fulfillment",
            build: ({ invoiceId }) => ({ invoiceId, kind: "receipt" }),
          },
    onApplied: (input) => {
      hooks.applied += 1;
      hooks.events.push(["applied", input.payment.paymentIntentId, input.payment.status]);
    },
    onUnapplied: (input) => {
      hooks.unapplied += 1;
      hooks.events.push(["unapplied", input.payment.paymentIntentId, input.payment.status]);
    },
    now: () => new Date("2026-11-08T12:00:00Z"),
  });
  return { db, adapter, hooks };
}

async function seed(db, record) {
  db.docs.set(`invoices/${record.id}`, structuredClone(record));
}

function callback(adapter, record, overrides = {}) {
  return {
    id: "evt_1",
    type: "payment.succeeded",
    createdAt: "2026-11-08T12:00:00.000Z",
    livemode: false,
    data: {
      id: "pi_1",
      orderId: adapter.orderIdFor(record.id, record),
      status: "succeeded",
      amountCents: record.amountRemainingCents,
      applicationFeeCents: 1,
      currency: "usd",
      refundedCents: 0,
      refunds: [],
      disputes: [],
      stale: false,
      updatedAt: "2026-11-08T12:00:00.000Z",
    },
    ...overrides,
  };
}

const request = (headers = {}) => new Request("https://site.example/api/glyphpay/checkout", { method: "POST", headers });

/* ------------------------------------------------------------------ */
/* Pricing and authorization                                           */
/* ------------------------------------------------------------------ */

test("priceOrder requires an invoice reference, then authorizes before pricing", async () => {
  const { db, adapter } = makeAdapter();
  await seed(db, invoice());

  await assert.rejects(adapter.priceOrder({}, request()), (error) => {
    assert.ok(error instanceof CheckoutError);
    assert.equal(error.status, 400);
    assert.match(error.message, /invoice reference/i);
    return true;
  });
  await assert.rejects(adapter.priceOrder({ invoiceId: "../secrets" }, request()), /not valid/);

  const unauthorized = await adapter.priceOrder({ invoiceId: "inv_petal_1" }, request()).catch((error) => error);
  assert.ok(unauthorized instanceof CheckoutError);
  assert.equal(unauthorized.status, 403);
  assert.doesNotMatch(unauthorized.message, /retainer|5000/);

  const order = await adapter.priceOrder({ invoiceId: "inv_petal_1" }, request({ "x-member": "biz_petal" }));
  assert.equal(order.amountCents, 5000);
  assert.equal(order.description, "October maintenance retainer");
  assert.match(order.orderId, /^gp1\.inv_petal_1\.[a-z0-9]+$/);
});

test("priceOrder carries the shopper's rail and gives each rail its own order identity", async () => {
  const { db, adapter } = makeAdapter();
  const base = invoice();
  await seed(db, base);
  const member = request({ "x-member": "biz_petal" });

  const card = await adapter.priceOrder({ invoiceId: base.id }, member);
  const crypto = await adapter.priceOrder({ invoiceId: base.id, paymentMethod: "crypto" }, member);
  const bank = await adapter.priceOrder(
    { invoiceId: base.id, paymentMethod: "us_bank_account" },
    member
  );

  assert.equal(card.paymentMethod, "card");
  assert.equal(crypto.paymentMethod, "crypto");
  assert.equal(bank.paymentMethod, "us_bank_account");
  assert.notEqual(crypto.orderId, card.orderId);
  assert.notEqual(bank.orderId, card.orderId);
  assert.match(crypto.orderId, /^gp1\.inv_petal_1\.[a-z0-9]{1,24}$/);
  assert.deepEqual(parseInvoiceOrderId(crypto.orderId), {
    invoiceId: base.id,
    revision: crypto.orderId.split(".")[2],
  });

  const unknown = await adapter.priceOrder(
    { invoiceId: base.id, paymentMethod: "bitcoin" },
    member
  );
  assert.equal(unknown.paymentMethod, "card");
  assert.equal(unknown.orderId, card.orderId);
});

test("priceOrder rejects missing, paid, void, processing and changed-balance invoices", async () => {
  const { db, adapter } = makeAdapter();
  await seed(db, invoice({ id: "paid", status: "paid" }));
  await seed(db, invoice({ id: "void", status: "canceled" }));
  await seed(db, invoice({ id: "processing", status: "processing" }));
  await seed(db, invoice({ id: "zero", amountRemainingCents: 0 }));

  const member = request({ "x-member": "biz_petal" });
  await assert.rejects(adapter.priceOrder({ invoiceId: "missing" }, member), (error) => error.status === 404);
  await assert.rejects(adapter.priceOrder({ invoiceId: "paid" }, member), /already been paid/);
  await assert.rejects(adapter.priceOrder({ invoiceId: "void" }, member), /no longer payable/);
  await assert.rejects(adapter.priceOrder({ invoiceId: "processing" }, member), /already processing/);
  await assert.rejects(adapter.priceOrder({ invoiceId: "zero" }, member), /no balance due/);
});

test("a changed amount or description changes the payment identity; an unchanged invoice is stable", async () => {
  const { db, adapter } = makeAdapter();
  const base = invoice();
  await seed(db, base);

  const first = adapter.priceOrder({ invoiceId: base.id }, request({ "x-member": "biz_petal" }));
  const again = adapter.priceOrder({ invoiceId: base.id }, request({ "x-member": "biz_petal" }));
  assert.equal((await first).orderId, (await again).orderId);

  const cheaper = invoice({ amountRemainingCents: 2500, amountPaidCents: 2500 });
  const changedOrder = adapter.orderIdFor(base.id, cheaper);
  assert.notEqual((await first).orderId, changedOrder);

  const renamed = invoice({ description: "November retainer" });
  assert.notEqual(adapter.orderIdFor(base.id, base), adapter.orderIdFor(base.id, renamed));

  assert.deepEqual(parseInvoiceOrderId(changedOrder), {
    invoiceId: base.id,
    revision: changedOrder.split(".")[2],
  });
  assert.equal(parseInvoiceOrderId("pi_1"), null);
  assert.throws(() => invoiceOrderId("../x", "r1"), /document id/);
  assert.equal(invoiceOrderId("inv_petal_1", "r123dabc"), "gp1.inv_petal_1.r123dabc");
});

test("a custom revision callback must return a safe revision", () => {
  const adapter = createFirestoreInvoiceAdapter({
    firestore: new MemoryFirestore(),
    environment: "test",
    invoices: {
      collection: "invoices",
      fields: FIELDS,
      statuses: { payable: ["open"], paid: ["paid"], void: ["canceled"] },
      revision: () => "../../bad",
    },
    authorize: () => ({ allowed: true }),
    payments: { collection: "payments" },
    deliveries: { collection: "deliveries" },
    applyPayment: applyInvoicePayment,
  });
  assert.throws(() => adapter.orderIdFor("inv", invoice()), /revision/);
});

/* ------------------------------------------------------------------ */
/* Durable application                                                 */
/* ------------------------------------------------------------------ */

test("a verified success credits the invoice once and enqueues one fulfillment row", async () => {
  const { db, adapter, hooks } = makeAdapter();
  const record = invoice();
  await seed(db, record);

  const result = await adapter.onEvent(callback(adapter, record));
  assert.equal(result.status, "applied");
  assert.equal(result.changed, true);
  assert.equal(hooks.applied, 1);

  const updated = db.docs.get(`invoices/${record.id}`);
  assert.equal(updated.amountPaidCents, 5000);
  assert.equal(updated.amountRemainingCents, 0);
  assert.equal(updated.status, "paid");

  assert.equal(db.docs.get("glyphpay_payments/pi_1").applied, true);
  assert.equal(db.docs.get("glyphpay_deliveries/evt_1").state, "applied");
  assert.ok(db.docs.get("glyphpay_fulfillment/pi_1"));
});

test("a duplicate delivery is acknowledged without touching the invoice or fulfillment", async () => {
  const { db, adapter, hooks } = makeAdapter();
  const record = invoice();
  await seed(db, record);
  const event = callback(adapter, record);

  assert.equal((await adapter.onEvent(event)).status, "applied");
  const afterFirst = structuredClone(db.docs.get(`invoices/${record.id}`));

  const duplicate = await adapter.onEvent(event);
  assert.equal(duplicate.status, "duplicate_delivery");
  assert.deepEqual(db.docs.get(`invoices/${record.id}`), afterFirst);
  assert.equal(hooks.applied, 1);
  assert.equal([...db.docs.keys()].filter((path) => path.startsWith("glyphpay_fulfillment/")).length, 1);
});

test("the same payment under a different event id cannot credit or fulfill twice", async () => {
  const { db, adapter, hooks } = makeAdapter();
  const record = invoice();
  await seed(db, record);

  assert.equal((await adapter.onEvent(callback(adapter, record))).status, "applied");
  const duplicate = await adapter.onEvent(callback(adapter, record, { id: "evt_2" }));
  assert.equal(duplicate.status, "duplicate_payment");

  const updated = db.docs.get(`invoices/${record.id}`);
  assert.equal(updated.amountPaidCents, 5000);
  assert.equal(updated.payments.length, 1);
  assert.equal(hooks.applied, 1);
  assert.ok(db.docs.get("glyphpay_deliveries/evt_2"));
});

test("reconciliation results use the same application path without a synthetic event id", async () => {
  const { db, adapter, hooks } = makeAdapter();
  const record = invoice();
  await seed(db, record);

  const applied = await adapter.applyVerifiedPayment({
    payment: {
      paymentIntentId: "pi_reconciled",
      orderId: adapter.orderIdFor(record.id, record),
      status: "succeeded",
      amountCents: 5000,
      currency: "usd",
      refundedCents: 0,
      refunds: [],
      disputes: [],
      livemode: false,
    },
    source: "reconciliation",
  });
  assert.equal(applied.status, "applied");
  assert.equal(hooks.applied, 1);
  assert.equal(db.docs.get(`invoices/${record.id}`).status, "paid");

  const replay = await adapter.applyVerifiedPayment({
    payment: {
      paymentIntentId: "pi_reconciled",
      orderId: adapter.orderIdFor(record.id, record),
      status: "succeeded",
      amountCents: 5000,
      currency: "usd",
      refundedCents: 0,
      refunds: [],
      disputes: [],
      livemode: false,
    },
    source: "reconciliation",
  });
  assert.equal(replay.status, "duplicate_payment");
  assert.equal(db.docs.get(`invoices/${record.id}`).amountPaidCents, 5000);
});

test("out-of-order failures and processing events never downgrade a settled payment", async () => {
  const { db, adapter } = makeAdapter();
  const record = invoice();
  await seed(db, record);

  const processing = callback(adapter, record, {
    id: "evt_processing",
    type: "payment.processing",
    data: { ...callback(adapter, record).data, id: "pi_1", status: "processing" },
  });
  assert.equal((await adapter.onEvent(processing)).status, "recorded");
  assert.equal(db.docs.get(`invoices/${record.id}`).status, "open");
  assert.equal(db.docs.get("glyphpay_payments/pi_1").status, "processing");

  assert.equal((await adapter.onEvent(callback(adapter, record, { id: "evt_succeeded" }))).status, "applied");

  const lateFailure = callback(adapter, record, {
    id: "evt_late_failure",
    type: "payment.failed",
    data: { ...callback(adapter, record).data, id: "pi_1", status: "failed" },
  });
  assert.equal((await adapter.onEvent(lateFailure)).status, "duplicate_payment");
  const updated = db.docs.get(`invoices/${record.id}`);
  assert.equal(updated.status, "paid");
  assert.equal(updated.amountPaidCents, 5000);
  assert.equal(db.docs.get("glyphpay_payments/pi_1").status, "succeeded");
});

test("refunds and disputes record facts without re-crediting or re-fulfilling", async () => {
  const { db, adapter, hooks } = makeAdapter();
  const record = invoice();
  await seed(db, record);
  await adapter.onEvent(callback(adapter, record));

  const refundEvent = callback(adapter, record, {
    id: "evt_refund",
    type: "payment.refund_updated",
    data: {
      ...callback(adapter, record).data,
      refundedCents: 1500,
      refunds: [{ stripeRefundId: "re_1", amountCents: 1500, status: "succeeded" }],
    },
  });
  assert.equal((await adapter.onEvent(refundEvent)).status, "applied");
  let updated = db.docs.get(`invoices/${record.id}`);
  assert.equal(updated.refunds.length, 1);
  assert.equal(updated.status, "partially_refunded");
  assert.equal(updated.amountPaidCents, 5000);

  const disputeEvent = callback(adapter, record, {
    id: "evt_dispute",
    type: "payment.dispute_updated",
    data: {
      ...callback(adapter, record).data,
      refunds: [{ stripeRefundId: "re_1", amountCents: 1500, status: "succeeded" }],
      refundedCents: 1500,
      disputes: [{ status: "needs_response", amountCents: 5000 }],
    },
  });
  assert.equal((await adapter.onEvent(disputeEvent)).status, "applied");
  updated = db.docs.get(`invoices/${record.id}`);
  assert.equal(updated.disputes.length, 1);
  assert.equal(updated.status, "partially_refunded");
  assert.equal(updated.amountPaidCents, 5000);
  assert.equal(hooks.applied, 3);
  assert.equal([...db.docs.keys()].filter((path) => path.startsWith("glyphpay_fulfillment/")).length, 1);
});

test("a late success on a void or already-paid invoice is recorded but never credited or fulfilled", async () => {
  for (const [status, reason] of [["canceled", "invoice_void"], ["paid", "invoice_already_paid"]]) {
    const { db, adapter, hooks } = makeAdapter();
    const record = invoice({ status, amountPaidCents: status === "paid" ? 5000 : 0, amountRemainingCents: status === "paid" ? 0 : 5000 });
    await seed(db, record);

    const result = await adapter.onEvent(
      callback(adapter, record, {
        id: `evt_${status}`,
        data: { ...callback(adapter, record).data, amountCents: 5000 },
      })
    );
    assert.equal(result.status, "unapplied");
    assert.equal(result.reason, reason);
    assert.equal(hooks.unapplied, 1);
    assert.equal(hooks.applied, 0);
    assert.deepEqual(db.docs.get(`invoices/${record.id}`), record);
    assert.equal(db.docs.get(`glyphpay_payments/pi_1`).applied, false);
    assert.equal(db.docs.get(`glyphpay_deliveries/evt_${status}`).state, "unapplied");
    assert.equal([...db.docs.keys()].filter((path) => path.startsWith("glyphpay_fulfillment/")).length, 0);
  }
});

test("diagnostic events produce no invoice, balance, fulfillment, or ledger change", async () => {
  const { db, adapter, hooks } = makeAdapter();
  const record = invoice();
  await seed(db, record);
  const before = structuredClone([...db.docs.entries()]);

  const diagnostic = await adapter.onEvent({
    id: "evt_test_1",
    type: "webhook.test",
    createdAt: "2026-11-08T12:00:00.000Z",
    livemode: false,
    data: { id: "glyphpay_doctor", orderId: "glyphpay-doctor", status: "test" },
  });
  assert.equal(diagnostic.status, "ignored");
  assert.equal(diagnostic.reason, "diagnostic_event");
  assert.deepEqual([...db.docs.entries()], before);
  assert.equal(hooks.applied, 0);
  assert.equal(hooks.unapplied, 0);
});

test("environment, currency, amount, and order mismatches are rejected without writes", async () => {
  const { db, adapter } = makeAdapter();
  const record = invoice();
  await seed(db, record);
  const before = structuredClone([...db.docs.entries()]);

  const live = await adapter.onEvent(callback(adapter, record, { livemode: true }));
  assert.equal(live.status, "rejected");
  assert.equal(live.reason, "environment_mismatch");

  const zero = await adapter.onEvent(callback(adapter, record, { data: { ...callback(adapter, record).data, amountCents: 0 } }));
  assert.equal(zero.status, "rejected");
  assert.equal(zero.reason, "invalid_amount");

  const foreignOrder = await adapter.onEvent(callback(adapter, record, { data: { ...callback(adapter, record).data, orderId: "pi_1" } }));
  assert.equal(foreignOrder.status, "rejected");
  assert.equal(foreignOrder.reason, "invalid_order_id");

  const otherCurrency = await adapter.onEvent(callback(adapter, record, { data: { ...callback(adapter, record).data, currency: "eur" } }));
  assert.equal(otherCurrency.status, "rejected");
  assert.equal(otherCurrency.reason, "currency_mismatch");

  assert.deepEqual([...db.docs.entries()], before);
});

test("an invoice from another environment is rejected and audited", async () => {
  const { db, adapter } = makeAdapter();
  const record = invoice({ environment: "live" });
  await seed(db, record);

  const result = await adapter.onEvent(callback(adapter, record));
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "invoice_environment_mismatch");
  assert.equal(db.docs.get(`invoices/${record.id}`).amountPaidCents, 0);
  assert.equal(db.docs.get("glyphpay_deliveries/evt_1").state, "rejected_environment");
});

test("concurrent deliveries for one payment credit and fulfill exactly once", async () => {
  const { db, adapter, hooks } = makeAdapter();
  const record = invoice();
  await seed(db, record);

  const first = adapter.onEvent(callback(adapter, record, { id: "evt_a" }));
  const second = adapter.onEvent(callback(adapter, record, { id: "evt_b" }));
  const results = await Promise.all([first, second]);
  const statuses = results.map((result) => result.status).sort();
  assert.deepEqual(statuses, ["applied", "duplicate_payment"]);

  const updated = db.docs.get(`invoices/${record.id}`);
  assert.equal(updated.amountPaidCents, 5000);
  assert.equal(updated.payments.length, 1);
  assert.equal(hooks.applied, 1);
  assert.equal([...db.docs.keys()].filter((path) => path.startsWith("glyphpay_fulfillment/")).length, 1);
});

test("a transaction retry does not repeat the fulfillment or the post-commit hook", async () => {
  const { db, adapter, hooks } = makeAdapter();
  const record = invoice();
  await seed(db, record);
  db.contendOnce = true;

  const result = await adapter.onEvent(callback(adapter, record));
  assert.equal(result.status, "applied");
  assert.equal(hooks.applied, 1);
  assert.equal([...db.docs.keys()].filter((path) => path.startsWith("glyphpay_fulfillment/")).length, 1);
});

test("applyPayment runs inside the transaction and must not perform I/O", async () => {
  let calls = 0;
  const { db, adapter } = makeAdapter({
    applyPayment: (input) => {
      calls += 1;
      // A retry must be able to run this again; only pure ledger math is safe.
      return applyInvoicePayment(input);
    },
  });
  const record = invoice();
  await seed(db, record);
  db.contendOnce = true;
  await adapter.onEvent(callback(adapter, record));
  assert.equal(calls, 2);
});

/* ------------------------------------------------------------------ */
/* Status projection                                                   */
/* ------------------------------------------------------------------ */

test("the status endpoint authorizes first and reports server-derived state only", async () => {
  const { db, adapter } = makeAdapter();
  await seed(db, invoice());

  await assert.rejects(
    adapter.status({ reference: "inv_petal_1", req: request() }),
    (error) => error instanceof CheckoutError && error.status === 403
  );

  const member = request({ "x-member": "biz_petal" });
  const status = await adapter.status({ reference: "inv_petal_1", req: member });
  assert.equal(status.status, "open");
  assert.equal(status.canPay, true);
  assert.equal(status.outstandingCents, 5000);

  // A spoofed query string cannot change the projection: only the invoice is read.
  const spoofed = await adapter.status({
    reference: "inv_petal_1",
    req: new Request("https://site.example/api/glyphpay/status?status=paid&paid=1", {
      headers: { "x-member": "biz_petal" },
    }),
  });
  assert.equal(spoofed.status, "open");
  assert.equal(spoofed.canPay, true);
});

/* ------------------------------------------------------------------ */
/* Configuration is explicit                                           */
/* ------------------------------------------------------------------ */

test("ambiguous status mappings and missing authorization are configuration errors", () => {
  const base = {
    firestore: new MemoryFirestore(),
    environment: "test",
    invoices: {
      collection: "invoices",
      fields: FIELDS,
      statuses: { payable: ["open"], paid: ["paid"], void: ["canceled"] },
    },
    authorize: () => ({ allowed: true }),
    payments: { collection: "payments" },
    deliveries: { collection: "deliveries" },
    applyPayment: applyInvoicePayment,
  };

  assert.throws(
    () =>
      createFirestoreInvoiceAdapter({
        ...base,
        invoices: { ...base.invoices, statuses: { payable: ["open", "paid"], paid: ["paid"], void: ["canceled"] } },
      }),
    /both payable and paid/
  );
  assert.throws(
    () => createFirestoreInvoiceAdapter({ ...base, authorize: undefined }),
    /authorize is required/
  );
  assert.throws(
    () => createFirestoreInvoiceAdapter({ ...base, invoices: { ...base.invoices, fields: { ...FIELDS, status: "" } } }),
    /fields.status/
  );
});
