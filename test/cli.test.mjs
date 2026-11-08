import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ensureEnvKeys,
  findPublicCredentialKeys,
  isProbeableCallbackUrl,
  isPublicHttpsUrl,
  normalizeApiBaseUrl,
  readEnvValue,
  removeEnvKeys,
  sanitizeTerminal,
  toCallbackUrl,
  upsertEnv,
} from "../dist/cli.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const DEFAULT_TOKEN = `dgsvc_test_biz_petal_${"a".repeat(43)}`;
const NEXT_TOKEN = `dgsvc_test_biz_petal_${"b".repeat(43)}`;
const CALLBACK_SECRET = `dgcb_${"c".repeat(40)}`;

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withFakeApi(run, options = {}) {
  const requests = [];
  let polls = 0;
  let tokenPayload = options.token ?? DEFAULT_TOKEN;
  let revoked = false;
  let callbackSecret = options.callbackSecret ?? CALLBACK_SECRET;
  const verificationOverride = options.verificationUrl;
  let credentialCallbackUrl =
    options.callbackUrl === null ? null : options.callbackUrl ?? "https://shop.example.com/api/glyphpay/webhook";
  let lastDeviceCallbackUrl = null;
  let nextToken = options.nextToken ?? NEXT_TOKEN;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, path: url.pathname, query: url.search, body: parsed, authorization: req.headers.authorization });
      res.setHeader("content-type", "application/json");

      if (req.method === "GET" && url.pathname === "/api/cli/v1/credential") {
        if (req.headers.authorization !== `Bearer ${tokenPayload}` || revoked) {
          res.statusCode = 401;
          res.end(JSON.stringify({ ok: false, error: { code: "invalid_credential", message: "Invalid service credential." } }));
          return;
        }
        res.end(
          JSON.stringify({
            ok: true,
            data: {
              businessId: "biz_petal",
              businessName: "Petal Pushers Test LLC",
              environment: "test",
              chargesEnabled: true,
              connectedAccountId: "acct_test_123",
              callbackUrl: credentialCallbackUrl,
              callbackSecretConfigured: !!credentialCallbackUrl,
              credentialCreatedAt: "2026-10-27T12:00:00.000Z",
              lastUsedAt: "2026-10-27T12:05:00.000Z",
            },
          })
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/cli/v1/credential/deliveries") {
        if (req.headers.authorization !== `Bearer ${tokenPayload}` || revoked) {
          res.statusCode = 401;
          res.end(JSON.stringify({ ok: false, error: { code: "invalid_credential", message: "Invalid service credential." } }));
          return;
        }
        res.end(
          JSON.stringify({
            ok: true,
            data: {
              businessId: "biz_petal",
              businessName: "Petal Pushers Test LLC",
              environment: "test",
              deliveries: [
                {
                  id: "evt_failed_1",
                  paymentId: "pay_1",
                  type: "payment.succeeded",
                  state: "failed",
                  attempts: 2,
                  lastError: "Webhook returned HTTP 500.",
                  createdAt: "2026-10-27T12:00:00.000Z",
                  updatedAt: "2026-10-27T12:05:00.000Z",
                },
              ],
              nextCursor: url.searchParams.get("state") === "failed" ? "next_cursor" : null,
            },
          })
        );
        return;
      }

      const replayMatch = url.pathname.match(/^\/api\/cli\/v1\/credential\/deliveries\/([^/]+)\/replay$/);
      if (req.method === "POST" && replayMatch) {
        if (req.headers.authorization !== `Bearer ${tokenPayload}` || revoked) {
          res.statusCode = 401;
          res.end(JSON.stringify({ ok: false, error: { code: "invalid_credential", message: "Invalid service credential." } }));
          return;
        }
        res.end(
          JSON.stringify({
            ok: true,
            data: {
              outcome: "delivered",
              delivery: {
                id: decodeURIComponent(replayMatch[1]),
                paymentId: "pay_1",
                type: "payment.succeeded",
                state: "delivered",
                attempts: 3,
                lastError: null,
                createdAt: "2026-10-27T12:00:00.000Z",
                updatedAt: "2026-10-27T12:06:00.000Z",
              },
            },
          })
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cli/v1/credential/revoke") {
        if (req.headers.authorization !== `Bearer ${tokenPayload}` || revoked) {
          res.statusCode = 401;
          res.end(JSON.stringify({ ok: false, error: { code: "invalid_credential", message: "Invalid service credential." } }));
          return;
        }
        revoked = true;
        res.end(JSON.stringify({ ok: true, data: { revoked: true, alreadyRevoked: false, businessName: "Petal Pushers Test LLC" } }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cli/v1/device") {
        lastDeviceCallbackUrl = parsed.callbackUrl ?? null;
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            ok: true,
            data: {
              deviceCode: `device-${"x".repeat(40)}`,
              userCode: "ABCD-EFGH",
              verificationUrl:
                verificationOverride ?? `http://${req.headers.host}/cli?code=ABCD-EFGH`,
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
              interval: 1,
              environment: "test",
            },
          })
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cli/v1/device/token") {
        polls += 1;
        if (polls % 2 === 1) {
          res.end(JSON.stringify({ ok: true, data: { status: "pending", interval: 1, expiresAt: new Date().toISOString() } }));
          return;
        }
        tokenPayload = nextToken;
        revoked = false;
        if (lastDeviceCallbackUrl) {
          credentialCallbackUrl = lastDeviceCallbackUrl;
          callbackSecret = `dgcb_${"d".repeat(40)}`;
        }
        res.end(
          JSON.stringify({
            ok: true,
            data: {
              status: "approved",
              token: tokenPayload,
              callbackSecret: lastDeviceCallbackUrl ? callbackSecret : null,
              businessId: "biz_petal",
              businessName: "Petal Pushers Test LLC",
              callbackUrl: lastDeviceCallbackUrl,
              environment: "test",
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
            },
          })
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: { code: "not_found", message: "Endpoint not found." } }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run({
      baseUrl: `http://127.0.0.1:${port}`,
      requests,
      getToken: () => tokenPayload,
      getRevoked: () => revoked,
      getCallbackSecret: () => callbackSecret,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withWebhookReceiver(run) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ method: req.method, headers: req.headers, body });
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run({ url: `http://127.0.0.1:${port}/api/glyphpay/webhook`, received });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("connect writes only the managed keys to an existing env file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glyphpay-cli-"));
  const envFile = join(directory, ".env.local");
  await writeFile(envFile, "DATABASE_URL=postgres://local\nGLYPHPAY_TOKEN=old-token\nOTHER=keep\n", "utf8");

  const outcome = await withFakeApi(async ({ baseUrl, requests }) => {
    const result = await runCli(
      [
        "connect",
        "--no-open",
        "--base-url",
        baseUrl,
        "--env",
        envFile,
        "--url",
        "https://shop.example.com",
        "--timeout",
        "20",
      ],
      directory
    );
    return { result, requests };
  });

  assert.equal(outcome.result.code, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /Connected Petal Pushers Test LLC \(test mode\)/);
  assert.doesNotMatch(outcome.result.stdout, new RegExp(DEFAULT_TOKEN));

  const created = outcome.requests.find((request) => request.path === "/api/cli/v1/device");
  assert.equal(created.body.callbackUrl, "https://shop.example.com/api/glyphpay/webhook");

  const written = await readFile(envFile, "utf8");
  assert.match(written, /^DATABASE_URL=postgres:\/\/local$/m);
  assert.match(written, /^OTHER=keep$/m);
  assert.match(written, new RegExp(`^GLYPHPAY_TOKEN=${NEXT_TOKEN}$`, "m"));
  assert.match(written, new RegExp(`^GLYPHPAY_CALLBACK_SECRET=dgcb_${"d".repeat(40)}$`, "m"));
  assert.equal(written.match(/GLYPHPAY_TOKEN=/g)?.length, 1);
});

test("--print leaves the filesystem alone and prints the credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glyphpay-cli-"));
  const outcome = await withFakeApi(async ({ baseUrl }) => {
    return runCli(["login", "--no-open", "--print", "--base-url", baseUrl, "--timeout", "20"], directory);
  });

  assert.equal(outcome.code, 0, outcome.stderr);
  assert.match(outcome.stdout, new RegExp(`GLYPHPAY_TOKEN=${NEXT_TOKEN}`));
  assert.doesNotMatch(outcome.stdout, new RegExp(`GLYPHPAY_CALLBACK_SECRET=${CALLBACK_SECRET}`));
  await assert.rejects(readFile(join(directory, ".env.local"), "utf8"), /ENOENT/);
});

test("doctor validates the token, Stripe readiness, and a signed test event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glyphpay-doctor-"));
  const envFile = join(directory, ".env.local");

  await withWebhookReceiver(async ({ url, received }) => {
    await writeFile(envFile, `GLYPHPAY_TOKEN=${DEFAULT_TOKEN}\nGLYPHPAY_CALLBACK_SECRET=${CALLBACK_SECRET}\n`, "utf8");
    const outcome = await withFakeApi(
      async ({ baseUrl }) => runCli(["doctor", "--env", envFile, "--base-url", baseUrl, "--send-test-event"], directory),
      { callbackUrl: url, callbackSecret: CALLBACK_SECRET }
    );

    assert.equal(outcome.code, 0, outcome.stdout + outcome.stderr);
    assert.match(outcome.stdout, /Glyph Pay accepted the token/);
    assert.match(outcome.stdout, /Stripe connected account can accept charges/);
    assert.match(outcome.stdout, /Signed test event accepted \(HTTP 204\)/);
    assert.match(outcome.stdout, /No blocking problems found/);

    const delivered = received.find((entry) => entry.method === "POST");
    assert.ok(delivered, "expected a POSTed test event");
    const [t, v1] = delivered.headers["designglyph-signature"].split(",").map((part) => part.split("=")[1]);
    const expected = createHmac("sha256", CALLBACK_SECRET).update(`${t}.${delivered.body}`).digest("hex");
    assert.equal(v1, expected);
    const event = JSON.parse(delivered.body);
    assert.equal(event.type, "webhook.test");
    assert.equal(event.data.orderId, "glyphpay-doctor");
    assert.equal(event.data.status, "test");
  });
});

test("connect refuses a verification URL on an untrusted origin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glyphpay-cli-origin-"));
  const outcome = await withFakeApi(
    async ({ baseUrl }) => runCli(["connect", "--no-open", "--base-url", baseUrl, "--timeout", "20"], directory),
    { verificationUrl: "https://lookalike.example/cli?code=ABCD-EFGH" }
  );

  assert.equal(outcome.code, 1);
  assert.match(outcome.stdout, /different origin/);
});

test("doctor fails when a credential is exposed through a public env variable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glyphpay-doctor-public-"));
  const envFile = join(directory, ".env.local");
  await writeFile(
    envFile,
    `GLYPHPAY_TOKEN=${DEFAULT_TOKEN}\nGLYPHPAY_CALLBACK_SECRET=${CALLBACK_SECRET}\nNEXT_PUBLIC_GLYPHPAY_TOKEN=${DEFAULT_TOKEN}\n`,
    "utf8"
  );

  const outcome = await withFakeApi(
    async ({ baseUrl }) => runCli(["doctor", "--json", "--env", envFile, "--base-url", baseUrl], directory)
  );

  assert.equal(outcome.code, 1);
  const report = JSON.parse(outcome.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((check) => check.id === "public-env" && check.status === "error"));
});

test("disconnect revokes the credential and removes only the managed keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glyphpay-disconnect-"));
  const envFile = join(directory, ".env.local");
  await writeFile(
    envFile,
    `DATABASE_URL=postgres://local\nGLYPHPAY_TOKEN=${DEFAULT_TOKEN}\nOTHER=keep\nGLYPHPAY_CALLBACK_SECRET=${CALLBACK_SECRET}\n`,
    "utf8"
  );

  const outcome = await withFakeApi(async ({ baseUrl, requests, getRevoked }) => {
    const result = await runCli(["disconnect", "--yes", "--env", envFile, "--base-url", baseUrl], directory);
    return { result, requests, revoked: getRevoked() };
  });

  assert.equal(outcome.result.code, 0, outcome.result.stdout + outcome.result.stderr);
  assert.equal(outcome.revoked, true);
  assert.ok(outcome.requests.some((request) => request.path === "/api/cli/v1/credential/revoke"));
  const written = await readFile(envFile, "utf8");
  assert.match(written, /^DATABASE_URL=postgres:\/\/local$/m);
  assert.match(written, /^OTHER=keep$/m);
  assert.doesNotMatch(written, /GLYPHPAY_TOKEN/);
  assert.doesNotMatch(written, /GLYPHPAY_CALLBACK_SECRET/);
});

test("disconnect refuses to act without --yes in a non-interactive shell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glyphpay-disconnect-tty-"));
  const envFile = join(directory, ".env.local");
  await writeFile(envFile, `GLYPHPAY_TOKEN=${DEFAULT_TOKEN}\n`, "utf8");

  const outcome = await runCli(["disconnect", "--env", envFile], directory);
  assert.equal(outcome.code, 2);
  assert.match(outcome.stdout, /Use --yes/);
  assert.match(await readFile(envFile, "utf8"), /GLYPHPAY_TOKEN/);
});

test("rotate reuses the registered callback URL and writes the replacement token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glyphpay-rotate-"));
  const envFile = join(directory, ".env.local");
  await writeFile(
    envFile,
    `GLYPHPAY_TOKEN=${DEFAULT_TOKEN}\nGLYPHPAY_CALLBACK_SECRET=${CALLBACK_SECRET}\n`,
    "utf8"
  );

  const outcome = await withFakeApi(async ({ baseUrl, requests }) => {
    const result = await runCli(["rotate", "--no-open", "--env", envFile, "--base-url", baseUrl, "--timeout", "20"], directory);
    return { result, requests };
  });

  assert.equal(outcome.result.code, 0, outcome.result.stdout + outcome.result.stderr);
  const created = outcome.requests.find((request) => request.path === "/api/cli/v1/device");
  assert.equal(created.body.callbackUrl, "https://shop.example.com/api/glyphpay/webhook");
  const written = await readFile(envFile, "utf8");
  assert.match(written, new RegExp(`^GLYPHPAY_TOKEN=${NEXT_TOKEN}$`, "m"));
  assert.match(written, new RegExp(`^GLYPHPAY_CALLBACK_SECRET=dgcb_${"d".repeat(40)}$`, "m"));
});

test("init scaffolds the Next.js App Router without touching unrelated env keys", async () => {
  const project = await mkdtemp(join(tmpdir(), "glyphpay-init-"));
  await writeFile(join(project, "package.json"), JSON.stringify({ dependencies: { next: "^16.0.0" } }), "utf8");
  await writeFile(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }), "utf8");
  await writeFile(join(project, ".env.example"), "DATABASE_URL=\n", "utf8");
  await mkdir(join(project, "app"), { recursive: true });

  const result = await runCli(["init", "--dir", project], project);
  assert.equal(result.code, 0, result.stdout + result.stderr);

  const lib = await readFile(join(project, "lib", "glyphpay.ts"), "utf8");
  assert.match(lib, /glyphPay\(/);
  assert.match(lib, /priceOrder/);

  const checkout = await readFile(join(project, "app", "api", "glyphpay", "checkout", "route.ts"), "utf8");
  assert.match(checkout, /export const POST = glyphpay\.checkout/);
  assert.match(checkout, /\.\.\/\.\.\/\.\.\/\.\.\/lib\/glyphpay/);

  const webhook = await readFile(join(project, "app", "api", "glyphpay", "webhook", "route.ts"), "utf8");
  assert.match(webhook, /export const POST = glyphpay\.webhook/);

  const env = await readFile(join(project, ".env.example"), "utf8");
  assert.match(env, /^DATABASE_URL=$/m);
  assert.match(env, /^GLYPHPAY_TOKEN=$/m);
  assert.match(env, /^GLYPHPAY_CALLBACK_SECRET=$/m);

  const again = await runCli(["init", "--dir", project], project);
  assert.equal(again.code, 2);
  assert.match(again.stdout, /Refusing to overwrite/);

  const forced = await runCli(["init", "--dir", project, "--force"], project);
  assert.equal(forced.code, 0, forced.stdout + forced.stderr);
});

test("init supports src/app projects and --dry-run", async () => {
  const project = await mkdtemp(join(tmpdir(), "glyphpay-init-src-"));
  await writeFile(join(project, "package.json"), JSON.stringify({ dependencies: { next: "^16.0.0" } }), "utf8");
  await mkdir(join(project, "src", "app"), { recursive: true });

  const result = await runCli(["init", "--dir", project, "--dry-run"], project);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Would create src\/lib\/glyphpay\.js/);
  await assert.rejects(readFile(join(project, "src", "lib", "glyphpay.js"), "utf8"), /ENOENT/);
});

test("deliveries lists recent callbacks and retries one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glyphpay-deliveries-"));
  const envFile = join(directory, ".env.local");
  await writeFile(envFile, `GLYPHPAY_TOKEN=${DEFAULT_TOKEN}\n`, "utf8");

  const outcome = await withFakeApi(async ({ baseUrl, requests }) => {
    const listed = await runCli(["deliveries", "--env", envFile, "--base-url", baseUrl], directory);
    const filtered = await runCli(
      ["deliveries", "--state", "failed", "--limit", "1", "--env", envFile, "--base-url", baseUrl],
      directory
    );
    const retried = await runCli(
      ["deliveries", "--retry", "evt_failed_1", "--env", envFile, "--base-url", baseUrl],
      directory
    );
    return { listed, filtered, retried, requests };
  });

  assert.equal(outcome.listed.code, 0, outcome.listed.stderr);
  assert.match(outcome.listed.stdout, /Webhook deliveries - Petal Pushers Test LLC/);
  assert.match(outcome.listed.stdout, /evt_failed_1/);
  assert.match(outcome.listed.stdout, /FAILED/);
  assert.match(outcome.listed.stdout, /Webhook returned HTTP 500/);

  assert.equal(outcome.filtered.code, 0, outcome.filtered.stderr);
  assert.match(outcome.filtered.stdout, /Next page: glyphpay deliveries --state failed --limit 1 --cursor next_cursor/);
  const filteredRequest = outcome.requests.find(
    (request) => request.path === "/api/cli/v1/credential/deliveries" && request.query.includes("state=failed")
  );
  assert.ok(filteredRequest);

  assert.equal(outcome.retried.code, 0, outcome.retried.stderr);
  assert.match(outcome.retried.stdout, /Webhook delivered/);
  assert.match(outcome.retried.stdout, /evt_failed_1/);

  const replay = outcome.requests.find(
    (request) => request.path === "/api/cli/v1/credential/deliveries/evt_failed_1/replay"
  );
  assert.equal(replay.method, "POST");
  assert.equal(replay.authorization, `Bearer ${DEFAULT_TOKEN}`);
});

test("init detects Remix, Astro, SvelteKit, Hono, and Express", async () => {
  const cases = [
    {
      name: "sveltekit",
      dependencies: { "@sveltejs/kit": "^2.0.0" },
      file: ["src", "routes", "api", "glyphpay", "checkout", "+server.ts"],
      pattern: /RequestHandler/,
      lib: ["src", "lib", "server", "glyphpay.ts"],
    },
    {
      name: "astro",
      dependencies: { astro: "^5.0.0" },
      file: ["src", "pages", "api", "glyphpay", "checkout.ts"],
      pattern: /APIRoute/,
      lib: ["src", "lib", "glyphpay.ts"],
    },
    {
      name: "remix",
      dependencies: { "@remix-run/node": "^2.0.0" },
      file: ["app", "routes", "api.glyphpay.checkout.ts"],
      pattern: /action\(/,
      lib: ["app", "lib", "glyphpay.server.ts"],
    },
    {
      name: "hono",
      dependencies: { hono: "^4.0.0" },
      file: ["src", "glyphpay-routes.ts"],
      pattern: /glyphpayRoutes\.post\("\/checkout"/,
      lib: ["src", "lib", "glyphpay.ts"],
    },
    {
      name: "express",
      dependencies: { express: "^4.0.0" },
      file: ["src", "glyphpay-routes.ts"],
      pattern: /express\.raw/,
      lib: ["src", "lib", "glyphpay.ts"],
    },
  ];

  for (const entry of cases) {
    const project = await mkdtemp(join(tmpdir(), `glyphpay-init-${entry.name}-`));
    await writeFile(join(project, "package.json"), JSON.stringify({ dependencies: entry.dependencies }), "utf8");
    await writeFile(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }), "utf8");

    const result = await runCli(["init", "--dir", project], project);
    assert.equal(result.code, 0, `${entry.name}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, new RegExp(`Framework: ${entry.name}`));

    const route = await readFile(join(project, ...entry.file), "utf8");
    assert.match(route, entry.pattern, `${entry.name} route`);
    if (entry.name === "express") {
      assert.match(route, /publicOrigin/);
      assert.match(route, /trust proxy/);
      assert.match(route, /req\.get\("x-forwarded-host"\)/);
      assert.doesNotMatch(route, /firstHeader/);
      assert.doesNotMatch(route, /req\.headers\["x-forwarded-proto"\]/);
    }
    const lib = await readFile(join(project, ...entry.lib), "utf8");
    assert.match(lib, /glyphPay\(/, `${entry.name} connector`);
    assert.match(lib, /beforeCheckout/);
    assert.match(lib, /same transaction/);
  }
});

test("a bad flag exits with a usage error", async () => {
  const outcome = await runCli(["--timeout", "2"], process.cwd());
  assert.equal(outcome.code, 2);
  assert.match(outcome.stdout, /--timeout must be between 10 and 1800 seconds/);
});

test("env helpers preserve unrelated lines and public-prefix detection is strict", () => {
  const next = upsertEnv(
    "A=1\r\nGLYPHPAY_TOKEN=old\r\nB=2\r\nGLYPHPAY_TOKEN=duplicate\r\n",
    { GLYPHPAY_TOKEN: "new", GLYPHPAY_CALLBACK_SECRET: "secret" }
  );
  assert.equal(next, "A=1\r\nGLYPHPAY_TOKEN=new\r\nB=2\r\nGLYPHPAY_CALLBACK_SECRET=secret\r\n");

  assert.equal(ensureEnvKeys("GLYPHPAY_TOKEN=keep\n", ["GLYPHPAY_TOKEN", "GLYPHPAY_CALLBACK_SECRET"]), "GLYPHPAY_TOKEN=keep\nGLYPHPAY_CALLBACK_SECRET=\n");
  assert.equal(removeEnvKeys("A=1\nGLYPHPAY_TOKEN=x\nB=2\n", ["GLYPHPAY_TOKEN"]), "A=1\nB=2\n");
  assert.equal(readEnvValue('GLYPHPAY_TOKEN="quoted"\n', "GLYPHPAY_TOKEN"), "quoted");
  assert.deepEqual(findPublicCredentialKeys(`NEXT_PUBLIC_API_URL=https://x\nNEXT_PUBLIC_GLYPHPAY_TOKEN=${DEFAULT_TOKEN}\n`), [
    "NEXT_PUBLIC_GLYPHPAY_TOKEN",
  ]);
});

test("toCallbackUrl accepts a bare host and keeps an explicit path", () => {
  assert.equal(toCallbackUrl("shop.example.com"), "https://shop.example.com/api/glyphpay/webhook");
  assert.equal(
    toCallbackUrl("https://shop.example.com/custom/payments"),
    "https://shop.example.com/custom/payments"
  );
  assert.equal(toCallbackUrl("http://localhost:3000"), "http://localhost:3000/api/glyphpay/webhook");
});

test("toCallbackUrl rejects plain http outside loopback and unsafe hosts", () => {
  assert.throws(() => toCallbackUrl("http://shop.example.com"), /https/);
  assert.throws(() => toCallbackUrl("https://shop.example.com:8443/hook"), /default https port/);
  assert.throws(() => toCallbackUrl("https://user:pass@shop.example.com"), /username or password/);
  assert.throws(() => toCallbackUrl("https://10.0.0.5/hook"), /IP address/);
  assert.throws(() => toCallbackUrl("https://169.254.169.254/latest"), /IP address/);
  assert.throws(() => toCallbackUrl("https://payments.internal/hook"), /public hostname/);
});

test("base URL and doctor URL checks require HTTPS outside loopback", () => {
  assert.throws(() => normalizeApiBaseUrl("http://api.example.com"), /https/);
  assert.equal(normalizeApiBaseUrl("https://api.example.com/"), "https://api.example.com");
  assert.equal(normalizeApiBaseUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");

  assert.equal(isPublicHttpsUrl("https://shop.example.com/hook"), true);
  assert.equal(isPublicHttpsUrl("http://shop.example.com/hook"), false);
  assert.equal(isPublicHttpsUrl("https://127.0.0.1/hook"), false);
  assert.equal(isPublicHttpsUrl("https://10.0.0.5/hook"), false);
  assert.equal(isProbeableCallbackUrl("http://127.0.0.1:3000/hook"), true);
});

test("upsertEnv rejects newline injection and invalid keys", () => {
  assert.throws(
    () => upsertEnv("", { GLYPHPAY_TOKEN: "abc\nNODE_OPTIONS=--require ./evil.js" }),
    /line break or NUL/
  );
  assert.throws(() => upsertEnv("", { "BAD KEY": "x" }), /Invalid environment key/);
});

test("sanitizeTerminal removes ANSI escapes and control characters", () => {
  assert.equal(sanitizeTerminal("\u001b[31mred\u001b[0m\nnext"), "red next");
  assert.doesNotMatch(sanitizeTerminal("ok\u001b]0;title\u0007"), /\u001b/);
});
