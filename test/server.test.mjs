import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { glyphPay, verifyCallback, CheckoutError, RateLimitError } from "../dist/server.js";

// Same signer as functions/src/billing/callbacks.ts signCallback().
const sign = (secret, t, body) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const now = () => Math.floor(Date.now() / 1000);
const event = {
  id: "evt_1",
  type: "payment.succeeded",
  createdAt: new Date().toISOString(),
  livemode: false,
  data: {
    id: "pay_1",
    orderId: "o1",
    status: "succeeded",
    amountCents: 2500,
    applicationFeeCents: 2,
    currency: "usd",
    refundedCents: 0,
    refunds: [],
    disputes: [],
    stale: false,
    updatedAt: new Date().toISOString(),
  },
};
const body = JSON.stringify(event);

test("verifyCallback accepts the backend's signature and rejects tampering, wrong secret, stale or missing header", async () => {
  assert.equal((await verifyCallback(body, sign("s3cret", now(), body), "s3cret")).id, "evt_1");
  await assert.rejects(verifyCallback(body + " ", sign("s3cret", now(), body), "s3cret"));
  await assert.rejects(verifyCallback(body, sign("other", now(), body), "s3cret"));
  await assert.rejects(verifyCallback(body, sign("s3cret", now() - 301, body), "s3cret"));
  await assert.rejects(verifyCallback(body, null, "s3cret"));
});

test("verifyCallback accepts an old and a new v1 signature during secret rotation", async () => {
  const t = now();
  const valid = createHmac("sha256", "s3cret").update(`${t}.${body}`).digest("hex");
  const header = `t=${t},v1=${"a".repeat(64)},v1=${valid}`;
  assert.equal((await verifyCallback(body, header, "s3cret")).id, "evt_1");
});

test("webhook route: 204 + onEvent for valid, 400 for invalid, 500 when handler throws", async () => {
  const seen = [];
  const gp = glyphPay({ token: "dgsvc_test_x", callbackSecret: "s3cret", onEvent: (e) => { seen.push(e.id); } });
  const req = (sig) => new Request("https://site/api/glyphpay/webhook", { method: "POST", body, headers: { "designglyph-signature": sig } });
  assert.equal((await gp.webhook(req(sign("s3cret", now(), body)))).status, 204);
  assert.equal((await gp.webhook(req("t=1,v1=00"))).status, 400);
  assert.deepEqual(seen, ["evt_1"]);
  const failing = glyphPay({ token: "dgsvc_test_x", callbackSecret: "s3cret", onEvent: () => { throw new Error("db down"); } });
  assert.equal((await failing.webhook(req(sign("s3cret", now(), body)))).status, 500);
});

test("webhook rejects events whose livemode does not match the credential", async () => {
  const gp = glyphPay({ token: "dgsvc_test_x", callbackSecret: "s3cret" });
  const liveBody = JSON.stringify({ ...event, livemode: true });
  const req = (raw) => new Request("https://site/api/glyphpay/webhook", {
    method: "POST",
    body: raw,
    headers: { "designglyph-signature": sign("s3cret", now(), raw) },
  });
  assert.equal((await gp.webhook(req(liveBody))).status, 400);

  const live = glyphPay({ token: "dgsvc_live_x", callbackSecret: "s3cret" });
  assert.equal((await live.webhook(req(liveBody))).status, 204);
  assert.equal((await live.webhook(req(body))).status, 400);

  const missing = JSON.stringify({ ...event, livemode: undefined });
  assert.equal((await gp.webhook(req(missing))).status, 500);
  const nullMode = JSON.stringify({ ...event, livemode: null });
  assert.equal((await gp.webhook(req(nullMode))).status, 500);

  const unconfigured = glyphPay({ token: undefined, callbackSecret: "s3cret" });
  assert.equal((await unconfigured.webhook(req(body))).status, 500);
});

test("webhook calls the optional replay guard and skips the handler for a seen event", async () => {
  let handled = 0;
  const gp = glyphPay({
    token: "dgsvc_test_x",
    callbackSecret: "s3cret",
    seen: (eventId) => eventId === "evt_1",
    onEvent: () => { handled += 1; },
  });
  const req = new Request("https://site/api/glyphpay/webhook", {
    method: "POST",
    body,
    headers: { "designglyph-signature": sign("s3cret", now(), body) },
  });
  assert.equal((await gp.webhook(req)).status, 204);
  assert.equal(handled, 0);
});

test("webhook rejects a body over 1 MB before verifying the signature", async () => {
  const gp = glyphPay({ token: "dgsvc_test_x", callbackSecret: "s3cret" });
  const req = new Request("https://site/api/glyphpay/webhook", {
    method: "POST",
    body: "x".repeat(1_000_001),
    headers: { "designglyph-signature": "t=1,v1=00" },
  });
  assert.equal((await gp.webhook(req)).status, 413);
});

test("checkout route prices server-side, sends the credential only to GlyphPay, hides backend errors", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return Response.json({ ok: true, data: { id: "p1", paymentIntentId: "pi_1", clientSecret: "cs_1", publishableKey: "pk_1", stripeAccount: "acct_1" } });
  });
  const gp = glyphPay({
    token: "dgsvc_test_biz_secret",
    priceOrder: ({ cartId }) => {
      if (!cartId) throw new CheckoutError("Your cart is empty.");
      return { orderId: `cart-${cartId}`, amountCents: 2500, description: "Order" };
    },
  });
  const post = (json, headers = {}) => gp.checkout(new Request("https://site/api/glyphpay/checkout", {
    method: "POST",
    body: JSON.stringify(json),
    headers: { "content-type": "application/json", ...headers },
  }));

  const res = await post({ cartId: "42", amountCents: 1 });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out, { clientSecret: "cs_1", publishableKey: "pk_1", stripeAccount: "acct_1", paymentId: "p1" });
  assert.equal(calls[0].url, "https://designglyph.web.app/api/client/v1/payments");
  assert.equal(calls[0].init.headers.authorization, "Bearer dgsvc_test_biz_secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), { orderId: "cart-42", amountCents: 2500, description: "Order", currency: "usd" });

  const empty = await post({});
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, "Your cart is empty.");

  assert.equal((await post({ cartId: "42" }, { origin: "https://evil.example" })).status, 403);
  const text = await gp.checkout(new Request("https://site/api/glyphpay/checkout", {
    method: "POST",
    body: "cartId=42",
    headers: { "content-type": "text/plain" },
  }));
  assert.equal(text.status, 415);
  const large = await gp.checkout(new Request("https://site/api/glyphpay/checkout", {
    method: "POST",
    body: "x".repeat(1_000_001),
    headers: { "content-type": "application/json" },
  }));
  assert.equal(large.status, 413);

  let checked = 0;
  const hooked = glyphPay({
    token: "dgsvc_test_biz_secret",
    beforeCheckout: () => { checked += 1; },
    priceOrder: () => ({ orderId: "cart-42", amountCents: 2500, description: "Order" }),
  });
  assert.equal((await hooked.checkout(new Request("https://site/api/glyphpay/checkout", {
    method: "POST",
    body: JSON.stringify({ cartId: "42" }),
    headers: { "content-type": "application/json" },
  }))).status, 200);
  assert.equal(checked, 1);

  const limited = glyphPay({
    token: "dgsvc_test_biz_secret",
    beforeCheckout: () => { throw new RateLimitError("Slow down.", 30); },
    priceOrder: () => ({ orderId: "cart-42", amountCents: 2500, description: "Order" }),
  });
  const limitedResponse = await limited.checkout(new Request("https://site/api/glyphpay/checkout", {
    method: "POST",
    body: JSON.stringify({ cartId: "42" }),
    headers: { "content-type": "application/json" },
  }));
  assert.equal(limitedResponse.status, 429);
  assert.equal(limitedResponse.headers.get("retry-after"), "30");
  assert.equal((await limitedResponse.json()).error, "Slow down.");

  const limitedWithOptions = glyphPay({
    token: "dgsvc_test_biz_secret",
    beforeCheckout: () => { throw new RateLimitError({ message: "Try again later.", retryAfterSeconds: 15 }); },
    priceOrder: () => ({ orderId: "cart-42", amountCents: 2500, description: "Order" }),
  });
  const optionsResponse = await limitedWithOptions.checkout(new Request("https://site/api/glyphpay/checkout", {
    method: "POST",
    body: JSON.stringify({ cartId: "42" }),
    headers: { "content-type": "application/json" },
  }));
  assert.equal(optionsResponse.status, 429);
  assert.equal(optionsResponse.headers.get("retry-after"), "15");
  assert.equal((await optionsResponse.json()).error, "Try again later.");

  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, error: { message: "Connected account is not ready" } }, { status: 409 }));
  const down = await post({ cartId: "42" });
  assert.equal(down.status, 502);
  assert.doesNotMatch((await down.json()).error, /Connected account/);
});

test("base URL must be HTTPS outside loopback and must not contain credentials", () => {
  assert.throws(() => glyphPay({ token: "dgsvc_test_x", baseUrl: "http://api.example.com" }), /https/);
  assert.throws(() => glyphPay({ token: "dgsvc_test_x", baseUrl: "https://user:pass@api.example.com" }), /credentials/);
  assert.doesNotThrow(() => glyphPay({ token: "dgsvc_test_x", baseUrl: "http://127.0.0.1:8787" }));
});
