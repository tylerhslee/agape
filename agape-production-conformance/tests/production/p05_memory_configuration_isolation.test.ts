import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTempProject, eventsOf, fixture, payloadObject, readTree, runCli, runDiagnostic, sentinel,
  type TempProject,
} from "./harness.js";

function manifest(memory: string): string {
  return `[project]
name = "p05-memory-configuration"
entry = "main.ag"

[provider]
backend = "mock"

${memory}`;
}

function expectConfigError(result: Awaited<ReturnType<typeof runCli>>, label: string): void {
  expect.soft(result.exitCode, `${label}: runtime unexpectedly started\n${runDiagnostic(result)}`).not.toBe(0);
  expect.soft(result.json?.ok, `${label}: error envelope reported success\n${runDiagnostic(result)}`).toBe(false);
  expect.soft(result.json?.class, `${label}: wrong diagnostic class\n${runDiagnostic(result)}`).toBe("ConfigError");
  expect.soft(String(result.json?.error ?? result.stderr), `${label}: diagnostic must identify the memory driver`)
    .toMatch(/memory.*driver|driver.*memory/i);
  expect.soft(eventsOf(result), `${label}: configuration failure must precede runtime effects`).toHaveLength(0);
}

describe("P05 production required memory configuration and isolation", () => {
  let project: TempProject | undefined;

  afterEach(async () => {
    await project?.cleanup();
  });

  it("[P05.memory-binding-required] rejects missing, blank, and unknown runtime memory drivers before execution", async () => {
    project = await createTempProject(sentinel("p05-config-project"));
    const file = await project.write("main.ag", await fixture("p02-p03/no-provider.ag.tmpl"));

    await project.write("agape.toml", manifest(""));
    expectConfigError(await runCli({ project, file }), "missing [memory].driver");

    await project.write("agape.toml", manifest(`[memory]
driver = ""
`));
    expectConfigError(await runCli({ project, file }), "blank [memory].driver");

    await project.write("agape.toml", manifest(`[memory]
driver = "not-a-real-memory-driver"
`));
    expectConfigError(await runCli({ project, file }), "unknown [memory].driver");
  });

  it("[P05.configured-memory-boot] starts an ordinary runtime session with an explicitly configured driver", async () => {
    project = await createTempProject(sentinel("p05-configured-project"));
    const file = await project.write("main.ag", await fixture("p02-p03/no-provider.ag.tmpl"));
    const result = await runCli({ project, file });

    expect(result.json?.ok, runDiagnostic(result)).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("[P05.instance-handle-isolation] confines each handle to its exact live agent instance", async () => {
    const values = {
      FIRST_PRIMARY: sentinel("P05_FIRST_PRIMARY"),
      FIRST_SECONDARY: sentinel("P05_FIRST_SECONDARY"),
      SECOND_PRIMARY: sentinel("P05_SECOND_PRIMARY"),
      SECOND_SECONDARY: sentinel("P05_SECONDARY"),
    };
    const secrets = Object.values(values);
    project = await createTempProject(sentinel("p05-isolation-project"));
    const file = await project.write("main.ag", await fixture("p05/instance_store.ag.tmpl", values));
    const result = await runCli({ project, file });

    expect(result.json?.ok, runDiagnostic(result)).toBe(true);
    const spawned = eventsOf(result, "Spawned");
    const instanceByAlias = new Map(spawned.map((event) =>
      [String(payloadObject(event).alias), payloadObject(event).instance_id]));
    const firstId = instanceByAlias.get("first_agent");
    const secondId = instanceByAlias.get("second_agent");
    expect.soft(firstId).toMatch(/^agent-instance-v1:[0-9a-f]{64}$/);
    expect.soft(secondId).toMatch(/^agent-instance-v1:[0-9a-f]{64}$/);
    expect.soft(firstId, "P05: distinct concrete spawns reused one stable instance id").not.toBe(secondId);

    const stored = eventsOf(result, "Internalized");
    expect.soft(stored, "P05: two instances with two handles each require four explicit stores").toHaveLength(4);
    expect.soft(new Set(stored.map((event) => `${event.agent}:${event.subject}`)),
      "P05: receipts must retain concrete stable instance and handle identity")
      .toEqual(new Set([
        `${String(firstId)}:notes`,
        `${String(firstId)}:scratch`,
        `${String(secondId)}:notes`,
        `${String(secondId)}:scratch`,
      ]));
    const payloads = stored.map(payloadObject);
    const regionRefs = payloads.map((payload) => (payload.refs as unknown[]).find((ref) =>
      typeof ref === "string" && ref.startsWith("memory-region-v1:")));
    expect.soft(new Set(regionRefs),
      "P05: every concrete instance/handle pair must resolve to a distinct canonical region").toHaveLength(4);
    expect.soft(new Set(payloads.map((payload) => payload.descriptor_hash)),
      "P05: the two declared handles must retain distinct descriptors across instances").toHaveLength(2);
    expect.soft(new Set(payloads.map((payload) => payload.scope_hash)),
      "P05: equal declared project scopes must resolve to one authenticated scope tuple").toHaveLength(1);
    for (const payload of payloads) {
      expect.soft(payload).toMatchObject({
        operation: "store",
        write_source: "explicit_store",
        operation_id: expect.stringMatching(/^memory-operation-v1:[0-9a-f]{64}$/),
        origin_ref: expect.stringMatching(/^memory-origin-v1:[0-9a-f]{64}$/),
        scope_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        refs: expect.any(Array),
      });
    }
    const publicReceipts = JSON.stringify(stored);
    for (const secret of secrets) {
      expect.soft(publicReceipts, "P05: public Internalized receipt leaked private plaintext").not.toContain(secret);
    }

    const tree = await readTree(join(project.root, ".agape", "memory"));
    const projections = Object.entries(tree).filter(([path]) =>
      /^regions\/[0-9a-f]{64}\/generation-0\/MEMORY\.md$/.test(path));
    expect.soft(projections, "P05: every isolated canonical region requires one opaque projection")
      .toHaveLength(4);
    for (const [path, contents] of projections) {
      expect.soft(path).not.toMatch(/first_agent|second_agent|notes|scratch|p05-isolation-project/i);
      expect.soft(secrets.filter((secret) => contents.includes(secret)),
        `P05: projection ${path} must contain exactly one region's private value`).toHaveLength(1);
    }
    for (const secret of secrets) {
      expect.soft(projections.filter(([, contents]) => contents.includes(secret)),
        "P05: a private value crossed region boundaries or was omitted").toHaveLength(1);
    }
  });
});
