import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { glyphPay, verifyCallback, CheckoutError, RateLimitError } from "../dist/server.js";

const SECRET = `whsec_${Buffer.from("s3cret").toString("base64")}`;
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
const standardSign = (secret, id, timestamp, raw) => {
  const key = Buffer.from(secret.slice(6), "base64");
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return `v1,${digest}`;
};
const standardHeaders = (secret, id, raw, timestamp = now()) => ({
  "webhook-id": id,
  "webhook-timestamp": String(timestamp),
  "webhook-signature": standardSign(secret, id, timestamp, raw),
});

test("verifyCallback accepts Standard Webhooks signatures and rejects tampering, wrong secret, stale or missing headers", async () => {
  const valid = new Headers(standardHeaders(SECRET, event.id, body));
  assert.equal((await verifyCallback(body, valid, SECRET)).id, "evt_1");
  await assert.rejects(verifyCallback(body + " ", valid, SECRET));

  const otherSecret = `whsec_${Buffer.from("other").toString("base64")}`;
  await assert.rejects(verifyCallback(body, new Headers(standardHeaders(otherSecret, event.id, body)), SECRET));
  await assert.rejects(verifyCallback(body, new Headers(standardHeaders(SECRET, event.id, body, now() - 301)), SECRET));
  await assert.rejects(verifyCallback(body, new Headers(), SECRET));
});

test("verifyCallback rejects a dgcb_ secret and a mismatched webhook-id", async () => {
  const dgcb = `dgcb_${Buffer.from("s3cret").toString("base64url")}`;
  await assert.rejects(verifyCallback(body, new Headers(standardHeaders(SECRET, event.id, body)), dgcb));

  const wrongId = new Headers(standardHeaders(SECRET, "evt_other", body));
  await assert.rejects(verifyCallback(body, wrongId, SECRET));
});

test("webhook route accepts Standard Webhooks headers", async () => {
  let handled = 0;
  const gp = glyphPay({ token: "dgsvc_test_x", callbackSecret: SECRET, onEvent: () => { handled += 1; } });
  const request = (headers) => new Request("https://site/api/glyphpay/webhook", { method: "POST", body, headers });

  assert.equal((await gp.webhook(request(standardHeaders(SECRET, event.id, body)))).status, 204);
  assert.equal(handled, 1);
  assert.equal((await gp.webhook(request(standardHeaders(SECRET, event.id, body, now() - 301)))).status, 400);
  assert.equal(handled, 1);
});

test("webhook route rejects the removed legacy signature header", async () => {
  const gp = glyphPay({ token: "dgsvc_test_x", callbackSecret: SECRET });
  const timestamp = now();
  const legacy = `t=${timestamp},v1=${createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex")}`;
  const req = new Request("https://site/api/glyphpay/webhook", {
    method: "POST",
    body,
    headers: { "designglyph-signature": legacy },
  });
  assert.equal((await gp.webhook(req)).status, 400);
});

test("verifyCallback accepts multiple v1 Standard signatures during secret rotation", async () => {
  const timestamp = now();
  const key = Buffer.from(SECRET.slice(6), "base64");
  const valid = createHmac("sha256", key).update(`${event.id}.${timestamp}.${body}`).digest("base64");
  const headers = new Headers({
    "webhook-id": event.id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${"A".repeat(44)} v1,${valid}`,
  });
  assert.equal((await verifyCallback(body, headers, SECRET)).id, "evt_1");
});

test("webhook route: 204 + onEvent for valid, 400 for invalid, 500 when handler throws", async () => {
  const seen = [];
  const gp = glyphPay({ token: "dgsvc_test_x", callbackSecret: SECRET, onEvent: (e) => { seen.push(e.id); } });
  const request = (headers) => new Request("https://site/api/glyphpay/webhook", { method: "POST", body, headers });
  assert.equal((await gp.webhook(request(standardHeaders(SECRET, event.id, body)))).status, 204);
  assert.equal((await gp.webhook(request({ ...standardHeaders(SECRET, event.id, body), "webhook-signature": "v1,00" }))).status, 400);
  assert.deepEqual(seen, ["evt_1"]);
  const failing = glyphPay({ token: "dgsvc_test_x", callbackSecret: SECRET, onEvent: () => { throw new Error("db down"); } });
  assert.equal((await failing.webhook(request(standardHeaders(SECRET, event.id, body)))).status, 500);
});

test("webhook validates the event shape before calling handlers", async () => {
  let handled = 0;
  const gp = glyphPay({ token: "dgsvc_test_x", callbackSecret: SECRET, onEvent: () => { handled += 1; } });
  const post = (raw, id = event.id) => new Request("https://site/api/glyphpay/webhook", {
    method: "POST",
    body: raw,
    headers: standardHeaders(SECRET, id, raw),
  });

  assert.equal((await gp.webhook(post(JSON.stringify({ ...event, type: "payment.exploded" })))).status, 400);
  assert.equal((await gp.webhook(post(JSON.stringify({ ...event, id: "" }), ""))).status, 400);
  assert.equal((await gp.webhook(post(JSON.stringify({ ...event, data: {} })))).status, 400);
  assert.equal((await gp.webhook(post("null"))).status, 400);
  assert.equal(handled, 0);

  const testEvent = JSON.stringify({
    id: "evt_test_1",
    type: "webhook.test",
    createdAt: event.createdAt,
    livemode: false,
    data: { status: "test" },
  });
  assert.equal((await gp.webhook(post(testEvent, "evt_test_1"))).status, 204);
  assert.equal(handled, 1);
});

test("named payment handlers take precedence over onEvent", async () => {
  const calls = [];
  const gp = glyphPay({
    token: "dgsvc_test_x",
    callbackSecret: SECRET,
    onEvent: () => { calls.push("all"); },
    onPaymentSucceeded: (received) => { calls.push(`succeeded:${received.id}`); },
  });
  const req = (raw) => {
    const parsed = JSON.parse(raw);
    return new Request("https://site/api/glyphpay/webhook", {
      method: "POST",
      body: raw,
      headers: standardHeaders(SECRET, parsed.id, raw),
    });
  };

  assert.equal((await gp.webhook(req(body))).status, 204);
  assert.deepEqual(calls, ["succeeded:evt_1"]);

  const failed = JSON.stringify({ ...event, id: "evt_2", type: "payment.failed" });
  assert.equal((await gp.webhook(req(failed))).status, 204);
  assert.deepEqual(calls, ["succeeded:evt_1", "all"]);
});

test("webhook rejects events whose livemode does not match the credential", async () => {
  const gp = glyphPay({ token: "dgsvc_test_x", callbackSecret: SECRET });
  const liveBody = JSON.stringify({ ...event, livemode: true });
  const req = (raw) => new Request("https://site/api/glyphpay/webhook", {
    method: "POST",
    body: raw,
    headers: standardHeaders(SECRET, event.id, raw),
  });
  assert.equal((await gp.webhook(req(liveBody))).status, 400);

  const live = glyphPay({ token: "dgsvc_live_x", callbackSecret: SECRET });
  assert.equal((await live.webhook(req(liveBody))).status, 204);
  assert.equal((await live.webhook(req(body))).status, 400);

  const missing = JSON.stringify({ ...event, livemode: undefined });
  assert.equal((await gp.webhook(req(missing))).status, 500);
  const nullMode = JSON.stringify({ ...event, livemode: null });
  assert.equal((await gp.webhook(req(nullMode))).status, 500);

  const unconfigured = glyphPay({ token: undefined, callbackSecret: SECRET });
  assert.equal((await unconfigured.webhook(req(body))).status, 500);
});

test("webhook calls the optional replay guard and skips the handler for a seen event", async () => {
  let handled = 0;
  const gp = glyphPay({
    token: "dgsvc_test_x",
    callbackSecret: SECRET,
    seen: (eventId) => eventId === "evt_1",
    onEvent: () => { handled += 1; },
  });
  const req = new Request("https://site/api/glyphpay/webhook", {
    method: "POST",
    body,
    headers: standardHeaders(SECRET, event.id, body),
  });
  assert.equal((await gp.webhook(req)).status, 204);
  assert.equal(handled, 0);
});

test("webhook rejects a body over 1 MB before verifying the signature", async () => {
  const gp = glyphPay({ token: "dgsvc_test_x", callbackSecret: SECRET });
  const req = new Request("https://site/api/glyphpay/webhook", {
    method: "POST",
    body: "x".repeat(1_000_001),
    headers: { ...standardHeaders(SECRET, event.id, body), "webhook-signature": "v1,00" },
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
