#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { cp, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "extension");
const distDir = join(root, "dist");
const unpackedDir = join(distDir, "voice-pr-extension");
const checkOnly = process.argv.includes("--check");

function fail(message) {
  console.error(`extension package check failed: ${message}`);
  process.exit(1);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    fail(`${relative(root, path)} is not valid JSON: ${e.message}`);
  }
}

async function listFiles(dir, base = dir) {
  const entries = await readdir(dir);
  const files = [];
  for (const entry of entries) {
    if (entry === ".DS_Store") continue;
    const path = join(dir, entry);
    const info = await stat(path);
    if (info.isDirectory()) files.push(...(await listFiles(path, base)));
    else files.push(relative(base, path));
  }
  return files.sort();
}

function assertIncludes(values, expected, label) {
  for (const value of expected) {
    if (!values.includes(value)) fail(`${label} must include ${value}`);
  }
}

const pkg = await readJson(join(root, "package.json"));
const manifest = await readJson(join(extensionDir, "manifest.json"));
const files = await listFiles(extensionDir);

const requiredFiles = [
  "background.js",
  "content.css",
  "content.js",
  "manifest.json",
  "options.html",
  "options.js",
  "vendor/webgazer.js",
];

for (const file of requiredFiles) {
  if (!existsSync(join(extensionDir, file))) fail(`missing extension/${file}`);
}

if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (manifest.version !== pkg.version) fail(`manifest version ${manifest.version} must match package version ${pkg.version}`);
if (manifest.options_page !== "options.html") fail("manifest options_page must be options.html");

assertIncludes(manifest.permissions || [], ["scripting", "storage"], "manifest permissions");
assertIncludes(manifest.host_permissions || [], ["http://localhost/*", "http://127.0.0.1/*"], "manifest host_permissions");

console.log(`extension package check passed (${files.length} files, version ${manifest.version})`);

if (checkOnly) process.exit(0);

const outputName = `voice-pr-extension-${manifest.version}.zip`;
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
await cp(extensionDir, unpackedDir, { recursive: true });

const result = spawnSync("zip", ["-r", "-X", join(distDir, outputName), ...files], {
  cwd: extensionDir,
  encoding: "utf8",
});

if (result.error?.code === "ENOENT") fail("zip command not found; install zip or run the package step on a machine with zip");
if (result.status !== 0) fail(result.stderr || result.stdout || `zip exited with ${result.status}`);

console.log(`wrote ${relative(root, unpackedDir)}/`);
console.log(`wrote dist/${outputName}`);
