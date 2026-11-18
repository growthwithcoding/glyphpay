#!/usr/bin/env node
/**
 * Glyph Pay command line.
 *
 * `connect` creates a short-lived pairing request, opens the Glyph Pay site,
 * and waits while the signed-in owner approves it in the browser. The service
 * credential and webhook signing secret are returned only to this process,
 * then written to the site's server environment file.
 *
 * `doctor` verifies the local setup and, optionally, delivers a signed test
 * webhook. `disconnect` revokes the credential. `rotate` re-pairs and replaces
 * it. `init` scaffolds a framework integration. `deliveries` lists callback
 * attempts and replays one on demand.
 *
 * Zero runtime dependencies: Node 18+ built-ins and global fetch only.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { ensureGitignoreEntries, findEnvFiles, isEnvFileName, selectEnvFile, syncEnvSupportFiles } from "./envfiles.js";

const VERSION = "2.3.0";
const DEFAULT_BASE_URL = "https://designglyph.web.app";
// The browser approval page is served by the site origin, which can differ
// from the API host. Keep this small and explicit; never open an arbitrary
// server-supplied origin.
const TRUSTED_VERIFICATION_ORIGINS = new Set([
  "https://designglyph.com",
  "https://www.designglyph.com",
]);
const DEFAULT_ENV_FILE = ".env.local";
const DEFAULT_TIMEOUT_SECONDS = 600;
const TOKEN_KEY = "GLYPHPAY_TOKEN";
const CALLBACK_SECRET_KEY = "GLYPHPAY_CALLBACK_SECRET";
const WEBHOOK_PATH = "/api/glyphpay/webhook";
const TOKEN_PATTERN = /^dgsvc_(test|live)_[A-Za-z0-9_-]{1,128}_[A-Za-z0-9_-]{43}$/;
const CALLBACK_SECRET_PATTERN = /^whsec_[A-Za-z0-9+/]{20,}={0,2}$/;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class CliApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CliApiError";
    this.status = status;
    this.code = code;
  }
}

export interface CliOptions {
  /** Site URL (a webhook path is appended when the URL has no path), or the exact callback URL. */
  url?: string;
  /** Env file to read or update. Defaults to `.env.local`. */
  envFile?: string;
  /** Print the credentials instead of writing them to a file. */
  print?: boolean;
  /** Skip opening a browser. */
  noOpen?: boolean;
  /** API origin. Defaults to GLYPHPAY_API_URL or production. */
  baseUrl?: string;
  /** How long to wait for browser approval. */
  timeoutSeconds?: number;
  /** Connect: print pairing details as JSON, then exit without waiting. */
  nonInteractive?: boolean;
  /** Connect: finish a pairing started with `--non-interactive`. */
  pollDeviceCode?: string;
  /** Machine-readable doctor output. */
  json?: boolean;
  /** Skip the interactive disconnect confirmation. */
  yes?: boolean;
  /** Keep local env values after a successful disconnect. */
  keepEnv?: boolean;
  /** Doctor: deliver a signed test event to the registered webhook. */
  sendTestEvent?: boolean;
  /** Init: overwrite generated files. */
  force?: boolean;
  /** Init: print planned files without writing. */
  dryRun?: boolean;
  /** Init/setup: project directory. Defaults to the current directory. */
  dir?: string;
  /** Setup: deployment target (firebase-functions, next, remix, astro, sveltekit, hono, express). */
  target?: string;
  /** Setup: preset (custom or firestore-invoices). */
  preset?: string;
  /** Setup: generated UI (react or none). */
  ui?: string;
  /** Setup: Firebase Functions source directory. Defaults to firebase.json. */
  functionsDir?: string;
  /** Setup: Firebase HTTPS function export name. */
  functionId?: string;
  /** Setup: Firebase Functions region. */
  region?: string;
  /** Setup: checkout route path. */
  checkoutPath?: string;
  /** Setup: webhook route path. */
  webhookPath?: string;
  /** Setup: invoice status route path. */
  statusPath?: string;
  /** Deliveries: replay one failed or delivered callback by id. */
  retry?: string;
  /** Deliveries: filter by delivery state. */
  state?: "pending" | "delivered" | "failed";
  /** Deliveries: opaque next-page cursor returned by the API. */
  cursor?: string;
  /** Deliveries: page size, 1-100. */
  limit?: number;
}

export interface ConnectResult {
  businessName: string;
  environment: "test" | "live";
  callbackUrl: string | null;
  writtenTo: string | null;
  /** Set when `--non-interactive` printed pairing details instead of waiting. */
  pending?: boolean;
  verificationUrl?: string;
  userCode?: string;
  deviceCode?: string;
  nextCommand?: string;
}

export interface DisconnectResult {
  businessName: string | null;
  removedKeys: boolean;
  alreadyRevoked: boolean;
  canceled: boolean;
}

interface CreatedDevice {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  interval: number;
  environment: "test" | "live";
}

interface PendingDevice {
  status: "pending";
  expiresAt: string;
  interval: number;
}

interface ApprovedDevice {
  status: "approved";
  token: string;
  callbackSecret: string | null;
  businessId: string;
  businessName: string;
  callbackUrl: string | null;
  environment: "test" | "live";
  expiresAt: string;
}

type PollResult = PendingDevice | ApprovedDevice;

interface CredentialInfo {
  businessId: string;
  businessName: string;
  environment: "test" | "live";
  chargesEnabled: boolean;
  connectedAccountId: string | null;
  callbackUrl: string | null;
  callbackSecretConfigured: boolean;
  credentialCreatedAt: string;
  lastUsedAt: string | null;
}

export interface CallbackDeliveryView {
  id: string;
  paymentId: string;
  type: string;
  state: "pending" | "delivered" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CallbackDeliveriesResponse {
  businessId: string;
  businessName: string;
  environment: "test" | "live";
  deliveries: CallbackDeliveryView[];
  nextCursor: string | null;
}

export interface CallbackReplayResponse {
  outcome: "delivered" | "retry" | "failed";
  detail?: string;
  delivery: CallbackDeliveryView;
}

type Command = "connect" | "rotate" | "disconnect" | "doctor" | "init" | "setup" | "deliveries" | "help" | "version";

interface ParsedCommand {
  command: Command;
  options: CliOptions;
}

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
function style(code: number, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}
function say(text = ""): void {
  process.stdout.write(`${text}\n`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/* ------------------------------------------------------------------ */
/* Argument parsing                                                    */
/* ------------------------------------------------------------------ */

function takeValue(argv: string[], index: number, flag: string): [string, number] {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new CliUsageError(`${flag} needs a value.`);
  return [value, index + 1];
}

function commandFor(value: string): Command | null {
  if (value === "connect" || value === "login") return "connect";
  if (value === "rotate") return "rotate";
  if (value === "disconnect" || value === "logout") return "disconnect";
  if (value === "doctor" || value === "check") return "doctor";
  if (value === "init") return "init";
  if (value === "setup") return "setup";
  if (value === "deliveries" || value === "webhooks") return "deliveries";
  return null;
}

export function parseArgs(argv: string[]): ParsedCommand {
  const options: CliOptions = {};
  let command: Command = "connect";
  let sawCommand = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h" || argument === "help") return { command: "help", options };
    if (argument === "--version" || argument === "-v") return { command: "version", options };

    const namedCommand = commandFor(argument);
    if (namedCommand) {
      if (sawCommand) throw new CliUsageError("Only one command can run at a time.");
      sawCommand = true;
      command = namedCommand;
      continue;
    }

    if (argument === "--print") {
      options.print = true;
      continue;
    }
    if (argument === "--no-open") {
      options.noOpen = true;
      continue;
    }
    if (argument === "--non-interactive") {
      options.nonInteractive = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--yes" || argument === "-y") {
      options.yes = true;
      continue;
    }
    if (argument === "--keep-env") {
      options.keepEnv = true;
      continue;
    }
    if (argument === "--send-test-event") {
      options.sendTestEvent = true;
      continue;
    }
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    const [flag, inlineValue] = argument.includes("=") ? argument.split(/=(.*)/s, 2) : [argument, undefined];
    if (flag === "--url" || flag === "--callback-url") {
      if (inlineValue !== undefined) {
        if (!inlineValue) throw new CliUsageError(`${flag} needs a value.`);
        options.url = inlineValue;
      } else {
        const [value, next] = takeValue(argv, index, flag);
        options.url = value;
        index = next;
      }
      continue;
    }
    if (flag === "--poll") {
      if (inlineValue !== undefined) {
        if (!inlineValue) throw new CliUsageError("--poll needs a device code.");
        options.pollDeviceCode = inlineValue;
      } else {
        const [value, next] = takeValue(argv, index, flag);
        options.pollDeviceCode = value;
        index = next;
      }
      continue;
    }
    if (flag === "--env") {
      if (inlineValue !== undefined) {
        if (!inlineValue) throw new CliUsageError("--env needs a path.");
        options.envFile = inlineValue;
      } else {
        const [value, next] = takeValue(argv, index, flag);
        options.envFile = value;
        index = next;
      }
      continue;
    }
    if (flag === "--base-url") {
      if (inlineValue !== undefined) {
        if (!inlineValue) throw new CliUsageError("--base-url needs a URL.");
        options.baseUrl = inlineValue;
      } else {
        const [value, next] = takeValue(argv, index, flag);
        options.baseUrl = value;
        index = next;
      }
      continue;
    }
    if (flag === "--retry") {
      if (inlineValue !== undefined) {
        if (!inlineValue) throw new CliUsageError("--retry needs a delivery id.");
        options.retry = inlineValue;
      } else {
        const [value, next] = takeValue(argv, index, flag);
        options.retry = value;
        index = next;
      }
      continue;
    }
    if (flag === "--state") {
      const raw = inlineValue ?? takeValue(argv, index, flag)[0];
      if (inlineValue === undefined) index += 1;
      if (raw !== "pending" && raw !== "delivered" && raw !== "failed") {
        throw new CliUsageError("--state must be pending, delivered, or failed.");
      }
      options.state = raw;
      continue;
    }
    if (flag === "--cursor") {
      if (inlineValue !== undefined) {
        if (!inlineValue) throw new CliUsageError("--cursor needs a value.");
        options.cursor = inlineValue;
      } else {
        const [value, next] = takeValue(argv, index, flag);
        options.cursor = value;
        index = next;
      }
      continue;
    }
    if (flag === "--limit") {
      const raw = inlineValue ?? takeValue(argv, index, flag)[0];
      if (inlineValue === undefined) index += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new CliUsageError("--limit must be an integer between 1 and 100.");
      }
      options.limit = parsed;
      continue;
    }
    if (
      flag === "--target" ||
      flag === "--preset" ||
      flag === "--ui" ||
      flag === "--functions-dir" ||
      flag === "--function-id" ||
      flag === "--region" ||
      flag === "--checkout-path" ||
      flag === "--webhook-path" ||
      flag === "--status-path"
    ) {
      let raw: string;
      if (inlineValue !== undefined) {
        if (!inlineValue) throw new CliUsageError(`${flag} needs a value.`);
        raw = inlineValue;
      } else {
        const [value, next] = takeValue(argv, index, flag);
        raw = value;
        index = next;
      }
      if (flag === "--target") options.target = raw;
      else if (flag === "--preset") options.preset = raw;
      else if (flag === "--ui") options.ui = raw;
      else if (flag === "--functions-dir") options.functionsDir = raw;
      else if (flag === "--function-id") options.functionId = raw;
      else if (flag === "--region") options.region = raw;
      else if (flag === "--checkout-path") options.checkoutPath = raw;
      else if (flag === "--webhook-path") options.webhookPath = raw;
      else options.statusPath = raw;
      continue;
    }
    if (flag === "--dir") {
      if (inlineValue !== undefined) {
        if (!inlineValue) throw new CliUsageError("--dir needs a path.");
        options.dir = inlineValue;
      } else {
        const [value, next] = takeValue(argv, index, flag);
        options.dir = value;
        index = next;
      }
      continue;
    }
    if (flag === "--timeout") {
      const raw = inlineValue ?? takeValue(argv, index, flag)[0];
      if (inlineValue === undefined) index += 1;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 10 || parsed > 1800) {
        throw new CliUsageError("--timeout must be between 10 and 1800 seconds.");
      }
      options.timeoutSeconds = Math.floor(parsed);
      continue;
    }

    if (argument.startsWith("-")) throw new CliUsageError(`Unknown option: ${argument}`);
    throw new CliUsageError(`Unknown command: ${argument}`);
  }

  return { command, options };
}

export function helpText(): string {
  return `glyphpay - take payments on your site through Glyph Pay

Usage
  glyphpay connect [options]       Connect a site (alias: login)
  glyphpay rotate [options]        Re-pair and rotate the current credential
  glyphpay disconnect [options]    Revoke the credential and remove local keys
  glyphpay doctor [options]        Check env, token, Stripe and webhook setup
  glyphpay deliveries [options]    List recent webhook deliveries
  glyphpay init [options]          Scaffold an integration for your framework
  glyphpay setup [options]         Detect the stack and scaffold a full integration
  glyphpay --version

Connect / rotate
  --url <site-url>         Site to connect. Adds ${WEBHOOK_PATH} when the URL
                           has no path. Or pass the exact callback URL.
  --env <path>             Env file to update (default: the project's
                           detected .env.local or .env)
  --print                  Print the credentials instead of writing a file
  --no-open                Do not open a browser automatically
  --non-interactive        Print verification URL/code as JSON and exit
  --poll <device-code>     Finish a pairing started with --non-interactive
  --base-url <url>         Glyph Pay API origin (default: ${DEFAULT_BASE_URL})
  --timeout <seconds>      Wait for approval (default: ${DEFAULT_TIMEOUT_SECONDS})

Doctor
  --json                   Print a machine-readable report
  --send-test-event        POST a signed webhook.test event to the callback URL

Disconnect
  --yes, -y                Do not ask for confirmation
  --keep-env               Keep the local env values after revocation

Deliveries
  --state <state>          pending, delivered, or failed
  --limit <n>              Page size, 1-100 (default: 50)
  --cursor <cursor>        Next-page cursor from the previous response
  --retry <id>             Send one stored webhook again (alias: webhooks)
  --json                   Print a machine-readable response

Init
  --dir <path>             Project directory (default: current directory)
  --dry-run                Show planned files without writing them
  --force                  Overwrite generated files

Setup
  --target <target>        firebase-functions, next, remix, astro, sveltekit,
                           hono, or express (default: detected framework)
  --preset <preset>        custom, or firestore-invoices for Firebase Functions
  --ui <ui>                react (invoice wrapper) or none
  --dir <path>             Project directory (default: current directory)
  --functions-dir <path>   Firebase Functions source (default: firebase.json)
  --function-id <name>     HTTPS function export name (default: glyphpaySite)
  --region <region>        Firebase Functions region (default: us-central1)
  --checkout-path <path>   Default: /api/glyphpay/checkout
  --webhook-path <path>    Default: /api/glyphpay/webhook
  --status-path <path>     Default: /api/glyphpay/status
  --json                   Print a machine-readable result
  --dry-run                Show planned changes without writing them
  --force                  Overwrite generated files that differ

The browser step signs in to Glyph Pay, lets you pick the client account, and
approves this machine. The service credential goes only to this terminal.

Connect also adds placeholders to the project's example env file and makes
sure .gitignore covers the file that holds the credential.`;
}

/* ------------------------------------------------------------------ */
/* URL and env-file helpers                                            */
/* ------------------------------------------------------------------ */

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Strip ANSI escapes and control characters from server-controlled text before printing it. */
export function sanitizeTerminal(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Validate and normalize the API origin. HTTPS is required outside loopback development. */
export function normalizeApiBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliUsageError("--base-url is not a valid URL.");
  }
  if (url.username || url.password) throw new CliUsageError("--base-url must not contain credentials.");
  if (url.protocol !== "https:" && !(isLoopbackHost(url.hostname) && url.protocol === "http:")) {
    throw new CliUsageError("--base-url must use https:// (http:// is allowed only for localhost).");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** True when a browser URL is https, or http on loopback. */
export function isSafeBrowserUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(isLoopbackHost(url.hostname) && url.protocol === "http:")) return false;
    return !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Pin a server-supplied verification URL to the API or the known web app. */
export function isTrustedVerificationOrigin(raw: string, baseUrl: string): boolean {
  try {
    const origin = new URL(raw).origin;
    return origin === new URL(baseUrl).origin || TRUSTED_VERIFICATION_ORIGINS.has(origin);
  } catch {
    return false;
  }
}

/** True when a callback URL is public HTTPS (no credentials, IP literals, or internal names). */
export function isPublicHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || isLoopbackHost(host) || !host.includes(".")) return false;
    if (/\.(localhost|local|internal|lan|home|corp)$/.test(host)) return false;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
    return true;
  } catch {
    return false;
  }
}

/** Doctor may probe a public HTTPS callback, or loopback HTTP for local testing. */
export function isProbeableCallbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return isPublicHttpsUrl(raw);
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/** `shop.example.com` -> `https://shop.example.com/api/glyphpay/webhook`. */
export function toCallbackUrl(raw: string): string {
  let value = raw.trim();
  if (!value) throw new CliUsageError("Enter the site's URL.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliUsageError(`"${raw}" is not a valid URL.`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = isLoopbackHost(host);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new CliUsageError("The site URL must use https:// (http:// is allowed only for localhost).");
  }
  if (url.username || url.password) throw new CliUsageError("The site URL must not contain a username or password.");
  if (url.protocol === "https:" && url.port && url.port !== "443") {
    throw new CliUsageError("The site URL must use the default https port.");
  }
  if (!loopback && !host.includes(".")) throw new CliUsageError("The site URL must use a public hostname.");
  if (!loopback && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    throw new CliUsageError("The site URL must use a public hostname, not an IP address.");
  }
  if (!loopback && host.includes(":")) throw new CliUsageError("The site URL must use a public hostname, not an IP address.");
  if (!loopback && /\.(localhost|local|internal|lan|home|corp)$/.test(host)) {
    throw new CliUsageError("The site URL must use a public hostname.");
  }
  if (url.pathname === "/" || url.pathname === "") url.pathname = WEBHOOK_PATH;
  url.hash = "";
  return url.toString();
}

/**
 * Replace values in an env file without touching unrelated lines. The first
 * occurrence of a managed key is rewritten; duplicate managed keys are dropped
 * so the file keeps a single source of truth.
 */
export function upsertEnv(contents: string, values: Record<string, string>): string {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new CliUsageError(`Invalid environment key: ${key}`);
    if (/[\r\n\0]/.test(value)) {
      throw new CliUsageError(`Refusing to write ${key}: the value contains a line break or NUL byte.`);
    }
  }
  const eol = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.length
    ? contents.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")
    : [];
  const pending = new Map(Object.entries(values));
  const handled = new Set<string>();
  const output: string[] = [];

  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (key && pending.has(key)) {
      output.push(`${key}=${pending.get(key)}`);
      pending.delete(key);
      handled.add(key);
      continue;
    }
    if (key && handled.has(key)) continue;
    output.push(line);
  }

  for (const [key, value] of pending) output.push(`${key}=${value}`);
  return `${output.join(eol)}${eol}`;
}

/** Add missing `KEY=` placeholders without changing an existing value. */
export function ensureEnvKeys(contents: string, keys: string[]): string {
  const missing = keys.filter(
    (key) => !new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "m").test(contents)
  );
  if (missing.length === 0) return contents;
  const base = contents.length && !contents.endsWith("\n") ? `${contents}\n` : contents;
  return `${base}${missing.map((key) => `${key}=`).join("\n")}\n`;
}

/** Remove managed keys, preserving every unrelated line. */
export function removeEnvKeys(contents: string, keys: string[]): string {
  if (!contents.length) return "";
  const managed = new Set(keys);
  const eol = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const output = lines.filter((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return !(match && managed.has(match[1]));
  });
  return output.length ? `${output.join(eol)}${eol}` : "";
}

/** Read a simple KEY=value line without executing or expanding the file. */
export function readEnvValue(contents: string, key: string): string | null {
  const match = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, "m").exec(contents);
  if (!match) return null;
  const raw = match[1].trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** Public-prefixed variables must never contain a Glyph Pay credential. */
export function findPublicCredentialKeys(contents: string): string[] {
  const exposed: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?((?:NEXT_PUBLIC_|VITE_|PUBLIC_)[A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && /(?:dgsvc_|whsec_|GLYPHPAY_(?:TOKEN|CALLBACK_SECRET))/.test(match[2])) {
      exposed.push(match[1]);
    }
  }
  return exposed;
}

/* ------------------------------------------------------------------ */
/* Env file selection                                                  */
/* ------------------------------------------------------------------ */

export { ensureGitignoreEntries, findEnvFiles, isEnvFileName };

/**
 * Pick the env file that should hold the credential. `--env` always wins.
 * Otherwise the project's own env files are scanned, because sites differ:
 * `.env` on some, `.env.local` on others.
 */
async function resolveEnvFileForCli(options: CliOptions, allowPrompt: boolean): Promise<string> {
  const selection = await selectEnvFile({
    directory: options.dir ?? process.cwd(),
    envFile: options.envFile,
    managedKeys: [TOKEN_KEY, CALLBACK_SECRET_KEY],
    fallback: DEFAULT_ENV_FILE,
  });
  if (!options.envFile && selection.candidates.length > 1) {
    return chooseEnvFile(selection.directory, selection.candidates, allowPrompt);
  }
  return selection.path;
}

/** Ask which detected env file to use when the terminal allows it. */
async function chooseEnvFile(directory: string, candidates: string[], allowPrompt: boolean): Promise<string> {
  const where = relative(process.cwd(), directory) || ".";
  if (allowPrompt && process.stdin.isTTY && process.stdout.isTTY) {
    say();
    say(`${candidates.length} env files found in ${where}:`);
    candidates.forEach((name, index) => say(`  ${index + 1}. ${name}${index === 0 ? "  (default)" : ""}`));
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answer = "";
    try {
      answer = await prompt.question("Which file should hold the Glyph Pay credential? [1] ");
    } finally {
      prompt.close();
    }
    const choice = answer.trim();
    if (!choice) return join(directory, candidates[0]);
    const index = Number(choice);
    if (Number.isInteger(index) && index >= 1 && index <= candidates.length) {
      return join(directory, candidates[index - 1]);
    }      const named = candidates.find((name) => name === choice || resolve(directory, choice) === join(directory, name));
    if (named) return join(directory, named);
    throw new CliUsageError(`"${choice}" is not one of the detected env files. Pass --env <path> to name another file.`);
  }
  process.stderr.write(
    `Glyph Pay: found multiple env files in ${where}; using ${candidates[0]}. Pass --env <path> to pick another.\n`
  );
  return join(directory, candidates[0]);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readEnvFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return "";
    throw error;
  }
}

async function writeEnvFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows does not use POSIX modes; the file still lives in the project.
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Browser and API                                                     */
/* ------------------------------------------------------------------ */

export function openBrowser(rawUrl: string): boolean {
  if (!isSafeBrowserUrl(rawUrl)) return false;
  const url = new URL(rawUrl).toString();
  const command =
    process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function api<T>(baseUrl: string, path: string, body?: unknown, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/cli/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "user-agent": `glyphpay-cli/${VERSION}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new CliApiError(0, "network", "Could not reach Glyph Pay. Check your connection and try again.");
  }

  const payload = (await response.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error?: { code?: string; message?: string } }
    | null;
  if (!response.ok || !payload?.ok) {
    throw new CliApiError(
      response.status,
      payload && "error" in payload ? payload.error?.code ?? "request_failed" : "request_failed",
      (payload && "error" in payload ? payload.error?.message : null) ??
        `Glyph Pay request failed (HTTP ${response.status}).`
    );
  }
  return payload.data;
}

function baseUrlFor(options: CliOptions): string {
  const raw = options.baseUrl?.trim() || process.env.GLYPHPAY_API_URL?.trim() || DEFAULT_BASE_URL;
  const normalized = normalizeApiBaseUrl(raw);
  if (normalized !== DEFAULT_BASE_URL) {
    process.stderr.write(`Glyph Pay: using API origin ${normalized}\n`);
  }
  return normalized;
}

function fetchCredential(baseUrl: string, token: string): Promise<CredentialInfo> {
  return api<CredentialInfo>(baseUrl, "/credential", undefined, token);
}

async function waitForApproval(
  baseUrl: string,
  deviceCode: string,
  firstInterval: number,
  timeoutMs: number
): Promise<ApprovedDevice> {
  const deadline = Date.now() + timeoutMs;
  let interval = Math.max(1, firstInterval);
  let lastNetworkError: string | null = null;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    try {
      const result = await api<PollResult>(baseUrl, "/device/token", { deviceCode });
      if (result.status === "approved") return result;
      interval = Math.max(1, result.interval || interval);
      lastNetworkError = null;
    } catch (error) {
      if (error instanceof CliApiError && error.status === 429) {
        interval = Math.min(interval + 2, 10);
        continue;
      }
      if (error instanceof CliApiError && (error.status === 404 || error.status === 410)) throw error;
      lastNetworkError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new CliApiError(
    0,
    "timeout",
    `Timed out waiting for approval${lastNetworkError ? ` (last error: ${lastNetworkError})` : ""}. ` +
      "Run the command again for a fresh code."
  );
}

/* ------------------------------------------------------------------ */
/* Connect and rotate                                                  */
/* ------------------------------------------------------------------ */

/** Quote one argument for the display-only `nextCommand`; the value is not executed. */
function quoteCommandArg(value: string): string {
  return /^[A-Za-z0-9_.\/:@\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

export async function runConnect(
  options: CliOptions = {},
  mode: "connect" | "rotate" = "connect"
): Promise<ConnectResult> {
  const baseUrl = baseUrlFor(options);
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (mode === "rotate" && (options.nonInteractive || options.pollDeviceCode)) {
    throw new CliUsageError("--non-interactive and --poll are only supported for connect.");
  }
  if (options.pollDeviceCode && options.url) {
    throw new CliUsageError("--url cannot be used with --poll; the pairing already has its webhook.");
  }
  const callbackUrl = options.url ? toCallbackUrl(options.url) : null;

  let created: CreatedDevice | null = null;
  if (!options.pollDeviceCode) {
    created = await api<CreatedDevice>(baseUrl, "/device", { callbackUrl });
    if (!isSafeBrowserUrl(created.verificationUrl) || !isTrustedVerificationOrigin(created.verificationUrl, baseUrl)) {
      throw new CliApiError(
        0,
        "invalid_verification_url",
        "Glyph Pay returned a browser verification URL on a different origin. Refusing to open it."
      );
    }
    const verificationUrl = new URL(created.verificationUrl).toString();

    if (options.nonInteractive) {
      const command = ["npx", "glyphpay", "connect", "--poll", created.deviceCode, "--base-url", baseUrl];
      if (options.envFile) command.push("--env", options.envFile);
      if (options.print) command.push("--print");
      if (options.timeoutSeconds !== undefined) command.push("--timeout", String(options.timeoutSeconds));
      const nextCommand = command.map(quoteCommandArg).join(" ");
      say(
        JSON.stringify(
          {
            verificationUrl,
            userCode: created.userCode,
            deviceCode: created.deviceCode,
            expiresAt: created.expiresAt,
            environment: created.environment,
            nextCommand,
          },
          null,
          2
        )
      );
      return {
        businessName: "",
        environment: created.environment,
        callbackUrl,
        writtenTo: null,
        pending: true,
        verificationUrl,
        userCode: created.userCode,
        deviceCode: created.deviceCode,
        nextCommand,
      };
    }

    say();
    say(style(1, mode === "rotate" ? "Glyph Pay - rotate credential" : "Glyph Pay - connect a site"));
    say();
    say(`1. Open ${style(4, sanitizeTerminal(verificationUrl))}`);
    say(`2. Sign in and approve pairing code ${style(1, sanitizeTerminal(created.userCode))}.`);
    say(`   The code expires at ${new Date(created.expiresAt).toLocaleTimeString()}.`);
    if (options.noOpen) {
      say("   (Browser opening skipped: --no-open.)");
    } else if (openBrowser(verificationUrl)) {
      say("   A browser window should open.");
    } else {
      say("   Could not open a browser. Open the link above manually.");
    }
    say();
    say(mode === "rotate" ? "Waiting for approval (the previous token stays valid until then)..." : "Waiting for approval...");
  } else {
    say();
    say("Waiting for approval...");
  }

  const approved = await waitForApproval(
    baseUrl,
    options.pollDeviceCode ?? created!.deviceCode,
    options.pollDeviceCode ? 2 : created!.interval,
    timeoutSeconds * 1000
  );

  const tokenMode = TOKEN_PATTERN.exec(approved.token)?.[1];
  if (!tokenMode || tokenMode !== approved.environment) {
    throw new CliApiError(0, "invalid_credential", "Glyph Pay returned a credential that does not match its environment.");
  }
  if (approved.callbackSecret && !CALLBACK_SECRET_PATTERN.test(approved.callbackSecret)) {
    throw new CliApiError(0, "invalid_callback_secret", "Glyph Pay returned a callback secret in an unexpected format.");
  }

  const values: Record<string, string> = { [TOKEN_KEY]: approved.token };
  if (approved.callbackSecret) values[CALLBACK_SECRET_KEY] = approved.callbackSecret;

  say();
  say(style(1, `${mode === "rotate" ? "Rotated" : "Connected"} ${sanitizeTerminal(approved.businessName)} (${approved.environment} mode).`));
  if (approved.callbackUrl) say(`Webhook registered: ${sanitizeTerminal(approved.callbackUrl)}`);
  else say("No webhook was registered. Add one later in Glyph Pay admin if your site needs payment events.");

  let writtenTo: string | null = null;
  let support: Awaited<ReturnType<typeof syncEnvSupportFiles>> | null = null;
  if (options.print) {
    say();
    say("Add these to your server environment (never NEXT_PUBLIC_):");
    for (const [key, value] of Object.entries(values)) say(`${key}=${value}`);
  } else {
    const file = await resolveEnvFileForCli(options, true);
    try {
      const next = upsertEnv(await readEnvFile(file), values);
      await writeEnvFile(file, next);
      writtenTo = file;
      const display = relative(process.cwd(), file) || file;
      say(`Wrote ${Object.keys(values).join(" and ")} to ${display}.`);
      support = await syncEnvSupportFiles({
        envFile: file,
        projectRoot: options.dir ?? process.cwd(),
        managedKeys: [TOKEN_KEY, CALLBACK_SECRET_KEY],
      });
    } catch (error) {
      say();
      say(style(33, `Could not write ${file}: ${sanitizeTerminal(error instanceof Error ? error.message : String(error))}`));
      say("Copy these values into your server environment now; they are shown only this once:");
      for (const [key, value] of Object.entries(values)) say(`${key}=${value}`);
      throw new CliApiError(1, "env_write_failed", "The credentials were printed above but not saved to a file.");
    }
  }

  if (support) {
    const exampleDisplay = relative(process.cwd(), support.exampleFile) || support.exampleFile;
    if (support.exampleChanged) {
      say(`Added ${TOKEN_KEY} and ${CALLBACK_SECRET_KEY} placeholders to ${exampleDisplay}.`);
    }
    const ignoreDisplay = relative(process.cwd(), support.gitignoreFile) || support.gitignoreFile;
    if (support.gitignoreChanged) {
      say(`Added ${support.gitignoreEntry} to ${ignoreDisplay} so the credential is never committed.`);
    }
    for (const warning of support.warnings) say(style(33, warning));
  }

  say();
  say(
    mode === "rotate"
      ? "The previous token is already invalid. Deploy the new values before the next request."
      : "The token is shown only once. Run this command again to rotate it."
  );
  return {
    businessName: approved.businessName,
    environment: approved.environment,
    callbackUrl: approved.callbackUrl,
    writtenTo,
  };
}

/**
 * Re-pair the site. If the current env token is still valid, reuse the
 * callback URL registered on the server so a rotation does not drop webhooks.
 */
export async function runRotate(options: CliOptions = {}): Promise<ConnectResult> {
  const baseUrl = baseUrlFor(options);
  const envFile = await resolveEnvFileForCli(options, true);
  const contents = await readEnvFile(envFile);
  const token = readEnvValue(contents, TOKEN_KEY);
  let url = options.url;

  if (token) {
    try {
      const info = await fetchCredential(baseUrl, token);
      say();
      say(`Rotating ${sanitizeTerminal(info.businessName)} (${sanitizeTerminal(info.environment)} mode).`);
      if (!url && info.callbackUrl) url = info.callbackUrl;
    } catch (error) {
      if (error instanceof CliApiError && error.status === 401) {
        say(style(33, "The current token is no longer valid; starting a fresh connection."));
      } else {
        throw error;
      }
    }
  }

  return runConnect({ ...options, url }, "rotate");
}

/* ------------------------------------------------------------------ */
/* Disconnect                                                          */
/* ------------------------------------------------------------------ */

export async function runDisconnect(options: CliOptions = {}): Promise<DisconnectResult> {
  const baseUrl = baseUrlFor(options);
  const envFile = await resolveEnvFileForCli(options, true);
  const contents = await readEnvFile(envFile);
  const token = readEnvValue(contents, TOKEN_KEY);
  const displayEnv = relative(process.cwd(), envFile) || envFile;

  if (!token) {
    throw new CliUsageError(`No ${TOKEN_KEY} found in ${displayEnv}. Nothing to disconnect.`);
  }

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      throw new CliUsageError("Use --yes when running disconnect non-interactively.");
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answer = "";
    try {
      answer = await prompt.question(
        `Revoke this site's Glyph Pay credential? The site stops working immediately. [y/N] `
      );
    } finally {
      prompt.close();
    }
    if (!/^y(es)?$/i.test(answer.trim())) {
      say("Canceled.");
      return { businessName: null, removedKeys: false, alreadyRevoked: false, canceled: true };
    }
  }

  let businessName: string | null = null;
  let alreadyRevoked = false;
  try {
    const result = await api<{ revoked: boolean; alreadyRevoked: boolean; businessName: string | null }>(
      baseUrl,
      "/credential/revoke",
      {},
      token
    );
    businessName = result.businessName;
    alreadyRevoked = result.alreadyRevoked;
  } catch (error) {
    if (error instanceof CliApiError && error.status === 401) {
      alreadyRevoked = true;
      say(style(33, "The token is already invalid; removing the local credentials."));
    } else {
      throw error;
    }
  }

  let removedKeys = false;
  if (!options.keepEnv) {
    await writeEnvFile(envFile, removeEnvKeys(contents, [TOKEN_KEY, CALLBACK_SECRET_KEY]));
    removedKeys = true;
  }

  say();
  say(
    style(
      1,
      alreadyRevoked
        ? "That credential was already disconnected."
        : `Disconnected ${businessName ? sanitizeTerminal(businessName) : "the site"}.`
    )
  );
  if (removedKeys) say(`Removed ${TOKEN_KEY} and ${CALLBACK_SECRET_KEY} from ${displayEnv}.`);
  else say(`The credential is revoked. Local values in ${displayEnv} were kept.`);
  return { businessName, removedKeys, alreadyRevoked, canceled: false };
}

/* ------------------------------------------------------------------ */
/* Doctor                                                              */
/* ------------------------------------------------------------------ */

export type DoctorCheckStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  label: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  envFile: string;
  environment: string | null;
  businessName: string | null;
  checks: DoctorCheck[];
}

function addDoctorCheck(report: DoctorReport, check: DoctorCheck, json: boolean): void {
  report.checks.push(check);
  if (json) return;
  const symbol =
    check.status === "ok" ? style(32, "✓") : check.status === "warn" ? style(33, "!") : style(31, "✗");
  say(`${symbol} ${sanitizeTerminal(check.label)}`);
  if (check.detail) say(`   ${sanitizeTerminal(check.detail)}`);
}

function signedTestEvent(secret: string, environment: "test" | "live"): { body: string; eventId: string; timestamp: number } {
  const createdAt = new Date().toISOString();
  const eventId = `evt_test_${randomBytes(8).toString("hex")}`;
  const body = JSON.stringify({
    id: eventId,
    type: "webhook.test",
    createdAt,
    livemode: environment === "live",
    data: {
      id: "glyphpay_doctor",
      orderId: "glyphpay-doctor",
      // Never "succeeded": a handler that checks data.status must not mistake
      // the diagnostic event for a real payment.
      status: "test",
      amountCents: 0,
      applicationFeeCents: 0,
      currency: "usd",
      refundedCents: 0,
      refunds: [],
      disputes: [],
      stale: false,
      updatedAt: createdAt,
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  return { body, eventId, timestamp };
}

function standardWebhookSignature(secret: string, eventId: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.slice(6), "base64");
  return `v1,${createHmac("sha256", key).update(`${eventId}.${timestamp}.${body}`).digest("base64")}`;
}

async function deliverTestEvent(
  callbackUrl: string,
  secret: string,
  environment: "test" | "live"
): Promise<{ status: number; ok: boolean; text: string }> {
  const { body, eventId, timestamp } = signedTestEvent(secret, environment);
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": eventId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": standardWebhookSignature(secret, eventId, timestamp, body),
      "user-agent": `glyphpay-cli/${VERSION}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text().catch(() => "");
  return { status: response.status, ok: response.ok, text: text.slice(0, 200) };
}

export async function runDoctor(options: CliOptions = {}): Promise<DoctorReport> {
  const baseUrl = baseUrlFor(options);
  const envFile = await resolveEnvFileForCli(options, !options.json);
  const displayEnv = relative(process.cwd(), envFile) || envFile;
  const json = !!options.json;
  const report: DoctorReport = {
    ok: true,
    envFile: displayEnv,
    environment: null,
    businessName: null,
    checks: [],
  };

  if (!json) {
    say();
    say(style(1, "Glyph Pay doctor"));
    say(`Env file: ${displayEnv}`);
    say();
  }

  const major = Number(process.versions.node.split(".")[0]);
  addDoctorCheck(
    report,
    major >= 18
      ? { id: "node", status: "ok", label: `Node ${process.versions.node}` }
      : { id: "node", status: "error", label: `Node ${process.versions.node} is too old`, detail: "The CLI requires Node 18 or newer." },
    json
  );

  const exists = await fileExists(envFile);
  addDoctorCheck(
    report,
    exists
      ? { id: "env", status: "ok", label: `Found ${displayEnv}` }
      : { id: "env", status: "error", label: `${displayEnv} was not found`, detail: "Run `glyphpay connect` first or pass --env <path>." },
    json
  );

  if (exists) {
    const ignored = spawnSync("git", ["check-ignore", "-q", "--", envFile], {
      cwd: dirname(envFile),
      stdio: "ignore",
    });
    if (ignored.status === 1) {
      addDoctorCheck(
        report,
        {
          id: "env-gitignored",
          status: "warn",
          label: `${displayEnv} is not ignored by git`,
          detail: "Add it to .gitignore before committing; it contains a service credential.",
        },
        json
      );
    }
  }

  const contents = await readEnvFile(envFile);
  const token = readEnvValue(contents, TOKEN_KEY);
  const callbackSecret = readEnvValue(contents, CALLBACK_SECRET_KEY);
  const tokenMatch = token ? TOKEN_PATTERN.exec(token) : null;

  addDoctorCheck(
    report,
    token
      ? { id: "token-present", status: "ok", label: `${TOKEN_KEY} is present` }
      : { id: "token-present", status: "error", label: `${TOKEN_KEY} is missing`, detail: "Run `glyphpay connect` to issue a credential." },
    json
  );
  if (token) {
    addDoctorCheck(
      report,
      tokenMatch
        ? { id: "token-format", status: "ok", label: "Token format is valid", detail: `${tokenMatch[1]} mode` }
        : { id: "token-format", status: "error", label: "Token format is not a dgsvc_ service credential" },
      json
    );
  }

  const exposed = findPublicCredentialKeys(contents);
  addDoctorCheck(
    report,
    exposed.length
      ? {
          id: "public-env",
          status: "error",
          label: `${exposed.join(", ")} expose a Glyph Pay credential`,
          detail: "Move these values to server-only variables and rotate the credential.",
        }
      : { id: "public-env", status: "ok", label: "No credential is in a public-prefixed variable" },
    json
  );

  if (callbackSecret) {
    addDoctorCheck(
      report,
      CALLBACK_SECRET_PATTERN.test(callbackSecret)
        ? { id: "callback-secret-format", status: "ok", label: "Callback signing secret format is valid" }
        : { id: "callback-secret-format", status: "warn", label: "Callback signing secret has an unexpected format" },
      json
    );
  }

  let info: CredentialInfo | null = null;
  if (token && tokenMatch) {
    try {
      info = await fetchCredential(baseUrl, token);
      report.environment = info.environment;
      report.businessName = info.businessName;
      addDoctorCheck(
        report,
        {
          id: "token-valid",
          status: "ok",
          label: "Glyph Pay accepted the token",
          detail: `${info.businessName} · ${info.environment} mode`,
        },
        json
      );
    } catch (error) {
      addDoctorCheck(
        report,
        {
          id: "token-valid",
          status: "error",
          label: "Glyph Pay rejected the token",
          detail: error instanceof Error ? error.message : String(error),
        },
        json
      );
    }
  }

  if (info) {
    addDoctorCheck(
      report,
      info.chargesEnabled
        ? { id: "stripe", status: "ok", label: "Stripe connected account can accept charges" }
        : {
            id: "stripe",
            status: "error",
            label: "Stripe connected account is not ready for charges",
            detail: info.connectedAccountId
              ? "Complete Stripe onboarding in Design Glyph admin, then re-check."
              : "No connected account is linked to this client yet.",
          },
      json
    );

    if (info.callbackUrl && !isProbeableCallbackUrl(info.callbackUrl)) {
      addDoctorCheck(
        report,
        {
          id: "callback-url",
          status: "error",
          label: "Webhook URL is not a public HTTPS URL",
          detail: "Refusing to contact it from this machine. Register a public HTTPS callback URL.",
        },
        json
      );
    } else if (info.callbackUrl) {
      addDoctorCheck(
        report,
        { id: "callback-url", status: "ok", label: "Webhook URL is registered", detail: info.callbackUrl },
        json
      );
      addDoctorCheck(
        report,
        callbackSecret
          ? { id: "callback-secret", status: "ok", label: "Callback signing secret is present locally" }
          : {
              id: "callback-secret",
              status: "error",
              label: "Callback signing secret is missing locally",
              detail: "Re-register the webhook in Glyph Pay admin and update GLYPHPAY_CALLBACK_SECRET.",
            },
        json
      );

      if (callbackSecret) {
        try {
          const reachable = await fetch(info.callbackUrl, {
            method: "HEAD",
            redirect: "manual",
            signal: AbortSignal.timeout(8_000),
          });
          addDoctorCheck(
            report,
            reachable.status >= 500 || reachable.status === 404
              ? {
                  id: "callback-reachable",
                  status: "warn",
                  label: `Webhook URL returned HTTP ${reachable.status} to a HEAD request`,
                  detail: "GlyphPay sends POST requests. A custom route may reject HEAD.",
                }
              : {
                  id: "callback-reachable",
                  status: "ok",
                  label: `Webhook URL is reachable (HTTP ${reachable.status})`,
                },
            json
          );
        } catch {
          addDoctorCheck(
            report,
            {
              id: "callback-reachable",
              status: "warn",
              label: "Webhook URL was not reachable from this machine",
              detail: "A firewall may block this terminal; Glyph Pay may still reach the public URL.",
            },
            json
          );
        }
      }

      if (options.sendTestEvent) {
        if (!callbackSecret) {
          addDoctorCheck(
            report,
            { id: "test-event", status: "error", label: "Test event not sent", detail: "No callback signing secret is available." },
            json
          );
        } else {
          try {
            const delivered = await deliverTestEvent(info.callbackUrl, callbackSecret, info.environment);
            addDoctorCheck(
              report,
              delivered.ok
                ? {
                    id: "test-event",
                    status: "ok",
                    label: `Signed test event accepted (HTTP ${delivered.status})`,
                  }
                : {
                    id: "test-event",
                    status: "error",
                    label: `Signed test event rejected (HTTP ${delivered.status})`,
                    detail: delivered.text || "Check the site's webhook route and callback secret.",
                  },
              json
            );
          } catch (error) {
            addDoctorCheck(
              report,
              {
                id: "test-event",
                status: "error",
                label: "Could not deliver the signed test event",
                detail: error instanceof Error ? error.message : String(error),
              },
              json
            );
          }
        }
      }
    } else {
      addDoctorCheck(
        report,
        {
          id: "callback-url",
          status: "warn",
          label: "No webhook URL is registered",
          detail: "Checkout works, but payment.succeeded events will not reach this site.",
        },
        json
      );
      if (callbackSecret) {
        addDoctorCheck(
          report,
          {
            id: "callback-secret",
            status: "warn",
            label: "A callback secret is present locally but no webhook URL is registered",
          },
          json
        );
      }
    }
  }

  report.ok = !report.checks.some((check) => check.status === "error");
  if (json) {
    say(JSON.stringify(report, null, 2));
  } else {
    say();
    say(
      report.ok
        ? style(32, "No blocking problems found.")
        : style(31, "Fix the errors above, then run `glyphpay doctor` again.")
    );
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* Webhook deliveries                                                  */
/* ------------------------------------------------------------------ */

function printDelivery(delivery: CallbackDeliveryView): void {
  say(
    sanitizeTerminal(
      `  ${delivery.id}  ${delivery.type}  ${delivery.state.toUpperCase()}  ` +
        `attempt ${delivery.attempts}  ${delivery.updatedAt}`
    )
  );
  if (delivery.lastError) say(`    ${sanitizeTerminal(delivery.lastError)}`);
}

export async function runDeliveries(
  options: CliOptions = {}
): Promise<CallbackDeliveriesResponse | CallbackReplayResponse> {
  const baseUrl = baseUrlFor(options);
  const envFile = await resolveEnvFileForCli(options, !options.json);
  const contents = await readEnvFile(envFile);
  const token = readEnvValue(contents, TOKEN_KEY);
  if (!token) {
    throw new CliUsageError(
      `No ${TOKEN_KEY} found in ${relative(process.cwd(), envFile) || envFile}. Run glyphpay connect first.`
    );
  }

  if (options.retry) {
    const result = await api<CallbackReplayResponse>(
      baseUrl,
      `/credential/deliveries/${encodeURIComponent(options.retry)}/replay`,
      {},
      token
    );
    if (options.json) {
      say(JSON.stringify(result, null, 2));
    } else {
      say();
      say(style(1, `Webhook ${result.outcome === "delivered" ? "delivered" : "not delivered"}.`));
      printDelivery(result.delivery);
      if (result.detail) say(`  ${sanitizeTerminal(result.detail)}`);
    }
    return result;
  }

  const params = new URLSearchParams();
  if (options.state) params.set("state", options.state);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  const query = params.toString();
  const result = await api<CallbackDeliveriesResponse>(
    baseUrl,
    `/credential/deliveries${query ? `?${query}` : ""}`,
    undefined,
    token
  );
  if (options.json) {
    say(JSON.stringify(result, null, 2));
    return result;
  }

  say();
  say(style(1, `Webhook deliveries - ${sanitizeTerminal(result.businessName)} (${sanitizeTerminal(result.environment)} mode)`));
  say();
  if (result.deliveries.length === 0) {
    say(options.state ? `No ${options.state} deliveries recorded.` : "No deliveries recorded yet.");
  } else {
    for (const delivery of result.deliveries) printDelivery(delivery);
    say();
    say("Retry one with `glyphpay deliveries --retry <id>`.");
    if (result.nextCursor) {
      const next = ["glyphpay deliveries"];
      if (options.state) next.push("--state", options.state);
      if (options.limit) next.push("--limit", String(options.limit));
      next.push("--cursor", result.nextCursor);
      say(`Next page: ${next.join(" ")}`);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Init (framework integrations)                                       */
/* ------------------------------------------------------------------ */

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function libTemplate(ts: boolean): string {
  const cartId = ts
    ? `const cartId = (body as { cartId?: string } | null)?.cartId;`
    : `const cartId = body?.cartId;`;
  return `import { glyphPay, CheckoutError } from "glyphpay/server";

export const glyphpay = glyphPay({
  token: process.env.GLYPHPAY_TOKEN,
  callbackSecret: process.env.GLYPHPAY_CALLBACK_SECRET,

  async priceOrder(body) {
    // Load the cart/order from YOUR database and return its server-side price.
    // Never trust an amount sent by the browser.
    ${cartId}
    if (!cartId) throw new CheckoutError("Your cart is empty.");
    throw new CheckoutError("Connect priceOrder() to your order database before accepting payments.");
  },

  // Add a shared limiter before launch. Throw RateLimitError for HTTP 429.
  // A per-process Map is not sufficient on serverless/edge deployments.
  // beforeCheckout: async (req) => { ... },

  async onEvent(event) {
    // At-least-once delivery: insert event.id and update the order in the
    // same transaction; act only when the insert is new.
    if (event.type === "payment.succeeded") {
      // TODO: insert event.id and mark the order paid atomically.
      console.log(\`GlyphPay payment succeeded for \${event.data.orderId}\`);
    }
  },
});
`;
}

type Framework = "next" | "remix" | "astro" | "sveltekit" | "hono" | "express";

function routeTemplate(libImport: string): string {
  return `import { glyphpay } from "${libImport}";\n\nexport const POST = glyphpay.checkout;\n`;
}

function webhookRouteTemplate(libImport: string): string {
  return `import { glyphpay } from "${libImport}";\n\nexport const POST = glyphpay.webhook;\n`;
}

function detectFramework(dependencies: Record<string, string>): Framework | null {
  if (dependencies.next) return "next";
  if (dependencies["@sveltejs/kit"]) return "sveltekit";
  if (dependencies.astro) return "astro";
  if (dependencies["@remix-run/node"] || dependencies["@remix-run/react"]) return "remix";
  if (dependencies.hono) return "hono";
  if (dependencies.express) return "express";
  return null;
}

interface FrameworkPlan {
  framework: Framework;
  files: Array<{ path: string; contents: string }>;
  libPath: string;
  envComment: string;
  notes: string[];
}

function svelteRoute(kind: "checkout" | "webhook", isTs: boolean): string {
  const typeImport = isTs ? `import type { RequestHandler } from "./$types";\n\n` : "\n";
  const annotation = isTs ? ": RequestHandler" : "";
  return `import { glyphpay } from "$lib/server/glyphpay";\n${typeImport}export const POST${annotation} = ({ request }) => glyphpay.${kind}(request);\n`;
}

function astroRoute(kind: "checkout" | "webhook", isTs: boolean): string {
  const typeImport = isTs ? `import type { APIRoute } from "astro";\n\n` : "\n";
  const annotation = isTs ? ": APIRoute" : "";
  return `import { glyphpay } from "../../../lib/glyphpay";\n${typeImport}export const POST${annotation} = ({ request }) => glyphpay.${kind}(request);\n`;
}

function remixRoute(kind: "checkout" | "webhook", isTs: boolean): string {
  const typeImport = isTs ? `import type { ActionFunctionArgs } from "@remix-run/node";\n\n` : "\n";
  const signature = isTs ? "{ request }: ActionFunctionArgs" : "{ request }";
  return `import { glyphpay } from "~/lib/glyphpay.server";\n${typeImport}export async function action(${signature}) {\n  return glyphpay.${kind}(request);\n}\n`;
}

function honoRoutes(): string {
  return `import { Hono } from "hono";\nimport { glyphpay } from "./lib/glyphpay";\n\nexport const glyphpayRoutes = new Hono();\n\nglyphpayRoutes.post("/checkout", (c) => glyphpay.checkout(c.req.raw));\nglyphpayRoutes.post("/webhook", (c) => glyphpay.webhook(c.req.raw));\n`;
}

function expressRoutes(isTs: boolean): string {
  const typeImport = isTs
    ? `import type { Request as ExpressRequest, Response as ExpressResponse } from "express";\n`
    : "";
  const signature = isTs ? ": ExpressRequest" : "";
  const responseType = isTs ? ": ExpressResponse" : "";
  const handlerType = isTs ? "(request: Request) => Promise<Response>" : "handler";
  return `import express from "express";\nimport { glyphpay } from "./lib/glyphpay";\n${typeImport}\nexport const glyphpayRoutes = express.Router();\n\nfunction publicOrigin(req${signature}) {\n  const forwardedHost = req.app.get("trust proxy") ? req.get("x-forwarded-host") : undefined;\n  const host = (forwardedHost ? forwardedHost.split(",")[0].trim() : "") || req.get("host") || "localhost";\n  return \`\${req.protocol || "http"}://\${host}\`;\n}\n\nasync function adapt(handler${isTs ? `: ${handlerType}` : ""}, req${signature}, res${responseType}) {\n  const body =\n    req.method === "GET" || req.method === "HEAD"\n      ? undefined\n      : Buffer.isBuffer(req.body)\n        ? req.body\n        : typeof req.body === "string"\n          ? req.body\n          : JSON.stringify(req.body ?? {});\n  const request = new Request(\`\${publicOrigin(req)}\${req.originalUrl}\`, {\n    method: req.method,\n    headers: req.headers as unknown as HeadersInit,\n    body,\n  });\n  const response = await handler(request);\n  res.status(response.status);\n  response.headers.forEach((value, key) => res.setHeader(key, value));\n  res.send(Buffer.from(await response.arrayBuffer()));\n}\n\nglyphpayRoutes.post("/checkout", express.json(), (req, res) => adapt(glyphpay.checkout, req, res));\nglyphpayRoutes.post("/webhook", express.raw({ type: "application/json" }), (req, res) => adapt(glyphpay.webhook, req, res));\n`;
}

async function frameworkPlan(projectRoot: string, framework: Framework): Promise<FrameworkPlan> {
  const isTs = await fileExists(join(projectRoot, "tsconfig.json"));
  const extension = isTs ? "ts" : "js";
  const envComment = "# Glyph Pay — server-side only. Keep these in the server environment.\n";

  if (framework === "next") {
    const hasSrcApp = await directoryExists(join(projectRoot, "src", "app"));
    const hasRootApp = await directoryExists(join(projectRoot, "app"));
    const hasPages =
      (await directoryExists(join(projectRoot, "pages"))) ||
      (await directoryExists(join(projectRoot, "src", "pages")));
    if (!hasSrcApp && !hasRootApp && hasPages) {
      throw new CliUsageError(
        "This project uses the Next.js Pages Router. glyphpay init supports the App Router; see the README for the two route files."
      );
    }
    const appDir = hasSrcApp ? join("src", "app") : join("app");
    const libDir = hasSrcApp ? join("src", "lib") : join("lib");
    const importPath = "../../../../lib/glyphpay";
    return {
      framework,
      libPath: join(projectRoot, libDir, `glyphpay.${extension}`),
      files: [
        { path: join(projectRoot, libDir, `glyphpay.${extension}`), contents: libTemplate(isTs) },
        { path: join(projectRoot, appDir, "api", "glyphpay", "checkout", `route.${extension}`), contents: routeTemplate(importPath) },
        { path: join(projectRoot, appDir, "api", "glyphpay", "webhook", `route.${extension}`), contents: webhookRouteTemplate(importPath) },
      ],
      envComment,
      notes: ["The generated routes live at /api/glyphpay/checkout and /api/glyphpay/webhook."],
    };
  }

  if (framework === "sveltekit") {
    const libPath = join(projectRoot, "src", "lib", "server", `glyphpay.${extension}`);
    return {
      framework,
      libPath,
      files: [
        { path: libPath, contents: libTemplate(isTs) },
        { path: join(projectRoot, "src", "routes", "api", "glyphpay", "checkout", `+server.${extension}`), contents: svelteRoute("checkout", isTs) },
        { path: join(projectRoot, "src", "routes", "api", "glyphpay", "webhook", `+server.${extension}`), contents: svelteRoute("webhook", isTs) },
      ],
      envComment,
      notes: ["Use adapter-node or another server adapter; static SvelteKit builds cannot run checkout."],
    };
  }

  if (framework === "astro") {
    const libPath = join(projectRoot, "src", "lib", `glyphpay.${extension}`);
    return {
      framework,
      libPath,
      files: [
        { path: libPath, contents: libTemplate(isTs) },
        { path: join(projectRoot, "src", "pages", "api", "glyphpay", `checkout.${extension}`), contents: astroRoute("checkout", isTs) },
        { path: join(projectRoot, "src", "pages", "api", "glyphpay", `webhook.${extension}`), contents: astroRoute("webhook", isTs) },
      ],
      envComment,
      notes: ["Set output to server/SSR in astro.config and install a server adapter before deploying."],
    };
  }

  if (framework === "remix") {
    const libPath = join(projectRoot, "app", "lib", `glyphpay.server.${extension}`);
    return {
      framework,
      libPath,
      files: [
        { path: libPath, contents: libTemplate(isTs) },
        { path: join(projectRoot, "app", "routes", `api.glyphpay.checkout.${extension}`), contents: remixRoute("checkout", isTs) },
        { path: join(projectRoot, "app", "routes", `api.glyphpay.webhook.${extension}`), contents: remixRoute("webhook", isTs) },
      ],
      envComment,
      notes: ["Routes assume the standard ~ alias; adjust the import if your tsconfig uses another alias."],
    };
  }

  if (framework === "hono") {
    const libPath = join(projectRoot, "src", "lib", `glyphpay.${extension}`);
    return {
      framework,
      libPath,
      files: [
        { path: libPath, contents: libTemplate(isTs) },
        { path: join(projectRoot, "src", `glyphpay-routes.${extension}`), contents: honoRoutes() },
      ],
      envComment,
      notes: ["Mount the router in your app: app.route(\"/api/glyphpay\", glyphpayRoutes)."],
    };
  }

  const libPath = join(projectRoot, "src", "lib", `glyphpay.${extension}`);
  return {
    framework: "express",
    libPath,
    files: [
      { path: libPath, contents: libTemplate(isTs) },
      { path: join(projectRoot, "src", `glyphpay-routes.${extension}`), contents: expressRoutes(isTs) },
    ],
    envComment,
    notes: [
      "Mount the router with app.use(\"/api/glyphpay\", glyphpayRoutes).",
      "The webhook route uses express.raw so the signature is verified against the original bytes.",
      "Behind a TLS proxy, set app.set(\"trust proxy\", 1): the adapter reads X-Forwarded-Proto and X-Forwarded-Host only when trust proxy is enabled, and Origin checks fail closed otherwise.",
      "If the public site origin differs from the internal request origin, add it to allowedCheckoutOrigins when constructing glyphPay().",
    ],
  };
}

function installCommand(hasPnpmLock: boolean, hasYarnLock: boolean, hasBunLock: boolean): string {
  if (hasPnpmLock) return "pnpm add glyphpay";
  if (hasYarnLock) return "yarn add glyphpay";
  if (hasBunLock) return "bun add glyphpay";
  return "npm install glyphpay";
}

export async function runInit(options: CliOptions = {}): Promise<void> {
  const projectRoot = resolve(options.dir ?? process.cwd());
  const packagePath = join(projectRoot, "package.json");
  if (!(await fileExists(packagePath))) {
    throw new CliUsageError(`No package.json found in ${projectRoot}. Run init in a web project.`);
  }

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await readFile(packagePath, "utf8")) as PackageJson;
  } catch {
    throw new CliUsageError("package.json is not valid JSON.");
  }
  const dependencies = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const framework = detectFramework(dependencies);
  if (!framework) {
    throw new CliUsageError(
      "glyphpay init supports Next.js, Remix, Astro, SvelteKit, Express, and Hono. Install one of those frameworks first."
    );
  }

  const plan = await frameworkPlan(projectRoot, framework);
  const envPath = join(projectRoot, ".env.example");
  const generated = plan.files;
  const existing: string[] = [];
  for (const file of generated) {
    if (await fileExists(file.path)) existing.push(relative(projectRoot, file.path).replace(/\\/g, "/"));
  }
  if (existing.length > 0 && !options.force) {
    throw new CliUsageError(
      `Refusing to overwrite existing files:\n  ${existing.join("\n  ")}\nRe-run with --force to overwrite them.`
    );
  }

  const envExisting = await readEnvFile(envPath);
  const envBase = envExisting.trim().length > 0 ? envExisting : plan.envComment;
  const envNext = ensureEnvKeys(envBase, [TOKEN_KEY, CALLBACK_SECRET_KEY]);
  const envChanged = envNext !== envExisting;

  const display = (path: string) => relative(projectRoot, path).replace(/\\/g, "/");
  if (!options.dryRun) {
    for (const file of generated) {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.contents, "utf8");
    }
    if (envChanged) await writeFile(envPath, envNext, "utf8");
  }

  say();
  say(style(1, "Glyph Pay init"));
  say(`Framework: ${plan.framework}`);
  say();
  for (const file of generated) {
    const verb = existing.includes(display(file.path)) ? "Updated" : options.dryRun ? "Would create" : "Created";
    say(`  ${verb} ${display(file.path)}`);
  }
  say(`  ${envChanged ? (options.dryRun ? "Would update" : "Updated") : "Unchanged"} .env.example`);

  const pnpm = await fileExists(join(projectRoot, "pnpm-lock.yaml"));
  const yarn = await fileExists(join(projectRoot, "yarn.lock"));
  const bun = (await fileExists(join(projectRoot, "bun.lockb"))) || (await fileExists(join(projectRoot, "bun.lock")));
  say();
  say("Next steps:");
  say(`  1. ${installCommand(pnpm, yarn, bun)}`);
  say("  2. npx glyphpay connect --url https://your-site.com");
  say(`  3. Wire priceOrder() and onEvent() in ${display(plan.libPath)}.`);
  for (const note of plan.notes) say(`  ${note}`);
  if (options.dryRun) {
    say();
    say("Dry run: no files were written.");
  }
}

/* ------------------------------------------------------------------ */
/* Setup (deployment-aware scaffolding)                                */
/* ------------------------------------------------------------------ */

type SetupTarget = Framework | "firebase-functions";
type SetupPreset = "custom" | "firestore-invoices";
type SetupUi = "react" | "none";
type SetupAction = "created" | "updated" | "unchanged" | "would-create" | "would-update";

const SETUP_TARGETS: readonly SetupTarget[] = [
  "firebase-functions",
  "next",
  "remix",
  "astro",
  "sveltekit",
  "hono",
  "express",
];

/** One machine-readable `glyphpay setup` result, also printed with `--json`. */
export interface SetupResult {
  target: SetupTarget;
  preset: SetupPreset;
  ui: SetupUi;
  framework: Framework | null;
  nextOutput: "export" | "server" | null;
  functionsDir: string | null;
  functionId: string | null;
  routes: { checkout: string; webhook: string; status: string };
  files: Array<{ path: string; action: SetupAction }>;
  rewrites: { added: string[]; unchanged: string[]; note: string | null };
  notes: string[];
  nextSteps: string[];
  dryRun: boolean;
}

interface SetupFile {
  path: string;
  contents: string;
  /** Generated by appending to an existing file (the Functions entry point). */
  append?: boolean;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObjectArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((entry) => isJsonObject(entry));
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  if (!(await fileExists(path))) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    throw new CliUsageError(
      `${relative(process.cwd(), path).replace(/\\/g, "/")} is not valid JSON. Fix it before running glyphpay setup.`
    );
  }
}

/** Read-only detection: never executes the project's Next.js configuration. */
async function detectNextOutput(projectRoot: string): Promise<"export" | "server" | null> {
  for (const name of ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"]) {
    const path = join(projectRoot, name);
    if (!(await fileExists(path))) continue;
    try {
      const text = await readFile(path, "utf8");
      return /output\s*:\s*["']export["']/.test(text) ? "export" : "server";
    } catch {
      return null;
    }
  }
  return null;
}

function functionsSourceOf(raw: unknown): string | null {
  if (isJsonObjectArray(raw)) {
    for (const entry of raw) {
      if (typeof entry.source === "string") return entry.source;
    }
    return null;
  }
  if (isJsonObject(raw) && typeof raw.source === "string") return raw.source;
  return null;
}

function functionIdOf(entry: unknown): string | null {
  if (!isJsonObject(entry) || !isJsonObject(entry.function)) return null;
  return typeof entry.function.functionId === "string" ? entry.function.functionId : null;
}

function broadRewritePrefix(source: string): string | null {
  if (source === "**" || source === "/**") return "";
  if (source.endsWith("{,/**}")) return source.slice(0, -"{,/**}".length);
  if (source.endsWith("/**")) return source.slice(0, -"/**".length);
  return null;
}

interface RewritePlan {
  text: string;
  added: string[];
  unchanged: string[];
  note: string | null;
}

/**
 * Add only the three Glyph Pay function rewrites. Existing unrelated rewrites
 * are preserved, and an existing non-Glyph Pay rewrite on the same exact path
 * is a hard error: setup never shadows another route.
 */
function planHostingRewrites(
  text: string,
  target: { functionId: string; region: string; routes: SetupResult["routes"] }
): RewritePlan {
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new CliUsageError("firebase.json is not valid JSON. Fix it before running glyphpay setup.");
  }
  if (!isJsonObject(config)) throw new CliUsageError("firebase.json must contain a JSON object.");
  const hosting = config.hosting;
  if (Array.isArray(hosting)) {
    throw new CliUsageError(
      "firebase.json configures multiple Hosting sites. Add the Glyph Pay rewrites to the site that serves this app manually."
    );
  }
  if (!isJsonObject(hosting)) {
    throw new CliUsageError('firebase.json has no "hosting" configuration. Run firebase init hosting first.');
  }
  const rawRewrites = hosting.rewrites;
  if (rawRewrites !== undefined && !Array.isArray(rawRewrites)) {
    throw new CliUsageError('firebase.json "hosting.rewrites" is not an array. Fix it before running setup.');
  }
  const rewrites = (rawRewrites ?? []) as unknown[];
  hosting.rewrites = rewrites;

  const exact = (source: string) => rewrites.find((entry) => isJsonObject(entry) && entry.source === source);
  const added: string[] = [];
  const unchanged: string[] = [];
  let note: string | null = null;

  const broad = rewrites.find((entry) => {
    if (!isJsonObject(entry) || typeof entry.source !== "string") return false;
    const prefix = broadRewritePrefix(entry.source);
    return prefix !== null && target.routes.checkout.startsWith(prefix);
  });
  if (broad && functionIdOf(broad) === target.functionId) {
    return {
      text,
      added,
      unchanged: [String((broad as Record<string, unknown>).source)],
      note: `An existing broad rewrite already sends the Glyph Pay paths to "${target.functionId}"; no rewrite was added.`,
    };
  }
  if (broad) {
    const source = String((broad as Record<string, unknown>).source);
    const owner = functionIdOf(broad);
    note =
      `Existing ${source} rewrite points at ${owner ? `function "${owner}"` : "another destination"}; ` +
      "exact Glyph Pay rewrites were added ahead of it.";
  }

  const inserts: Array<Record<string, unknown>> = [];
  for (const source of [target.routes.checkout, target.routes.webhook, target.routes.status]) {
    const existing = exact(source);
    if (existing) {
      const owner = functionIdOf(existing);
      if (owner === target.functionId) {
        unchanged.push(source);
        continue;
      }
      throw new CliUsageError(
        `firebase.json already rewrites ${source} to ${owner ? `function "${owner}"` : "another destination"}. ` +
          "Setup will not silently replace it; remove or rename that rewrite, then run setup again."
      );
    }
    inserts.push({ source, function: { functionId: target.functionId, region: target.region } });
    added.push(source);
  }
  if (inserts.length > 0) rewrites.unshift(...inserts);
  return { text: JSON.stringify(config, null, 2) + "\n", added, unchanged, note };
}

function addDependency(pkg: PackageJson, name: string, range: string): boolean {
  if (pkg.dependencies?.[name] || pkg.devDependencies?.[name]) return false;
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: range };
  return true;
}

async function findFunctionsIndex(
  functionsRoot: string
): Promise<{ path: string; importSpecifier: string; inSrc: boolean } | null> {
  if (await fileExists(join(functionsRoot, "src", "index.ts"))) {
    return { path: join(functionsRoot, "src", "index.ts"), importSpecifier: "./glyphpay/functions", inSrc: true };
  }
  if (await fileExists(join(functionsRoot, "src", "index.js"))) {
    return { path: join(functionsRoot, "src", "index.js"), importSpecifier: "./glyphpay/functions", inSrc: true };
  }
  if (await fileExists(join(functionsRoot, "index.ts"))) {
    return { path: join(functionsRoot, "index.ts"), importSpecifier: "./glyphpay/functions", inSrc: false };
  }
  if (await fileExists(join(functionsRoot, "index.js"))) {
    return { path: join(functionsRoot, "index.js"), importSpecifier: "./glyphpay/functions", inSrc: false };
  }
  return null;
}

function firebaseFunctionsTemplate(input: {
  functionId: string;
  region: string;
  routes: SetupResult["routes"];
  preset: SetupPreset;
}): string {
  const connector = input.preset === "firestore-invoices" ? "invoiceAdapter" : "connector";
  const imports =
    input.preset === "firestore-invoices"
      ? `import { CheckoutError, glyphPay } from "glyphpay/server";\nimport { createFirebaseHttpsHandler } from "glyphpay/firebase";\nimport { assertConfigured, invoiceAdapter } from "./config";\n\nassertConfigured();\n`
      : `import { glyphPay } from "glyphpay/server";\nimport { createFirebaseHttpsHandler } from "glyphpay/firebase";\nimport { createConnector } from "./connector";\n`;
  const priceOrder =
    input.preset === "firestore-invoices"
      ? `  priceOrder: (body, req) => invoiceAdapter.priceOrder(body, req),\n`
      : `  priceOrder: connector.priceOrder,\n`;
  const onEvent =
    input.preset === "firestore-invoices"
      ? `  onEvent: async (event) => {\n    const result = await invoiceAdapter.onEvent(event);\n    if (result.status === "rejected") console.warn("Glyph Pay event rejected:", result.reason);\n  },\n`
      : `  onEvent: connector.onEvent,\n`;
  const statusBlock =
    input.preset === "firestore-invoices"
      ? `    status: async (req) => {\n      const url = new URL(req.url, "http://localhost");\n      const reference = url.searchParams.get("invoiceId") ?? "";\n      try {\n        const projection = await invoiceAdapter.status({ reference, req });\n        return Response.json(projection, { headers: { "cache-control": "no-store" } });\n      } catch (error) {\n        const status = error instanceof CheckoutError ? error.status : 500;\n        const message =\n          status === 500\n            ? "Invoice status is unavailable."\n            : error instanceof Error\n              ? error.message\n              : "Request rejected.";\n        return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });\n      }\n    },\n`
      : "";
  const tokenInit =
    input.preset === "firestore-invoices"
      ? `const token = defineSecret("GLYPHPAY_TOKEN");\nconst callbackSecret = defineSecret("GLYPHPAY_CALLBACK_SECRET");\n\nconst connector = glyphPay({\n  token: token.value(),\n  callbackSecret: callbackSecret.value(),\n${priceOrder}${onEvent}});\n`
      : `const token = defineSecret("GLYPHPAY_TOKEN");\nconst callbackSecret = defineSecret("GLYPHPAY_CALLBACK_SECRET");\n\nconst connector = createConnector({ token: token.value(), callbackSecret: callbackSecret.value() });\n`;

  return `/**
 * Glyph Pay Firebase HTTPS function (generated by "glyphpay setup").
 *
 * Hosting rewrites for checkout, webhook${statusBlock ? " and status" : ""} all point here. The
 * webhook verifies its signature against the original request bytes, so never
 * mount a JSON body parser in front of this function.
 */
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
${imports}
export const ROUTES = {
  checkout: "${input.routes.checkout}",
  webhook: "${input.routes.webhook}",
  status: "${input.routes.status}",
} as const;

${tokenInit}
export const ${input.functionId} = onRequest(
  { region: "${input.region}", secrets: [token, callbackSecret], timeoutSeconds: 60 },
  createFirebaseHttpsHandler({
    routes: ROUTES,
    checkout: connector.checkout,
    webhook: connector.webhook,
${statusBlock}  })
);
`;
}

function firebaseConnectorTemplate(): string {
  return `import { CheckoutError, glyphPay } from "glyphpay/server";

/**
 * Build the Glyph Pay connector with secrets supplied by Firebase Secret
 * Manager in ./functions.ts. Keep this module server-only.
 */
export function createConnector(secrets: { token: string; callbackSecret: string }) {
  return glyphPay({
    token: secrets.token,
    callbackSecret: secrets.callbackSecret,

    async priceOrder(body) {
      // Load the invoice/order from YOUR database and return its server-side
      // price. Never trust an amount sent by the browser.
      void body;
      throw new CheckoutError("Connect priceOrder() to your invoice database before accepting payments.");
    },

    async onEvent(event) {
      // At-least-once delivery: insert event.id and apply the payment in one
      // transaction; act only when the insert is new.
      if (event.type === "payment.succeeded") {
        console.log("Glyph Pay payment succeeded for", event.data.orderId);
      }
    },
  });
}
`;
}

function firestoreInvoiceConfigTemplate(): string {
  return `/**
 * Glyph Pay invoice adapter configuration (generated by "glyphpay setup").
 *
 * This is the only place that knows how YOUR invoices are stored. Every
 * mapping is explicit: names like total, status or owner are never guessed.
 * The generated function refuses to start until the placeholders are reviewed
 * and CONFIGURED is true.
 */
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  asFirestoreLike,
  createFirestoreInvoiceAdapter,
  type ApplyPaymentInput,
  type InvoiceAuthorization,
  type InvoiceAuthorizationInput,
} from "glyphpay/firebase";

if (getApps().length === 0) initializeApp();

export const CONFIGURED: boolean = false;

/** Collection holding one document per invoice. */
export const INVOICE_COLLECTION = "UNCONFIGURED_invoices";

/** Map each semantic to a real invoice field (not to the original total). */
export const FIELDS = {
  /** Integer minor units still due. */
  outstandingCents: "UNCONFIGURED_outstandingCents",
  description: "UNCONFIGURED_description",
  status: "UNCONFIGURED_status",
  currency: "UNCONFIGURED_currency",
  businessId: "UNCONFIGURED_businessId",
  environment: "UNCONFIGURED_environment",
};

/** Map YOUR status values into Glyph Pay's four disjoint groups. */
export const STATUSES = {
  payable: ["UNCONFIGURED_payable"],
  paid: ["UNCONFIGURED_paid"],
  void: ["UNCONFIGURED_void"],
  processing: [] as string[],
};

/**
 * Decide who may pay this invoice. The Firestore read below is not
 * authorization: the Admin SDK bypasses Security Rules. Replace this denial
 * with your real policy before setting CONFIGURED to true.
 */
export async function authorizeInvoice(
  input: InvoiceAuthorizationInput<Record<string, unknown>>
): Promise<InvoiceAuthorization> {
  // Example with a Firebase ID token and a membership check:
  //   const idToken = input.req.headers.get("authorization")?.replace(/^Bearer /i, "");
  //   if (!idToken) return { allowed: false, status: 401 };
  //   const decoded = await getAuth().verifyIdToken(idToken);
  //   if (!(await isBusinessMember(decoded.uid, String(input.invoice[FIELDS.businessId])))) {
  //     return { allowed: false };
  //   }
  // Scoped payment links also work: verify a capability for this invoice id
  // and revision before allowing the payment.
  void input;
  return { allowed: false, status: 403, message: "This invoice cannot be paid from this page." };
}

/**
 * Apply verified payment facts to the invoice. MUST stay pure: it runs inside
 * a Firestore transaction and can run more than once. Keep email, shipping,
 * entitlement and other side effects out of it; use onApplied or the
 * fulfillment outbox instead.
 */
export function applyInvoicePayment(
  input: ApplyPaymentInput<Record<string, unknown>>
): Record<string, unknown> {
  // Credit only input.payment.amountCents (verified server-side), record
  // refunds and disputes as facts, and never recompute a total from the
  // browser. Replace this throw with your ledger update.
  throw new Error("Glyph Pay: applyInvoicePayment() is not connected yet for invoice " + input.invoiceId);
}

export const invoiceAdapter = createFirestoreInvoiceAdapter({
  firestore: asFirestoreLike(getFirestore()),
  environment: process.env.GLYPHPAY_ENVIRONMENT === "live" ? "live" : "test",
  invoices: {
    collection: INVOICE_COLLECTION,
    referenceField: "invoiceId",
    fields: FIELDS,
    statuses: STATUSES,
  },
  payments: { collection: "glyphpay_payments" },
  deliveries: { collection: "glyphpay_deliveries" },
  authorize: authorizeInvoice,
  applyPayment: applyInvoicePayment,
});

/** Refuse to start with placeholder configuration instead of guessing. */
export function assertConfigured(): void {
  const missing: string[] = [];
  if (!CONFIGURED) missing.push("CONFIGURED = true");
  if (INVOICE_COLLECTION.startsWith("UNCONFIGURED_")) missing.push("INVOICE_COLLECTION");
  for (const [name, value] of Object.entries(FIELDS)) {
    if (value.startsWith("UNCONFIGURED_")) missing.push("FIELDS." + name);
  }
  for (const [name, values] of Object.entries(STATUSES)) {
    if (values.some((value) => value.startsWith("UNCONFIGURED_"))) missing.push("STATUSES." + name);
  }
  if (missing.length > 0) {
    throw new Error(
      "Glyph Pay setup is incomplete: configure " +
        missing.join(", ") +
        " in functions/src/glyphpay/config.ts. The function will not start rather than accept payments with guessed invoice semantics."
    );
  }
}
`;
}

function reactInvoiceWrapperTemplate(endpoint: string): string {
  return `"use client";

import { GlyphPayCheckout, type CheckoutOptions } from "glyphpay/react";

export interface InvoicePaymentProps {
  /** Invoice document id (or the reference your adapter resolves). */
  invoiceId: string;
  /** Relative path on this site, for example "/billing/view". */
  returnPath: string;
  endpoint?: string;
  buttonText?: string;
  appearance?: CheckoutOptions["appearance"];
  className?: string;
  /** Add headers per attempt, for example a fresh Firebase ID token. */
  authorize?: CheckoutOptions["authorize"];
}

/**
 * Glyph Pay invoice payment wrapper around GlyphPayCheckout.
 *
 * Mount it explicitly, for example:
 *   <InvoicePayment invoiceId={invoiceId} returnPath="/billing/view" />
 *
 * The return path is only a navigation target: never treat its query string
 * or a status=complete parameter as proof of payment. Read the invoice from
 * your authorized status endpoint instead.
 *
 * It reads no browser globals while rendering, so it is safe to prerender
 * during a static export.
 */
export function InvoicePayment({
  invoiceId,
  returnPath,
  endpoint = "${endpoint}",
  ...rest
}: InvoicePaymentProps) {
  return (
    <GlyphPayCheckout
      order={{ invoiceId }}
      returnUrl={returnPath}
      endpoint={endpoint}
      {...rest}
    />
  );
}
`;
}

function setupTarget(value: string): SetupTarget {
  if (!(SETUP_TARGETS as readonly string[]).includes(value)) {
    throw new CliUsageError(`Unknown --target "${value}". Use one of: ${SETUP_TARGETS.join(", ")}.`);
  }
  return value as SetupTarget;
}

function setupPreset(value: string): SetupPreset {
  if (value !== "custom" && value !== "firestore-invoices") {
    throw new CliUsageError(`Unknown --preset "${value}". Use custom or firestore-invoices.`);
  }
  return value;
}

function setupUi(value: string): SetupUi {
  if (value !== "react" && value !== "none") {
    throw new CliUsageError(`Unknown --ui "${value}". Use react or none.`);
  }
  return value;
}

function setupRoutePath(value: string | undefined, fallback: string, flag: string): string {
  if (value === undefined) return fallback;
  if (!value.startsWith("/") || value.includes(" ") || value.includes("//")) {
    throw new CliUsageError(`${flag} must be an absolute path such as ${fallback}.`);
  }
  return value.replace(/\/+$/, "");
}

async function reactComponentDirectory(projectRoot: string): Promise<{ dir: string; importable: string }> {
  for (const candidate of ["components", "src/components", "app/components", "src/app/components"]) {
    if (await directoryExists(join(projectRoot, candidate))) {
      return { dir: join(projectRoot, candidate), importable: `${candidate}/InvoicePayment` };
    }
  }
  const dir = (await directoryExists(join(projectRoot, "src"))) ? join("src", "components") : "components";
  return { dir: join(projectRoot, dir), importable: `${dir.replace(/\\/g, "/")}/InvoicePayment` };
}

export async function runSetup(options: CliOptions = {}): Promise<SetupResult> {
  const projectRoot = resolve(options.dir ?? process.cwd());
  const packagePath = join(projectRoot, "package.json");
  const pkg = await readJsonFile<PackageJson>(packagePath);
  if (!pkg) {
    throw new CliUsageError(`No package.json found in ${projectRoot}. Run setup in the site project.`);
  }
  const dependencies = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const framework = detectFramework(dependencies);
  const nextOutput = await detectNextOutput(projectRoot);

  const firebasePath = join(projectRoot, "firebase.json");
  const firebaseText = (await fileExists(firebasePath)) ? await readFile(firebasePath, "utf8") : null;
  let firebaseConfig: Record<string, unknown> | null = null;
  if (firebaseText !== null) {
    try {
      const parsed = JSON.parse(firebaseText) as unknown;
      firebaseConfig = isJsonObject(parsed) ? parsed : null;
    } catch {
      throw new CliUsageError("firebase.json is not valid JSON. Fix it before running glyphpay setup.");
    }
    if (!firebaseConfig) throw new CliUsageError("firebase.json must contain a JSON object.");
  }

  const detectedFunctionsDir = functionsSourceOf(firebaseConfig?.functions);
  const functionsRelative = options.functionsDir ?? detectedFunctionsDir ?? "functions";
  const functionsRoot = resolve(projectRoot, functionsRelative);

  const autoTarget =
    firebaseConfig !== null && (await directoryExists(functionsRoot)) ? "firebase-functions" : framework;
  if (!options.target && !autoTarget) {
    throw new CliUsageError(
      "Could not detect the frontend framework. Pass --target next, remix, astro, sveltekit, hono, express, or firebase-functions."
    );
  }
  const target = setupTarget(options.target ?? autoTarget ?? "");
  if (target === "next" && nextOutput === "export") {
    throw new CliUsageError(
      'This Next.js app uses output: "export". Static export cannot run POST route handlers, so the checkout and webhook routes would never run. ' +
        "Run glyphpay setup --target firebase-functions (with Firebase Functions and Hosting), or switch the app to a server runtime."
    );
  }

  const preset = setupPreset(options.preset ?? "custom");
  if (preset === "firestore-invoices" && target !== "firebase-functions") {
    throw new CliUsageError(
      "The firestore-invoices preset targets Firebase Functions. Pass --target firebase-functions, or use --preset custom for a generic integration."
    );
  }
  const ui = setupUi(options.ui ?? (target === "firebase-functions" && dependencies.react ? "react" : "none"));
  if (ui === "react" && !dependencies.react) {
    throw new CliUsageError("The React invoice wrapper needs React in this project. Install react, or pass --ui none.");
  }

  const routes: SetupResult["routes"] = {
    checkout: setupRoutePath(options.checkoutPath, "/api/glyphpay/checkout", "--checkout-path"),
    webhook: setupRoutePath(options.webhookPath, "/api/glyphpay/webhook", "--webhook-path"),
    status: setupRoutePath(options.statusPath, "/api/glyphpay/status", "--status-path"),
  };

  const files: SetupFile[] = [];
  const notes: string[] = [];
  let functionsDir: string | null = null;
  let functionId: string | null = null;
  let rewrites: RewritePlan = { text: firebaseText ?? "", added: [], unchanged: [], note: null };
  let functionsPackage: PackageJson | null = null;
  let functionsPackagePath: string | null = null;
  let functionsPackageChanged = false;
  const rootPackageChanged = ui === "react" ? addDependency(pkg, "glyphpay", `^${VERSION}`) : false;

  if (target === "firebase-functions") {
    if (!firebaseConfig || firebaseText === null) {
      throw new CliUsageError(
        `No firebase.json found in ${projectRoot}. Run firebase init hosting functions first, then run setup again.`
      );
    }
    if (!(await directoryExists(functionsRoot))) {
      throw new CliUsageError(
        `No Firebase Functions directory at ${functionsRelative}. Run firebase init functions (or pass --functions-dir), then run setup again.`
      );
    }
    functionsDir = functionsRelative.replace(/\\/g, "/");
    functionId = options.functionId ?? "glyphpaySite";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(functionId)) {
      throw new CliUsageError("--function-id must be a valid JavaScript identifier.");
    }
    const region = options.region ?? "us-central1";
    if (!/^[a-z]+(-[a-z]+)+[0-9]+$/.test(region)) {
      throw new CliUsageError('--region must look like "us-central1".');
    }

    functionsPackagePath = join(functionsRoot, "package.json");
    functionsPackage = await readJsonFile<PackageJson>(functionsPackagePath);
    if (!functionsPackage) {
      throw new CliUsageError(
        `No ${relative(projectRoot, functionsPackagePath)}. Run firebase init functions so the deployed artifact has its own dependencies.`
      );
    }
    const functionsDependencies = {
      ...(functionsPackage.dependencies ?? {}),
      ...(functionsPackage.devDependencies ?? {}),
    };
    if (!functionsDependencies["firebase-functions"]) {
      throw new CliUsageError(
        `The Functions package (${functionsRelative}/package.json) does not depend on firebase-functions. Run firebase init functions first.`
      );
    }
    if (preset === "firestore-invoices" && !functionsDependencies["firebase-admin"]) {
      throw new CliUsageError(
        `The firestore-invoices preset needs firebase-admin in ${functionsRelative}/package.json. Install it there, then run setup again.`
      );
    }

    const entry = await findFunctionsIndex(functionsRoot);
    if (!entry) {
      throw new CliUsageError(
        `Could not find the Functions entry point (src/index.ts, src/index.js, index.ts, or index.js) in ${functionsRelative}. ` +
          "Create it, then run setup again; setup will not guess the deployed entry point."
      );
    }
    if (!entry.path.endsWith(".ts")) {
      throw new CliUsageError(
        "glyphpay setup generates TypeScript for Firebase Functions, and this project uses a JavaScript entry point. " +
          "Add a TypeScript Functions setup (firebase init functions with TypeScript) and run setup again."
      );
    }

    const base = entry.inSrc ? join(functionsRoot, "src", "glyphpay") : join(functionsRoot, "glyphpay");
    if (preset === "firestore-invoices") {
      files.push({ path: join(base, "config.ts"), contents: firestoreInvoiceConfigTemplate() });
      files.push({
        path: join(base, "functions.ts"),
        contents: firebaseFunctionsTemplate({ functionId, region, routes, preset }),
      });
    } else {
      files.push({ path: join(base, "connector.ts"), contents: firebaseConnectorTemplate() });
      files.push({
        path: join(base, "functions.ts"),
        contents: firebaseFunctionsTemplate({ functionId, region, routes, preset }),
      });
    }

    const indexContents = await readFile(entry.path, "utf8");
    if (!new RegExp(`\\b${functionId}\\b`).test(indexContents)) {
      const exportLine =
        `\n// Glyph Pay (generated by "glyphpay setup"). Keep this name in sync with\n` +
        `// the Hosting rewrites for ${routes.checkout}, ${routes.webhook} and ${routes.status}.\n` +
        `export { ${functionId} } from "${entry.importSpecifier}";\n`;
      files.push({ path: entry.path, contents: indexContents + exportLine, append: true });
    }

    const envPath = join(functionsRoot, ".env.example");
    const envExisting = await readEnvFile(envPath);
    const envHeader =
      "# Glyph Pay server-side configuration.\n" +
      "# Local development only: production values belong in Secret Manager.\n" +
      `#   firebase functions:secrets:set ${TOKEN_KEY}\n` +
      `#   firebase functions:secrets:set ${CALLBACK_SECRET_KEY}\n` +
      "# Uploading secrets is a separate, approved action.\n";
    files.push({
      path: envPath,
      contents: ensureEnvKeys(envExisting.trim().length > 0 ? envExisting : envHeader, [
        TOKEN_KEY,
        CALLBACK_SECRET_KEY,
        "GLYPHPAY_ENVIRONMENT",
      ]),
    });

    functionsPackageChanged = addDependency(functionsPackage, "glyphpay", `^${VERSION}`);
    rewrites = planHostingRewrites(firebaseText, { functionId, region, routes });
    notes.push(
      "The generated function reads invoice pricing and authorization from server-side code only; the browser sends an invoice reference, never an amount.",
      "Set the placeholders in the generated config and flip CONFIGURED to true before deploying; the function refuses to start otherwise.",
      "firebase functions:secrets:set uploads production secrets. glyphpay connect writes local development values only."
    );
  } else {
    const plan = await frameworkPlan(projectRoot, target);
    files.push(...plan.files);
    notes.push(...plan.notes);
  }

  if (ui === "react") {
    const component = await reactComponentDirectory(projectRoot);
    files.push({ path: join(component.dir, "InvoicePayment.tsx"), contents: reactInvoiceWrapperTemplate(routes.checkout) });
    notes.push(
      `Import the wrapper: import { InvoicePayment } from "${component.importable}";`,
      'Mount it in place of the bespoke payment block: <InvoicePayment invoiceId={invoiceId} returnPath="/billing/view" /> — it renders GlyphPayCheckout, keeps the return path relative, and never marks an invoice paid.'
    );
  }

  const display = (path: string) => relative(projectRoot, path).replace(/\\/g, "/");

  // Plan actions before writing, and refuse to overwrite files that differ.
  const conflicts: string[] = [];
  const actions: Array<{ path: string; action: SetupAction }> = [];
  for (const file of files) {
    if (!(await fileExists(file.path))) {
      actions.push({ path: display(file.path), action: options.dryRun ? "would-create" : "created" });
      continue;
    }
    const current = await readFile(file.path, "utf8");
    if (current === file.contents) {
      actions.push({ path: display(file.path), action: "unchanged" });
    } else if (file.append) {
      actions.push({ path: display(file.path), action: options.dryRun ? "would-update" : "updated" });
    } else if (options.force) {
      actions.push({ path: display(file.path), action: options.dryRun ? "would-update" : "updated" });
    } else {
      conflicts.push(display(file.path));
    }
  }
  if (conflicts.length > 0) {
    throw new CliUsageError(
      `Refusing to overwrite existing files:\n  ${conflicts.join("\n  ")}\n` +
        "Review them, then re-run with --force to overwrite only the generated files."
    );
  }
  const result: SetupResult = {
    target,
    preset,
    ui,
    framework,
    nextOutput,
    functionsDir,
    functionId,
    routes,
    files: [],
    rewrites: { added: rewrites.added, unchanged: rewrites.unchanged, note: rewrites.note },
    notes,
    nextSteps: [],
    dryRun: options.dryRun === true,
  };

  if (!options.dryRun) {
    for (const file of files) {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.contents, "utf8");
    }
    if (functionsPackage && functionsPackagePath && functionsPackageChanged) {
      await writeFile(functionsPackagePath, JSON.stringify(functionsPackage, null, 2) + "\n", "utf8");
    }
    if (rootPackageChanged) await writeFile(packagePath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    if (rewrites.added.length > 0) await writeFile(firebasePath, rewrites.text, "utf8");
  }

  result.files.push(...actions);
  if (functionsPackageChanged && functionsPackagePath) {
    result.files.push({ path: display(functionsPackagePath), action: options.dryRun ? "would-update" : "updated" });
  }
  if (rootPackageChanged) {
    result.files.push({ path: "package.json", action: options.dryRun ? "would-update" : "updated" });
  }
  if (rewrites.added.length > 0) {
    result.files.push({ path: "firebase.json", action: options.dryRun ? "would-update" : "updated" });
  }

  const install = installCommand(
    await fileExists(join(projectRoot, "pnpm-lock.yaml")),
    await fileExists(join(projectRoot, "yarn.lock")),
    (await fileExists(join(projectRoot, "bun.lockb"))) || (await fileExists(join(projectRoot, "bun.lock")))
  );
  result.nextSteps.push(
    `Install the package in the site: ${install}`,
    ...(functionsDir
      ? [`Install the package in the Functions artifact: cd ${functionsDir} && ${install}`]
      : []),
    "Configure the generated adapter mappings and authorization policy, then set CONFIGURED = true.",
    "Pair the site (local development values only): npx glyphpay connect --url https://your-site.com",
    ...(functionsDir
      ? [
          `Production secrets: firebase functions:secrets:set ${TOKEN_KEY} (and ${CALLBACK_SECRET_KEY})`,
          `Deploy when reviewed: firebase deploy --only functions,hosting`,
        ]
      : []),
    "A signed test event only checks the webhook boundary; complete a sandbox payment to verify pricing, delivery and invoice updates together."
  );

  if (options.json) {
    say(JSON.stringify(result, null, 2));
    return result;
  }

  say();
  say(style(1, "Glyph Pay setup"));
  say(
    `Target: ${target}${framework ? ` (frontend: ${framework})` : ""}  preset: ${preset}  ui: ${ui}` +
      (nextOutput ? `  next output: ${nextOutput}` : "")
  );
  if (functionsDir) say(`Functions: ${functionsDir}/${functionId}`);
  say();
  const labels: Record<SetupAction, string> = {
    created: "Created     ",
    updated: "Updated     ",
    unchanged: "Unchanged   ",
    "would-create": "Would create",
    "would-update": "Would update",
  };
  for (const file of result.files) say(`  ${labels[file.action]} ${file.path}`);
  if (target === "firebase-functions") {
    say();
    say(
      `Hosting rewrites: ${rewrites.added.length > 0 ? rewrites.added.join(", ") : "none added"}` +
        (rewrites.unchanged.length > 0 ? `  (already routed: ${rewrites.unchanged.join(", ")})` : "")
    );
    if (rewrites.note) say(`  ${rewrites.note}`);
  }
  say();
  for (const note of notes) say(`  ${note}`);
  say();
  say("Next steps:");
  result.nextSteps.forEach((step, index) => say(`  ${index + 1}. ${step}`));
  if (options.dryRun) {
    say();
    say("Dry run: no files were written.");
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.command === "help") {
      say(helpText());
      return 0;
    }
    if (parsed.command === "version") {
      say(VERSION);
      return 0;
    }
    if (parsed.command === "doctor") {
      const report = await runDoctor(parsed.options);
      return report.ok ? 0 : 1;
    }
    if (parsed.command === "init") {
      await runInit(parsed.options);
      return 0;
    }
    if (parsed.command === "setup") {
      await runSetup(parsed.options);
      return 0;
    }
    if (parsed.command === "deliveries") {
      const result = await runDeliveries(parsed.options);
      return "outcome" in result && result.outcome !== "delivered" ? 1 : 0;
    }
    if (parsed.command === "disconnect") {
      await runDisconnect(parsed.options);
      return 0;
    }
    if (parsed.command === "rotate") {
      await runRotate(parsed.options);
      return 0;
    }
    await runConnect(parsed.options);
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      say(style(31, error.message));
      say("Run `glyphpay --help` for usage.");
      return 2;
    }
    say();
    say(style(31, sanitizeTerminal(error instanceof Error ? error.message : String(error))));
    return 1;
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  const currentUrl = import.meta.url.toLowerCase();
  try {
    const realArgv1 = realpathSync(process.argv[1]);
    if (pathToFileURL(realArgv1).href.toLowerCase() === currentUrl) return true;
  } catch {
    // realpath may fail if process.argv[1] is not a real path
  }
  return pathToFileURL(process.argv[1]).href.toLowerCase() === currentUrl;
}

if (isMainModule()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
