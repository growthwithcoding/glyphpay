/**
 * Env-file helpers for the Glyph Pay CLI.
 *
 * Sites name their environment files differently: `.env`, `.env.local`,
 * `.env.development.local`, and so on. A credential is only useful in the file
 * the site actually loads, so `connect` discovers the candidates instead of
 * assuming `.env.local`. Whichever file holds the credential also gets its
 * placeholder added to the committed example file, and its path added to
 * `.gitignore`.
 */

import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

/** Example files a site may already use, most conventional first. */
export const ENV_EXAMPLE_FILES = [".env.example", ".env.local.example", ".env.sample", ".env.template"];

/** Header written into an example file created from scratch. */
export const ENV_EXAMPLE_HEADER =
  "# Glyph Pay - server-side configuration. Fill these in locally; never commit real values.\n";

const GITIGNORE_COMMENT = "# Glyph Pay - service credentials. Never commit this file.";

const ENV_FILE_PREFERENCE = [
  ".env.local",
  ".env",
  ".env.development.local",
  ".env.development",
  ".env.production.local",
  ".env.production",
];

const ENV_FILE_PATTERN = /^\.env(?:\.[A-Za-z0-9_-]+)*$/;
const ENV_TEMPLATE_PATTERN = /(?:^|\.)(?:example|sample|template)$/i;

/** True for a real env file (`.env`, `.env.local`), false for templates (`.env.example`). */
export function isEnvFileName(name: string): boolean {
  return ENV_FILE_PATTERN.test(name) && !ENV_TEMPLATE_PATTERN.test(name);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read an env file, treating a missing file as empty. */
export async function readEnvFileIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface EnvFileSelection {
  /** Absolute path of the file that should hold the credential. */
  path: string;
  /** Absolute directory that was scanned for candidates. */
  directory: string;
  /** Candidate file names, most suitable first. Empty when `--env` named the file. */
  candidates: string[];
}

/**
 * Env files in `directory`, most likely first: a file that already holds a
 * Glyph Pay key (so re-pairing updates the same file), then the framework
 * convention. Templates such as `.env.example` are never candidates.
 */
export async function findEnvFiles(directory: string, managedKeys: string[]): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const withCredential: string[] = [];
  const others: string[] = [];
  for (const name of entries.filter(isEnvFileName).sort((a, b) => a.localeCompare(b))) {
    const contents = await readEnvFileIfExists(join(directory, name));
    const managed = managedKeys.some((key) =>
      new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "m").test(contents)
    );
    (managed ? withCredential : others).push(name);
  }

  const rank = (name: string) => {
    const index = ENV_FILE_PREFERENCE.indexOf(name);
    return index === -1 ? ENV_FILE_PREFERENCE.length : index;
  };
  return [
    ...withCredential.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)),
    ...others.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)),
  ];
}

/** Resolve the env file to use when `--env` was not passed. */
export async function selectEnvFile(input: {
  directory: string;
  envFile?: string;
  managedKeys: string[];
  fallback?: string;
}): Promise<EnvFileSelection> {
  const directory = resolve(input.directory);
  // A relative --env path belongs to the project being configured, not the
  // shell's cwd, so `--dir site --env .env` writes inside `site`.
  if (input.envFile) return { path: resolve(directory, input.envFile), directory, candidates: [] };
  const candidates = await findEnvFiles(directory, input.managedKeys);
  const path =
    candidates.length > 0 ? join(directory, candidates[0]) : join(directory, input.fallback ?? ".env.local");
  return { path, directory, candidates };
}

/** The committed example file that pairs with `envFile`, preferring one that already exists. */
export async function envExampleFile(envFile: string): Promise<string> {
  const directory = dirname(resolve(envFile));
  for (const name of ENV_EXAMPLE_FILES) {
    const candidate = join(directory, name);
    if (await pathExists(candidate)) return candidate;
  }
  return join(directory, ENV_EXAMPLE_FILES[0]);
}

/** Add `KEY=` placeholders without changing an existing value. */
export function ensureEnvExampleKeys(contents: string, keys: string[]): string {
  const missing = keys.filter((key) => !new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "m").test(contents));
  if (missing.length === 0) return contents;
  const base = contents.length && !contents.endsWith("\n") ? `${contents}\n` : contents;
  return `${base}${missing.map((key) => `${key}=`).join("\n")}\n`;
}

function globToRegExp(pattern: string): RegExp | null {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  try {
    return new RegExp(`^(?:.*/)?${source}$`);
  } catch {
    return null;
  }
}

/** True when an existing, non-negated ignore rule already matches `entry`. */
export function gitignoreIgnores(contents: string, entry: string): boolean {
  const target = entry.replace(/\\/g, "/");
  const name = target.slice(target.lastIndexOf("/") + 1);
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const pattern = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!pattern) continue;
    const regex = globToRegExp(pattern);
    if (regex && (regex.test(target) || regex.test(name))) return true;
  }
  return false;
}

/**
 * Append the ignore rules that are missing, plus `!<name>` for any example file
 * an existing broad rule would hide. Unrelated lines are preserved.
 */
export function ensureGitignoreEntries(contents: string, entries: string[], unignore: string[] = []): string {
  const wanted = entries.filter((entry) => entry && !gitignoreIgnores(contents, entry));
  const negated = unignore.filter(
    (entry) =>
      entry &&
      gitignoreIgnores(contents, entry) &&
      !contents.split(/\r?\n/).some((line) => line.trim() === `!${entry}`)
  );
  if (wanted.length === 0 && negated.length === 0) return contents;

  const eol = contents.includes("\r\n") ? "\r\n" : "\n";
  const body = contents.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const block = [GITIGNORE_COMMENT, ...wanted, ...negated.map((entry) => `!${entry}`)].join("\n");
  const next = `${body ? `${body}\n\n` : ""}${block}\n`;
  return eol === "\n" ? next : next.replace(/\n/g, eol);
}

/**
 * The nearest `.gitignore` that covers `envFile`, or one beside the env file.
 * `entry` is written relative to that ignore file.
 */
export async function gitignoreFor(envFile: string, projectRoot: string): Promise<{ path: string; entry: string }> {
  const target = resolve(envFile);
  const root = resolve(projectRoot);
  let directory = dirname(target);
  let found: string | null = null;

  while (true) {
    const candidate = join(directory, ".gitignore");
    if (await pathExists(candidate)) {
      found = candidate;
      break;
    }
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    if (relative(root, parent).startsWith("..")) break;
    directory = parent;
  }

  let gitignorePath = found ?? join(dirname(target), ".gitignore");
  let entry = relative(dirname(gitignorePath), target).replace(/\\/g, "/");
  if (entry.startsWith("..")) {
    gitignorePath = join(dirname(target), ".gitignore");
    entry = basename(target);
  }
  return { path: gitignorePath, entry };
}

export interface EnvSupportFiles {
  exampleFile: string;
  exampleChanged: boolean;
  gitignoreFile: string;
  gitignoreEntry: string;
  gitignoreChanged: boolean;
  warnings: string[];
}

/**
 * Keep the committed example file and `.gitignore` in step with the credential
 * file. Never throws: a failure here must not discard a credential that was
 * already written successfully.
 */
export async function syncEnvSupportFiles(input: {
  envFile: string;
  projectRoot: string;
  managedKeys: string[];
  exampleHeader?: string;
}): Promise<EnvSupportFiles> {
  const envFile = resolve(input.envFile);
  const exampleFile = await envExampleFile(envFile).catch(() =>
    join(dirname(envFile), ENV_EXAMPLE_FILES[0])
  );
  const gitignore = await gitignoreFor(envFile, input.projectRoot).catch(() => ({
    path: join(dirname(envFile), ".gitignore"),
    entry: basename(envFile),
  }));

  const outcome: EnvSupportFiles = {
    exampleFile,
    exampleChanged: false,
    gitignoreFile: gitignore.path,
    gitignoreEntry: gitignore.entry,
    gitignoreChanged: false,
    warnings: [],
  };

  try {
    const existing = await readEnvFileIfExists(exampleFile);
    const base = existing.trim().length > 0 ? existing : input.exampleHeader ?? ENV_EXAMPLE_HEADER;
    const next = ensureEnvExampleKeys(base, input.managedKeys);
    if (next !== existing) {
      await writeFile(exampleFile, next, "utf8");
      outcome.exampleChanged = true;
    }
  } catch (error) {
    outcome.warnings.push(`Could not update ${exampleFile}: ${errorMessage(error)}`);
  }

  try {
    const existing = await readEnvFileIfExists(gitignore.path);
    const exampleName = basename(exampleFile);
    const next = ensureGitignoreEntries(
      existing,
      [gitignore.entry],
      exampleName === gitignore.entry ? [] : [exampleName]
    );
    if (next !== existing) {
      await mkdir(dirname(gitignore.path), { recursive: true });
      await writeFile(gitignore.path, next, "utf8");
      outcome.gitignoreChanged = true;
    }
  } catch (error) {
    outcome.warnings.push(`Could not update ${gitignore.path}: ${errorMessage(error)}`);
  }

  return outcome;
}
