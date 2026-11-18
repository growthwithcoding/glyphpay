/**
 * Package-consumer check: installs the built package into a throwaway project
 * (via a node_modules junction), then typechecks a consumer that imports every
 * public subpath. This validates package.json "exports", the emitted .d.ts
 * files, and that the browser entry point pulls in no server-only code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const tscBin = join(packageRoot, "node_modules", "typescript", "bin", "tsc");

const consumer = `import { glyphPay, CheckoutError, type GlyphPayEvent, type PaymentMethod, type RailQuote } from "glyphpay/server";
import { createFirestoreInvoiceAdapter, type FirestoreLike } from "glyphpay/firebase";
import { createPaymentLinkCapability, verifyPaymentLinkCapability } from "glyphpay/capability";
import { GlyphPayCheckout } from "glyphpay/react";

const connector = glyphPay({
  token: "dgsvc_test_example",
  callbackSecret: "whsec_example",
  priceOrder: async () => ({ orderId: "invoice-1", amountCents: 500, description: "Invoice" }),
  onEvent: (_event: GlyphPayEvent) => undefined,
});

void connector.checkout;
void connector.webhook;

const firestore: FirestoreLike = {
  doc: () => {
    throw new Error("not used");
  },
  runTransaction: async (run) =>
    run({
      get: async () => ({ id: "invoice-1", exists: false, data: () => undefined }),
      set: () => undefined,
      create: () => undefined,
    }),
};

createFirestoreInvoiceAdapter<Record<string, unknown>>({
  firestore,
  environment: "test",
  invoices: {
    collection: "invoices",
    fields: {
      outstandingCents: "amountRemainingCents",
      description: "description",
      status: "status",
      currency: "currency",
      businessId: "businessId",
      environment: "environment",
    },
    statuses: { payable: ["open"], paid: ["paid"], void: ["canceled"] },
  },
  authorize: () => ({ allowed: false, status: 403 }),
  applyPayment: ({ invoice }) => invoice,
  payments: { collection: "payments" },
  deliveries: { collection: "deliveries" },
});

const rail: PaymentMethod = "crypto";
const cryptoTotal: RailQuote | null = { chargedCents: 10162, processingFeeCents: 162 };
void rail;
void cryptoTotal;
void GlyphPayCheckout;
void createPaymentLinkCapability;
void verifyPaymentLinkCapability;
void CheckoutError;
`;

test("a consumer can typecheck every public package subpath", async () => {
  const dir = await mkdtemp(join(tmpdir(), "glyphpay-consumer-"));
  try {
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await symlink(packageRoot, join(dir, "node_modules", "glyphpay"), "junction");
    await writeFile(join(dir, "consumer.tsx"), consumer, "utf8");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "glyphpay-consumer-fixture", private: true, type: "module" }, null, 2) + "\n",
      "utf8"
    );
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ES2022", "DOM"],
            jsx: "react-jsx",
            skipLibCheck: true,
            types: [],
          },
          include: ["consumer.tsx"],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    execFileSync(process.execPath, [tscBin, "-p", join(dir, "tsconfig.json")], { encoding: "utf8", stdio: "pipe" });

    // Server-only code must never reach the browser bundle.
    for (const entry of ["browser.js", "react.js"]) {
      const source = await readFile(join(packageRoot, "dist", entry), "utf8");
      assert.doesNotMatch(source, /firebase-admin|FIREBASE_|dgsvc_/, `${entry} must not contain server-only code`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
