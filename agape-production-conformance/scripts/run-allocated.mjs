import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const options = Object.create(null);
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value) throw new Error(`invalid selector argument near ${key ?? "<end>"}`);
  options[key.slice(2)] = value;
}
const target = options.target ?? "source";
const os = options.os ?? "linux";
const lane = options.lane ?? "standard";
const profile = options.profile ?? "core-agent";
const listOnly = options.list === "true";
if (!["source", "package"].includes(target)) throw new Error(`invalid target ${target}`);
if (!["linux", "macos", "windows"].includes(os)) throw new Error(`invalid os ${os}`);
if (!["standard", "slow", "full", "smoke"].includes(lane)) throw new Error(`invalid lane ${lane}`);
const knownProfiles = new Set(manifest.profiles.map((entry) => entry.id));
if (!knownProfiles.has(profile)) throw new Error(`invalid profile ${profile}`);

const selected = [];
for (const capability of manifest.capabilities) {
  if (capability.profile !== profile) continue;
  const allocation = capability.allocations.find((entry) =>
    entry.target === target && entry.os === os && entry.lane === lane);
  if (!allocation) continue;
  const tests = new Map(capability.tests.map((entry) => [entry.id, entry]));
  for (const id of allocation.test_ids) {
    const test = tests.get(id);
    if (!test) throw new Error(`${allocation.id} selects missing or cross-owned test ${id}`);
    selected.push({ capability: capability.id, allocation: allocation.id, ...test });
  }
}
if (!selected.length) throw new Error(`no manifest allocations for ${profile}/${target}/${os}/${lane}`);
if (listOnly) {
  for (const test of selected) console.log(`${profile}\t${test.id}\t${test.file}\t${test.full_name}`);
  process.exit(0);
}

const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const env = {
  ...process.env,
  AGAPE_CONFORMANCE_TARGET: target,
  AGAPE_CONFORMANCE_OS: os,
  AGAPE_CONFORMANCE_LANE: lane,
  AGAPE_CONFORMANCE_PROFILE: profile,
};
const invocations = [manifest.validation_test, ...selected];
let failed = false;
const reportDir = mkdtempSync(join(tmpdir(), "agape-production-conformance-"));
try {
  for (const [index, test] of invocations.entries()) {
    const escapedName = test.full_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reportPath = join(reportDir, `${index}.json`);
    console.log(`\n==> ${test.id} (${profile}/${target}/${os}/${lane})`);
    const result = spawnSync(process.execPath, [
      vitest, "run", test.file,
      "--config", join(root, "vitest.config.ts"),
      "--testNamePattern", `^${escapedName}$`,
      "--reporter=default",
      "--reporter=json",
      "--outputFile", reportPath,
    ], { cwd: root, env, stdio: "inherit", shell: false });
    if (result.error) throw result.error;

    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      const executed = (report.testResults ?? [])
        .flatMap((suite) => suite.assertionResults ?? [])
        .filter((entry) => entry.fullName === test.full_name &&
          (entry.status === "passed" || entry.status === "failed"));
      if (executed.length !== 1) {
        console.error(`integrity error: ${test.id} expected exactly one non-pending execution for ${JSON.stringify(test.full_name)}, got ${executed.length}`);
        failed = true;
      }
    } catch (error) {
      console.error(`integrity error: ${test.id} did not produce a readable Vitest JSON report: ${error instanceof Error ? error.message : String(error)}`);
      failed = true;
    }
    if (result.status !== 0) failed = true;
  }
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
