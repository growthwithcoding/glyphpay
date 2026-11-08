import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveReturnUrl } from "../dist/security.js";

test("resolveReturnUrl keeps relative returns on the current origin", () => {
  assert.equal(
    resolveReturnUrl("/thank-you?cart=42", "https://shop.example.com/checkout"),
    "https://shop.example.com/thank-you?cart=42"
  );
  assert.equal(
    resolveReturnUrl("https://shop.example.com/thanks", "https://shop.example.com/checkout"),
    "https://shop.example.com/thanks"
  );
});

test("resolveReturnUrl rejects cross-origin and non-http returns by default", () => {
  assert.throws(
    () => resolveReturnUrl("https://evil.example/thanks", "https://shop.example.com/checkout"),
    /origin/
  );
  assert.throws(
    () => resolveReturnUrl("javascript:alert(1)", "https://shop.example.com/checkout"),
    /http/
  );
});

test("resolveReturnUrl allows an intentional cross-origin return", () => {
  assert.equal(
    resolveReturnUrl("https://checkout.example.com/thanks", "https://shop.example.com/checkout", true),
    "https://checkout.example.com/thanks"
  );
});
