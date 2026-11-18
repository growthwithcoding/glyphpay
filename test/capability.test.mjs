import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPaymentLinkCapability,
  verifyPaymentLinkCapability,
} from "../dist/capability.js";

const SECRET = "a".repeat(48);
const INVOICE = "inv_petal_2026";

test("a capability authorizes only its invoice and expires", async () => {
  const now = new Date("2026-11-08T12:00:00Z");
  const token = await createPaymentLinkCapability({
    secret: SECRET,
    invoiceId: INVOICE,
    revision: "r123dabc",
    expiresInSeconds: 600,
    now,
  });

  const valid = await verifyPaymentLinkCapability(SECRET, token, {
    invoiceId: INVOICE,
    revision: "r123dabc",
    now: new Date("2026-11-08T12:05:00Z"),
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.capability, {
    v: 1,
    i: INVOICE,
    r: "r123dabc",
    exp: Math.floor(now.getTime() / 1000) + 600,
  });

  const wrongInvoice = await verifyPaymentLinkCapability(SECRET, token, {
    invoiceId: "inv_other",
    now,
  });
  assert.deepEqual(wrongInvoice, { ok: false, reason: "invoice_mismatch" });

  const wrongRevision = await verifyPaymentLinkCapability(SECRET, token, {
    invoiceId: INVOICE,
    revision: "r999dzzz",
    now,
  });
  assert.deepEqual(wrongRevision, { ok: false, reason: "revision_mismatch" });

  const expired = await verifyPaymentLinkCapability(SECRET, token, {
    invoiceId: INVOICE,
    now: new Date("2026-11-08T12:30:00Z"),
  });
  assert.deepEqual(expired, { ok: false, reason: "expired" });
});

test("a capability cannot be forged, tampered with, or verified with another secret", async () => {
  const token = await createPaymentLinkCapability({ secret: SECRET, invoiceId: INVOICE });
  const [prefix, payload, signature] = token.split(".");

  const tamperedPayload = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  tamperedPayload.exp += 86_400;
  const forged = `${prefix}.${Buffer.from(JSON.stringify(tamperedPayload)).toString("base64url")}.${signature}`;
  assert.deepEqual(
    await verifyPaymentLinkCapability(SECRET, forged, { invoiceId: INVOICE }),
    { ok: false, reason: "bad_signature" }
  );

  assert.deepEqual(
    await verifyPaymentLinkCapability("b".repeat(48), token, { invoiceId: INVOICE }),
    { ok: false, reason: "bad_signature" }
  );

  assert.deepEqual(await verifyPaymentLinkCapability(SECRET, `${token}.extra`, { invoiceId: INVOICE }), {
    ok: false,
    reason: "malformed",
  });
  assert.deepEqual(await verifyPaymentLinkCapability(SECRET, "not-a-token", { invoiceId: INVOICE }), {
    ok: false,
    reason: "malformed",
  });
  assert.deepEqual(await verifyPaymentLinkCapability("short", token, { invoiceId: INVOICE }), {
    ok: false,
    reason: "bad_signature",
  });
});

test("capability creation rejects unsafe ids and unreasonably long lifetimes", async () => {
  await assert.rejects(
    createPaymentLinkCapability({ secret: SECRET, invoiceId: "../etc/passwd" }),
    /valid document id/
  );
  await assert.rejects(
    createPaymentLinkCapability({ secret: SECRET, invoiceId: INVOICE, expiresInSeconds: 60 * 60 * 24 * 365 }),
    /lifetime/
  );
  await assert.rejects(createPaymentLinkCapability({ secret: "too-short", invoiceId: INVOICE }), /32 bytes/);
});
