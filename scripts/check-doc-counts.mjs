#!/usr/bin/env node
// Doc-drift gate: every count written in agape-ts/CONFORMANCE.md and
// agape-ts/README.md must match what the suites actually produce.
//
// Sources of truth (artifacts CI already generates — run this AFTER the suites):
//   - conformance total + sections + per-section: agape-ts/conformance/results.json
//     (written by `npx tsx conformance/run.mts`).
//   - vitest unit total: a vitest JSON report ($VITEST_JSON, else
//     test-results/unit.json); if absent we run vitest in agape-ts once.
//   - runtime-contract total: a vitest JSON report ($RUNTIME_JSON, else
//     test-results/runtime.json); if absent we run the agape-ts adapter suite.
//   - runtime-contract file count: number of *.test.ts in
//     agape-runtime-conformance/tests (a stable, dependency-free source).
//
// Exit 1 on any mismatch with a precise diff; exit 0 when the docs are in sync.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const tsDir = join(repo, "agape-ts");
const rtDir = join(repo, "agape-runtime-conformance");
const CONF = join(tsDir, "CONFORMANCE.md");
const README = join(tsDir, "README.md");

const mismatches = [];
const note = (m) => mismatches.push(m);

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
function vitestCount(envVar, defaultFile, run) {
  const p = process.env[envVar] || defaultFile;
  if (existsSync(p)) return readJson(p).numTotalTests;
  const out = run(); // stdout with a JSON report somewhere in it
  return JSON.parse(out.slice(out.indexOf("{"))).numTotalTests;
}

// ── derive ─────────────────────────────────────────────────────────────────
const resultsPath = join(tsDir, "conformance", "results.json");
if (!existsSync(resultsPath)) {
  console.error(`FATAL: ${resultsPath} missing — run \`npx tsx conformance/run.mts\` first.`);
  process.exit(1);
}
const results = readJson(resultsPath);
const confTotal = results.total;
const sectionCount = Object.keys(results.bySection).length;

const unitTotal = vitestCount("VITEST_JSON", join(repo, "test-results", "unit.json"), () =>
  execSync("npx vitest run --reporter=json", { cwd: tsDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));

const rtTotal = vitestCount("RUNTIME_JSON", join(repo, "test-results", "runtime.json"), () =>
  execSync("npx vitest run --reporter=json", {
    cwd: rtDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, AGAPE_RUNTIME_ADAPTER: "../agape-ts/src/runtime_adapter.ts" },
  }));

const rtFiles = readdirSync(join(rtDir, "tests")).filter((f) => f.endsWith(".test.ts")).length;

// ── read the numbers the docs claim ─────────────────────────────────────────
const conf = readFileSync(CONF, "utf8");
const readme = readFileSync(README, "utf8");

// helper: match `<re>` in `text`; compare captured pair(s) to expected value(s).
function pair(text, label, re, ...expected) {
  const m = text.match(re);
  if (!m) return note(`${label}: pattern not found (${re}).`);
  const got = expected.map((_, i) => +m[i + 1]);
  if (got.some((g, i) => g !== expected[i]))
    note(`${label}: says ${got.join(" / ")}, actual ${expected.join(" / ")}.`);
}

// CONFORMANCE.md prose + scorecard.
pair(conf, "CONFORMANCE.md prose (conformance)", /(\d+)\s+tests\s+across\s+(\d+)\s+sections/, confTotal, sectionCount);
pair(conf, "CONFORMANCE.md prose (runtime-contract)", /(\d+)\s+tests\s+across\s+(\d+)\s+files/, rtTotal, rtFiles);
pair(conf, "CONFORMANCE.md scorecard TOTAL", /TOTAL\s+(\d+)\s*\/\s*(\d+)/, confTotal, confTotal);
pair(conf, "CONFORMANCE.md vitest suite", /vitest suite:\s*(\d+)\s*\/\s*(\d+)/, unitTotal, unitTotal);
pair(conf, "CONFORMANCE.md runtime-contract", /runtime-contract:\s*(\d+)\s*\/\s*(\d+)/, rtTotal, rtTotal);

// CONFORMANCE.md per-section scorecard rows: e.g. "00_lexical  11 / 11".
for (const [section, s] of Object.entries(results.bySection)) {
  const re = new RegExp(`${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\d+)\\s*/\\s*(\\d+)`);
  pair(conf, `CONFORMANCE.md section ${section}`, re, s.total, s.total);
}

// README.md headline.
pair(readme, "README.md conformance", /Conformance:\s*(\d+)\s*\/\s*(\d+)/, confTotal, confTotal);
pair(readme, "README.md runtime-contract", /plus\s+(\d+)\/(\d+)\s+on/, rtTotal, rtTotal);
pair(readme, "README.md vitest units", /(\d+)\/(\d+)\s+vitest/, unitTotal, unitTotal);

// ── verdict ─────────────────────────────────────────────────────────────────
const derived = `conformance ${confTotal}/${confTotal} (${sectionCount} sections), ` +
  `vitest ${unitTotal}/${unitTotal}, runtime-contract ${rtTotal}/${rtTotal} (${rtFiles} files)`;
if (mismatches.length) {
  console.error("Doc-count drift detected:\n  - " + mismatches.join("\n  - "));
  console.error(`\nDerived: ${derived}.`);
  console.error("Update CONFORMANCE.md / README.md (or fix the suite) so the stated counts match.");
  process.exit(1);
}
console.log(`Doc counts in sync: ${derived}.`);
