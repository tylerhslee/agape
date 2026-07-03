#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const VERSION_FILE = "VERSION.md";
const versionRe = /\bv?1\.0\.0-alpha\.\d{4}\.\d+\.\d+\.\d+\b/g;
const IGNORED_FILES = new Set([
  "CHANGELOG.md",
]);

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
process.chdir(repoRoot);

function fail(message) {
  console.error(`version check failed: ${message}`);
  process.exitCode = 1;
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function isProbablyText(buf) {
  return !buf.includes(0);
}

const versionText = readFileSync(VERSION_FILE, "utf8");
const versions = [...versionText.matchAll(versionRe)].map((m) => m[0].replace(/^v/, ""));
const uniqueVersions = [...new Set(versions)];
if (uniqueVersions.length !== 1) {
  fail(`${VERSION_FILE} must contain exactly one unique Agape version, found ${uniqueVersions.join(", ") || "none"}`);
}

const expected = uniqueVersions[0];
const requiredTracks = ["Spec", "Compiler", "Runtime", "Studio"];
for (const track of requiredTracks) {
  const row = new RegExp(`\\|\\s*${track}\\s*\\|\\s*\`${expected}\`\\s*\\|`);
  if (!row.test(versionText)) fail(`${VERSION_FILE} is missing ${track} row for ${expected}`);
}

const mismatches = [];
for (const file of trackedFiles()) {
  if (IGNORED_FILES.has(file)) continue;
  const buf = readFileSync(file);
  if (!isProbablyText(buf)) continue;
  const text = buf.toString("utf8");
  for (const match of text.matchAll(versionRe)) {
    if (match[0].replace(/^v/, "") === expected) continue;
    const line = text.slice(0, match.index).split("\n").length;
    mismatches.push(`${file}:${line}: ${match[0]} != ${expected}`);
  }
}

if (mismatches.length) {
  for (const m of mismatches) console.error(m);
  fail(`found ${mismatches.length} stale version reference${mismatches.length === 1 ? "" : "s"}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`version check ok: ${expected}`);
