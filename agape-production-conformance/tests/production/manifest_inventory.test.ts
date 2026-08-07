import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "./harness.js";

type Status = "implemented" | "partial" | "required_pending";
interface FixtureEntry { id: string; path: string | null; status: "implemented" | "planned" }
interface TestEntry { id: string; file: string; full_name: string; fixture_ids: string[]; execution: "fresh_cli_process" | "unit" | "coverage_gate" }
interface Allocation { id: string; target: "source" | "package"; os: "linux" | "macos" | "windows"; lane: "standard" | "slow" | "full" | "smoke"; fresh_process: boolean; test_ids: string[] }
type ProfileId = "core-agent" | "optional-memory" | "studio-fact-checker" | "research";
interface Capability { id: string; capability: string; profile: ProfileId; release_blocking: boolean; status: Status; required: boolean; fixtures: FixtureEntry[]; tests: TestEntry[]; allocations: Allocation[] }
interface Manifest { schema_version: number; pending_is_failure: boolean; profiles: Array<{ id: ProfileId; label: string }>; validation_test: { id: string; file: string; full_name: string }; capabilities: Capability[] }

const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, "manifest.json"), "utf8")) as Manifest;
const profileIds: ProfileId[] = ["core-agent", "optional-memory", "studio-fact-checker", "research"];

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

function allocationKeys(capability: Capability, target: Allocation["target"]): string[] {
  return capability.allocations.filter((entry) => entry.target === target)
    .map((entry) => `${entry.os}:${entry.lane}`).sort();
}

describe("production conformance manifest", () => {
  it("[MANIFEST.validate] validates schema, ownership, references, and allocations", async () => {
    expect(manifest.schema_version).toBe(3);
    expect(manifest.pending_is_failure).toBe(true);
    expect(manifest.profiles.map((entry) => entry.id)).toEqual(profileIds);
    expect(duplicates(manifest.profiles.map((entry) => entry.id))).toEqual([]);
    const exactIds = Array.from({ length: 16 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`);
    expect(manifest.capabilities.map((entry) => entry.id)).toEqual(exactIds);
    expect(manifest.capabilities.every((entry) => profileIds.includes(entry.profile))).toBe(true);
    expect(manifest.capabilities.filter((entry) => entry.profile === "research").every((entry) => !entry.release_blocking)).toBe(true);
    expect(manifest.capabilities.filter((entry) => entry.profile !== "research").every((entry) => entry.release_blocking)).toBe(true);
    expect(duplicates(manifest.capabilities.map((entry) => entry.capability))).toEqual([]);
    expect(manifest.capabilities.every((entry) => entry.required)).toBe(true);

    const fixtures = manifest.capabilities.flatMap((owner) => owner.fixtures.map((entry) => ({ owner, entry })));
    const tests = manifest.capabilities.flatMap((owner) => owner.tests.map((entry) => ({ owner, entry })));
    const allocations = manifest.capabilities.flatMap((owner) => owner.allocations.map((entry) => ({ owner, entry })));
    expect(duplicates(fixtures.map(({ entry }) => entry.id))).toEqual([]);
    expect(duplicates(fixtures.flatMap(({ entry }) => entry.path ? [entry.path] : []))).toEqual([]);
    expect(duplicates(tests.map(({ entry }) => entry.id))).toEqual([]);
    expect(duplicates(tests.map(({ entry }) => `${entry.file}\n${entry.full_name}`))).toEqual([]);
    expect(duplicates(allocations.map(({ entry }) => entry.id))).toEqual([]);

    const literalTestIds: string[] = [];
    const productionTestRoot = join(PACKAGE_ROOT, "tests", "production");
    for (const name of await readdir(productionTestRoot)) {
      if (!name.endsWith(".test.ts")) continue;
      const source = await readFile(join(productionTestRoot, name), "utf8");
      for (const match of source.matchAll(/\bit\(\s*["'`][^"'\`]*\[([A-Za-z][A-Za-z0-9.-]+)\]/g)) {
        literalTestIds.push(match[1]!);
      }
    }
    const registeredTestIds = new Set([manifest.validation_test.id, ...tests.map(({ entry }) => entry.id)]);
    expect(duplicates(literalTestIds), "literal test ids must be unique").toEqual([]);
    expect(literalTestIds.filter((id) => !registeredTestIds.has(id)),
      "every literal production test id must be owned by the manifest").toEqual([]);
    for (const { entry } of tests.filter(({ entry }) => entry.execution !== "coverage_gate")) {
      expect(literalTestIds, `${entry.id}: executable test id is absent from its source`).toContain(entry.id);
    }

    for (const { owner, entry } of fixtures) {
      expect(entry.id.startsWith(`${owner.id}.`), `${entry.id}: fixture must be uniquely owned by ${owner.id}`).toBe(true);
      if (entry.status === "implemented") {
        expect(entry.path, `${entry.id}: implemented fixture needs a path`).toBeTruthy();
        await expect(access(join(PACKAGE_ROOT, entry.path!))).resolves.toBeUndefined();
      } else expect(entry.path, `${entry.id}: planned fixture must not claim a file`).toBeNull();
    }
    for (const { owner, entry } of tests) {
      expect(entry.id.startsWith(`${owner.id}.`), `${entry.id}: test must be uniquely owned by ${owner.id}`).toBe(true);
      await expect(access(join(PACKAGE_ROOT, entry.file))).resolves.toBeUndefined();
      expect(entry.full_name).toContain(`[${entry.id}]`);
      const ownedFixtures = new Set(owner.fixtures.map((fixture) => fixture.id));
      expect(entry.fixture_ids.every((id) => ownedFixtures.has(id)), `${entry.id}: cross-owned or missing fixture`).toBe(true);
    }
    for (const { owner, entry } of allocations) {
      expect(entry.id.startsWith(`${owner.id}.`)).toBe(true);
      expect(entry.fresh_process, `${entry.id}: allocation must launch fresh test processes`).toBe(true);
      const ownedTests = new Set(owner.tests.map((test) => test.id));
      expect(entry.test_ids.length).toBeGreaterThan(0);
      expect(entry.test_ids.every((id) => ownedTests.has(id)), `${entry.id}: selected test is not owned by ${owner.id}`).toBe(true);
    }

    for (const capability of manifest.capabilities) {
      const allocatedTestIds = new Set(capability.allocations.flatMap((allocation) => allocation.test_ids));
      expect(capability.tests.filter((test) => !allocatedTestIds.has(test.id)).map((test) => test.id),
        `${capability.id}: every declared test must be allocated at least once`).toEqual([]);

      const sourceLane = capability.id === "P12" ? "slow" : "standard";
      expect(allocationKeys(capability, "source")).toEqual([`linux:${sourceLane}`]);
      const expectedPackages = capability.release_blocking
        ? ["linux:full", "macos:full", "windows:full"]
        : [];
      expect(allocationKeys(capability, "package"), `${capability.id}: exact release profile allocation`).toEqual(expectedPackages);
      if (capability.status !== "required_pending") {
        expect(capability.tests.some((test) => test.execution === "fresh_cli_process"), `${capability.id}: runnable capability needs a fresh CLI test`).toBe(true);
      }
      expect(capability.tests.some((test) => test.id === `${capability.id}.coverage`)).toBe(true);
    }

    const selectedTarget = process.env.AGAPE_CONFORMANCE_TARGET as Allocation["target"] | undefined;
    const selectedOs = process.env.AGAPE_CONFORMANCE_OS as Allocation["os"] | undefined;
    const selectedLane = process.env.AGAPE_CONFORMANCE_LANE as Allocation["lane"] | undefined;
    const selectedProfile = process.env.AGAPE_CONFORMANCE_PROFILE as ProfileId | undefined;
    if (selectedTarget || selectedOs || selectedLane || selectedProfile) {
      expect(selectedTarget && selectedOs && selectedLane && selectedProfile,
        "selector environment must provide profile, target, os, and lane together").toBeTruthy();
      expect(profileIds).toContain(selectedProfile);
      const selectedCapabilities = manifest.capabilities.filter((entry) => entry.profile === selectedProfile);
      const selected = allocations.filter(({ owner, entry }) =>
        owner.profile === selectedProfile && entry.target === selectedTarget && entry.os === selectedOs && entry.lane === selectedLane);
      expect(selected.length, "selector must resolve at least one executable allocation").toBeGreaterThan(0);
      expect(selected.every(({ entry }) => entry.test_ids.length > 0)).toBe(true);
      for (const capability of selectedCapabilities.filter((entry) => entry.release_blocking)) {
        expect(capability.allocations.some((entry) =>
          entry.target === selectedTarget && entry.os === selectedOs && entry.lane === selectedLane),
        `${capability.id}: release-blocking selected profile is missing its ${selectedTarget}/${selectedOs}/${selectedLane} allocation`).toBe(true);
      }
    }
  });

  for (const capability of manifest.capabilities) {
    it(`[${capability.id}.coverage] required capability coverage`, () => {
      const selectedProfile = process.env.AGAPE_CONFORMANCE_PROFILE as ProfileId | undefined;
      if (selectedProfile && capability.profile !== selectedProfile) return;
      if (!capability.release_blocking) {
        expect(["implemented", "partial", "required_pending"]).toContain(capability.status);
        return;
      }
      expect(capability.status, `${capability.id} remains ${capability.status}; required production oracle is incomplete`).toBe("implemented");
    });
  }
});
