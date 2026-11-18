#!/usr/bin/env node
/**
 * Release consistency gate for glyphpay.
 *
 * Run before publishing so the version, lockfile, CLI constant, changelog and
 * published export targets agree. Reads only; no network or secrets.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const errors = [];
const fail = (message) => errors.push(message);
const exists = (file) => existsSync(join(root, file));

const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const cli = read("src/cli.ts");
const changelog = read("CHANGELOG.md");
const version = pkg.version;

if (pkg.name !== "glyphpay") fail(`unexpected package name: ${String(pkg.name)}`);
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`package version is not plain SemVer: ${String(version)}`);
}
if (lock.version !== version) {
  fail(`package-lock version ${String(lock.version)} != package.json ${String(version)}`);
}
if (lock.packages?.[""]?.version !== version) {
  fail(`package-lock packages[""].version ${String(lock.packages?.[""]?.version)} != ${String(version)}`);
}

const cliVersion = /const VERSION = "([^"]+)";/.exec(cli)?.[1];
if (!cliVersion) {
  fail("could not find the CLI VERSION constant");
} else if (cliVersion !== version) {
  fail(`CLI VERSION ${cliVersion} != package.json ${version}`);
}

if (!changelog.includes(`## [${version}]`)) {
  fail(`CHANGELOG.md has no "## [${version}]" entry`);
}

if (!Array.isArray(pkg.files) || !pkg.files.includes("dist")) {
  fail("package files must include dist");
}
if (pkg.engines?.node !== ">=18") {
  fail(`package engines.node must be ">=18", found ${String(pkg.engines?.node)}`);
}
if (!pkg.repository?.url?.endsWith("github.com/growthwithcoding/glyphpay.git")) {
  fail(`repository.url must point at growthwithcoding/glyphpay, found ${String(pkg.repository?.url)}`);
}

if (!pkg.exports || typeof pkg.exports !== "object") {
  fail("package has no exports map");
} else {
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const targets = typeof target === "string" ? [target] : Object.values(target ?? {});
    if (targets.length === 0) fail(`exports["${subpath}"] has no targets`);
    for (const file of targets) {
      if (typeof file !== "string" || !file.startsWith("./")) {
        fail(`exports["${subpath}"] has an invalid target: ${String(file)}`);
        continue;
      }
      if (!exists(file)) fail(`exports["${subpath}"] target is missing: ${file} (run the package build first)`);
    }
  }
}

for (const [name, file] of Object.entries(pkg.bin ?? {})) {
  if (!exists(file)) fail(`bin["${name}"] target is missing: ${file}`);
}

if (errors.length > 0) {
  console.error("release check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`release check passed: ${pkg.name}@${version}`);
