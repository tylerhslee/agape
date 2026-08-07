import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTempProject,
  eventsOf,
  fixture,
  readTree,
  runCli,
  runDiagnostic,
  sentinel,
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
      SECOND_SECONDARY: sentinel("P05_SECOND_SECONDARY"),
    };
    const secrets = Object.values(values);
    project = await createTempProject(sentinel("p05-isolation-project"));
    const file = await project.write("main.ag", await fixture("p05/instance_store.ag.tmpl", values));
    const result = await runCli({ project, file });

    expect(result.json?.ok, runDiagnostic(result)).toBe(true);
    const stored = eventsOf(result, "Internalized");
    expect.soft(stored, "P05: two instances with two handles each require four explicit stores").toHaveLength(4);
    expect.soft(new Set(stored.map((event) => `${event.agent}:${event.subject}`)),
      "P05: receipts must retain both instance and handle identity")
      .toEqual(new Set([
        "first_agent:notes",
        "first_agent:scratch",
        "second_agent:notes",
        "second_agent:scratch",
      ]));
    const publicReceipts = JSON.stringify(stored);
    for (const secret of secrets) {
      expect.soft(publicReceipts, "P05: public Internalized receipt leaked private plaintext").not.toContain(secret);
    }

    const tree = await readTree(join(project.root, ".agape", "memory"));
    const topic = (agent: string, mem: string): [string, string] => {
      const entries = Object.entries(tree).filter(([path]) =>
        path.includes(`/${agent}/`) && path.endsWith(`/${mem}.md`) && !path.includes("/.archive/"));
      expect(entries, `P05: expected one durable topic for ${agent}/${mem}`).toHaveLength(1);
      return entries[0]!;
    };
    const firstNotes = topic("first_agent", "notes")[1];
    const firstScratch = topic("first_agent", "scratch")[1];
    const secondNotes = topic("second_agent", "notes")[1];
    const secondScratch = topic("second_agent", "scratch")[1];

    expect.soft(firstNotes).toContain(values.FIRST_PRIMARY);
    expect.soft(firstNotes).not.toContain(values.FIRST_SECONDARY);
    expect.soft(firstNotes).not.toContain(values.SECOND_PRIMARY);
    expect.soft(firstNotes).not.toContain(values.SECOND_SECONDARY);
    expect.soft(firstScratch).toContain(values.FIRST_SECONDARY);
    expect.soft(firstScratch).not.toContain(values.FIRST_PRIMARY);
    expect.soft(firstScratch).not.toContain(values.SECOND_PRIMARY);
    expect.soft(firstScratch).not.toContain(values.SECOND_SECONDARY);
    expect.soft(secondNotes).toContain(values.SECOND_PRIMARY);
    expect.soft(secondNotes).not.toContain(values.SECOND_SECONDARY);
    expect.soft(secondNotes).not.toContain(values.FIRST_PRIMARY);
    expect.soft(secondNotes).not.toContain(values.FIRST_SECONDARY);
    expect.soft(secondScratch).toContain(values.SECOND_SECONDARY);
    expect.soft(secondScratch).not.toContain(values.SECOND_PRIMARY);
    expect.soft(secondScratch).not.toContain(values.FIRST_PRIMARY);
    expect.soft(secondScratch).not.toContain(values.FIRST_SECONDARY);
  });
});
