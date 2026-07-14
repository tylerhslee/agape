#!/usr/bin/env node
// Version-drift check. The expected version comes from VERSION.md; every other
// tracked file must agree. Recognizes both prerelease channels (alpha and beta)
// so a channel flip in VERSION.md flags every stale reference on either channel.
//
//   node scripts/check-version.mjs               # check the enclosing git repo
//   node scripts/check-version.mjs --root <dir>  # check another tree (falls back
//                                                # to a filesystem walk if <dir>
//                                                # is not a git repo)
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const VERSION_FILE = "VERSION.md";
const versionRe = /\bv?1\.0\.0-(?:alpha|beta)\.\d{4}\.\d+\.\d+\.\d+\b/g;
const IGNORED_FILES = new Set([
  "CHANGELOG.md",
]);
const WALK_SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".agape"]);

let rootArg;
{
  const args = process.argv.slice(2);
  const i = args.indexOf("--root");
  if (i !== -1) {
    rootArg = args[i + 1];
    if (!rootArg) {
      console.error("check-version: --root requires a directory argument");
      process.exit(2);
    }
  }
}

function gitToplevel(dir) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

const repoRoot = rootArg ?? gitToplevel(process.cwd());
if (!repoRoot) {
  console.error("check-version: not inside a git repo (pass --root <dir>)");
  process.exit(2);
}
process.chdir(repoRoot);
// Use git's file list when the root is a git repo; otherwise walk the tree so
// --root works against a plain directory copy (e.g. a release-rehearsal stage).
const useGit = gitToplevel(repoRoot) !== undefined;

function fail(message) {
  console.error(`version check failed: ${message}`);
  process.exitCode = 1;
}

function trackedFiles() {
  if (useGit) {
    const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
    return out.split("\0").filter(Boolean);
  }
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(name)) walk(full);
      } else if (st.isFile()) {
        files.push(relative(repoRoot, full).replaceAll("\\", "/"));
      }
    }
  };
  walk(repoRoot);
  return files;
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
