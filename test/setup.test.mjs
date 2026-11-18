import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runSetup, CliUsageError } from "../dist/cli.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const tscBin = join(packageRoot, "node_modules", "typescript", "bin", "tsc");

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "glyphpay-setup-"));
  await writeJson(join(dir, "package.json"), {
    name: "fixture-site",
    private: true,
    dependencies: { next: "^15.0.0", react: "^19.0.0", "react-dom": "^19.0.0" },
    scripts: { build: "next build" },
  });
  await writeFile(join(dir, "next.config.mjs"), 'const nextConfig = { output: "export" };\nexport default nextConfig;\n');
  await writeJson(join(dir, "firebase.json"), {
    hosting: {
      public: "out",
      ignore: ["firebase.json", "**/.*", "**/node_modules/**"],
      rewrites: [
        { source: "/admin", function: { functionId: "adminSite", region: "us-central1" } },
        { source: "**", destination: "/index.html" },
      ],
    },
    functions: { source: "functions" },
  });
  await mkdir(join(dir, "functions", "src"), { recursive: true });
  await writeJson(join(dir, "functions", "package.json"), {
    name: "fixture-functions",
    private: true,
    main: "lib/index.js",
    scripts: { build: "tsc" },
    dependencies: { "firebase-admin": "^13.1.0", "firebase-functions": "^7.4.0" },
    devDependencies: { typescript: "^5.7.0", "@types/node": "^22" },
  });
  await writeJson(join(dir, "functions", "tsconfig.json"), {
    compilerOptions: { module: "commonjs", target: "ES2022", outDir: "lib", strict: true, skipLibCheck: true },
    include: ["src"],
  });
  await writeFile(join(dir, "functions", "src", "index.ts"), 'export {};\n');
  await mkdir(join(dir, "components"), { recursive: true });
  return dir;
}

async function compileGenerated(dir) {
  await mkdir(join(dir, "stubs"), { recursive: true });
  const dist = relative(dir, join(packageRoot, "dist")).replace(/\\/g, "/");
  const stubs = {
    "firebase-admin-app.d.ts": "export function getApps(): unknown[];\nexport function initializeApp(): void;\n",
    "firebase-admin-firestore.d.ts": "export function getFirestore(): unknown;\n",
    "firebase-functions-https.d.ts":
      "export function onRequest(options: Record<string, unknown>, handler: (req: any, res: any) => unknown): unknown;\n",
    "firebase-functions-params.d.ts": "export function defineSecret(name: string): { value(): string };\n",
    "node-process.d.ts": "declare var process: { env: Record<string, string | undefined> };\n",
    "stripe.d.ts": "export type Appearance = Record<string, unknown>;\nexport function loadStripe(key: string): Promise<unknown>;\n",
  };
  for (const [name, contents] of Object.entries(stubs)) {
    await writeFile(join(dir, "stubs", name), contents, "utf8");
  }
  await writeJson(join(dir, "tsconfig.generated.json"), {
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2022", "DOM"],
      skipLibCheck: true,
      types: [],
      baseUrl: ".",
      paths: {
        "glyphpay/server": [`${dist}/server.d.ts`],
        "glyphpay/firebase": [`${dist}/firebase.d.ts`],
        "glyphpay/browser": [`${dist}/browser.d.ts`],
        "firebase-admin/app": ["stubs/firebase-admin-app.d.ts"],
        "firebase-admin/firestore": ["stubs/firebase-admin-firestore.d.ts"],
        "firebase-functions/v2/https": ["stubs/firebase-functions-https.d.ts"],
        "firebase-functions/params": ["stubs/firebase-functions-params.d.ts"],
        "@stripe/stripe-js": ["stubs/stripe.d.ts"],
      },
    },
    include: ["functions/src/**/*.ts", "stubs/**/*.d.ts"],
  });
  execFileSync(process.execPath, [tscBin, "-p", join(dir, "tsconfig.generated.json")], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

test("setup detects a static Next.js site with Firebase Functions without running its config", async () => {
  const dir = await fixture();
  try {
    const result = await runSetup({ dir, dryRun: true, json: true });
    assert.equal(result.target, "firebase-functions");
    assert.equal(result.framework, "next");
    assert.equal(result.nextOutput, "export");
    assert.equal(result.dryRun, true);
    assert.equal(result.preset, "custom");
    assert.ok(result.files.every((file) => file.action.startsWith("would-")));
    // Nothing was written during a dry run.
    await assert.rejects(readFile(join(dir, "functions", "src", "glyphpay", "connector.ts"), "utf8"));
    assert.deepEqual(JSON.parse(await readFile(join(dir, "firebase.json"), "utf8")).hosting.rewrites.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setup refuses static Next.js route handlers with an actionable error", async () => {
  const dir = await fixture();
  try {
    await assert.rejects(
      runSetup({ dir, target: "next", ui: "none", json: true }),
      (error) =>
        error instanceof CliUsageError &&
        /output: "export"/.test(error.message) &&
        /firebase-functions/.test(error.message)
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setup generates a Firestore invoice integration inside the Functions artifact", async () => {
  const dir = await fixture();
  try {
    const result = await runSetup({
      dir,
      target: "firebase-functions",
      preset: "firestore-invoices",
      ui: "react",
      json: true,
    });

    assert.equal(result.functionId, "glyphpaySite");
    assert.deepEqual(result.routes, {
      checkout: "/api/glyphpay/checkout",
      webhook: "/api/glyphpay/webhook",
      status: "/api/glyphpay/status",
    });
    const paths = result.files.map((file) => file.path);
    assert.ok(paths.includes("functions/src/glyphpay/config.ts"));
    assert.ok(paths.includes("functions/src/glyphpay/functions.ts"));
    assert.ok(paths.includes("functions/src/index.ts"));
    assert.ok(paths.includes("components/InvoicePayment.tsx"));
    assert.ok(paths.includes("functions/package.json"));
    assert.ok(paths.includes("package.json"));
    assert.ok(paths.includes("firebase.json"));

    const config = await readFile(join(dir, "functions", "src", "glyphpay", "config.ts"), "utf8");
    assert.match(config, /createFirestoreInvoiceAdapter/);
    assert.match(config, /CONFIGURED: boolean = false/);
    assert.match(config, /UNCONFIGURED_outstandingCents/);

    const functions = await readFile(join(dir, "functions", "src", "glyphpay", "functions.ts"), "utf8");
    assert.match(functions, /defineSecret\("GLYPHPAY_TOKEN"\)/);
    assert.match(functions, /defineSecret\("GLYPHPAY_CALLBACK_SECRET"\)/);
    assert.match(functions, /createFirebaseHttpsHandler/);
    assert.match(functions, /export const glyphpaySite = onRequest/);

    const index = await readFile(join(dir, "functions", "src", "index.ts"), "utf8");
    assert.match(index, /export \{ glyphpaySite \} from "\.\/glyphpay\/functions";/);

    const hosting = JSON.parse(await readFile(join(dir, "firebase.json"), "utf8")).hosting.rewrites;
    assert.deepEqual(
      hosting.slice(0, 3).map((entry) => entry.source),
      ["/api/glyphpay/checkout", "/api/glyphpay/webhook", "/api/glyphpay/status"]
    );
    assert.deepEqual(hosting[3], { source: "/admin", function: { functionId: "adminSite", region: "us-central1" } });
    assert.deepEqual(hosting[4], { source: "**", destination: "/index.html" });

    const functionsPkg = JSON.parse(await readFile(join(dir, "functions", "package.json"), "utf8"));
    assert.equal(functionsPkg.dependencies.glyphpay, "^2.3.0");
    const rootPkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(rootPkg.dependencies.glyphpay, "^2.3.0");

    const wrapper = await readFile(join(dir, "components", "InvoicePayment.tsx"), "utf8");
    assert.match(wrapper, /from "glyphpay\/react"/);
    assert.match(wrapper, /"use client"/);
    assert.doesNotMatch(wrapper, /window\./);
    assert.doesNotMatch(wrapper, /firebase-admin|GLYPHPAY_TOKEN/);

    assert.equal((await readFile(join(dir, "functions", ".env.example"), "utf8")).includes("GLYPHPAY_CALLBACK_SECRET="), true);

    await compileGenerated(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setup is idempotent, protects edited files, and never shadows another route", async () => {
  const dir = await fixture();
  try {
    const options = { dir, target: "firebase-functions", preset: "firestore-invoices", ui: "none", json: true };
    await runSetup(options);
    const second = await runSetup(options);
    assert.ok(second.files.every((file) => file.action === "unchanged"), JSON.stringify(second.files));
    assert.deepEqual(second.rewrites.added, []);
    assert.deepEqual(second.rewrites.unchanged.sort(), [
      "/api/glyphpay/checkout",
      "/api/glyphpay/status",
      "/api/glyphpay/webhook",
    ]);

    const configPath = join(dir, "functions", "src", "glyphpay", "config.ts");
    await writeFile(configPath, (await readFile(configPath, "utf8")) + "\n// edited by hand\n", "utf8");
    await assert.rejects(runSetup(options), (error) => error instanceof CliUsageError && /--force/.test(error.message));
    const forced = await runSetup({ ...options, force: true });
    assert.equal(forced.files.find((file) => file.path.endsWith("config.ts")).action, "updated");
    assert.equal((await readFile(configPath, "utf8")).includes("edited by hand"), false);

    const conflictDir = await fixture();
    try {
      const firebasePath = join(conflictDir, "firebase.json");
      const config = JSON.parse(await readFile(firebasePath, "utf8"));
      config.hosting.rewrites.unshift({ source: "/api/glyphpay/checkout", destination: "/legacy.html" });
      await writeJson(firebasePath, config);
      await assert.rejects(
        runSetup({ ...options, dir: conflictDir }),
        (error) =>
          error instanceof CliUsageError &&
          /\/api\/glyphpay\/checkout/.test(error.message) &&
          /will not silently replace/.test(error.message)
      );
      assert.deepEqual(
        JSON.parse(await readFile(firebasePath, "utf8")).hosting.rewrites[0],
        { source: "/api/glyphpay/checkout", destination: "/legacy.html" }
      );
    } finally {
      await rm(conflictDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setup reuses an existing broad Glyph Pay rewrite instead of duplicating it", async () => {
  const dir = await fixture();
  try {
    const firebasePath = join(dir, "firebase.json");
    const config = JSON.parse(await readFile(firebasePath, "utf8"));
    config.hosting.rewrites.unshift({
      source: "/api/glyphpay{,/**}",
      function: { functionId: "glyphpaySite", region: "us-central1" },
    });
    await writeJson(firebasePath, config);

    const result = await runSetup({
      dir,
      target: "firebase-functions",
      preset: "firestore-invoices",
      ui: "none",
      json: true,
    });
    assert.deepEqual(result.rewrites.added, []);
    assert.deepEqual(result.rewrites.unchanged, ["/api/glyphpay{,/**}"]);
    assert.match(result.rewrites.note ?? "", /already sends the Glyph Pay paths/);
    assert.equal(JSON.parse(await readFile(firebasePath, "utf8")).hosting.rewrites.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
