import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempProject, eventsOf, fixture, readTree, runCli, runDiagnostic, sentinel, type TempProject } from "./harness.js";
import { chatCompletion, OpenAILoopback, twoVariantCandidates } from "./openai-loopback.js";

async function assertNoImplicitLearning(
  project: TempProject,
  events: ReturnType<typeof eventsOf>,
  label: string,
): Promise<void> {
  expect.soft(events.filter((event) => event.etype === "MemoryConsulted"),
    `${label}: a reaction without mem -> must not consult memory`).toHaveLength(0);
  expect.soft(events.filter((event) => event.etype === "MemoryWriteEvaluated"),
    `${label}: a reaction without mem <- must not evaluate a memory write`).toHaveLength(0);
  expect.soft(events.filter((event) => event.etype === "MemoryWriteFailed"),
    `${label}: a reaction without mem <- must not attempt a memory write`).toHaveLength(0);
  expect.soft(events.filter((event) => event.etype === "Internalized"),
    `${label}: a reaction without mem <- must not emit an Internalized receipt`).toHaveLength(0);
  expect.soft(await readTree(join(project.root, ".agape", "memory")),
    `${label}: a reaction without mem <- must not mutate durable memory`).toEqual({});
}

describe("P02/P03 production optional learning boundary", () => {
  let project: TempProject | undefined;
  let loopback: OpenAILoopback | undefined;

  afterEach(async () => {
    await loopback?.close();
    await project?.cleanup();
  });

  it("[P02.no-implicit-credence] keeps a Credence-producing awake reaction memory-free without explicit mem operations", async () => {
    const prompt = sentinel("P02_CREDENCE_PROMPT");
    project = await createTempProject(sentinel("p02-project"));
    const file = await project.write("main.ag", await fixture("p02-p03/credence.ag.tmpl", { PROMPT: prompt }));
    loopback = new OpenAILoopback(() => ({
      body: chatCompletion({ content: "Approve", rawCandidates: twoVariantCandidates("Approve", "Reject") }),
    }));
    await loopback.start();

    const result = await runCli({ project, file, env: loopback.env() });
    expect(result.json?.ok, runDiagnostic(result)).toBe(true);
    expect(loopback.transcript).toHaveLength(1);
    await assertNoImplicitLearning(project, eventsOf(result), "P02 Credence reaction");
  });

  it("[P03.no-implicit-raw] keeps typed scalar and unbound raw replies memory-free without explicit mem operations", async () => {
    const values = { BOUND_PROMPT: sentinel("P03_BOUND_TYPED"), UNBOUND_PROMPT: sentinel("P03_UNBOUND_RAW") };
    project = await createTempProject(sentinel("p03-raw-project"));
    const file = await project.write("main.ag", await fixture("p02-p03/raw.ag.tmpl", values));
    loopback = new OpenAILoopback(({ body }) => ({
      body: chatCompletion({
        content: body.response_format ? JSON.stringify({ value: "bound-typed" }) : "unbound-raw",
      }),
    }));
    await loopback.start();

    const result = await runCli({ project, file, env: loopback.env() });
    expect(result.json?.ok, runDiagnostic(result)).toBe(true);
    expect(loopback.transcript, "P03 control requires one typed scalar and one bare raw production call").toHaveLength(2);
    expect.soft(loopback.transcript[0]!.body.response_format,
      "P03: a bound text reply remains typed structured output").toEqual(expect.any(Object));
    expect.soft(loopback.transcript[1]!.body.response_format,
      "P03: only the unbound send uses the raw-reply seam").toBeUndefined();
    await assertNoImplicitLearning(project, eventsOf(result), "P03 typed scalar and raw reaction");
  });

  it("[P03.no-implicit-structured] keeps a nested structured reply memory-free without explicit mem operations", async () => {
    const prompt = sentinel("P03_NESTED_STRUCTURED");
    const answer = sentinel("P03_NESTED_ANSWER");
    project = await createTempProject(sentinel("p03-structured-project"));
    const file = await project.write("main.ag", await fixture("p02-p03/structured.ag.tmpl", { PROMPT: prompt }));
    loopback = new OpenAILoopback(() => ({
      body: chatCompletion({ content: JSON.stringify({ result: { value: answer } }) }),
    }));
    await loopback.start();

    const result = await runCli({ project, file, env: loopback.env() });
    expect(result.json?.ok, runDiagnostic(result)).toBe(true);
    expect(loopback.transcript).toHaveLength(1);
    expect.soft(loopback.transcript[0]!.body.response_format,
      "P03: nested typed send must use constrained structured output").toEqual(expect.any(Object));
    await assertNoImplicitLearning(project, eventsOf(result), "P03 nested structured reaction");
  });

  it("[P03.no-implicit-no-provider] keeps deterministic awake work memory-free without provider or explicit mem operations", async () => {
    project = await createTempProject(sentinel("p03-no-provider-project"));
    const file = await project.write("main.ag", await fixture("p02-p03/no-provider.ag.tmpl"));
    loopback = new OpenAILoopback(() => ({ body: chatCompletion({ content: "unexpected" }) }));
    await loopback.start();

    const result = await runCli({ project, file, env: loopback.env() });
    expect(result.json?.ok, runDiagnostic(result)).toBe(true);
    expect(loopback.transcript, "P03 control: local work must not fabricate cognition calls").toHaveLength(0);
    await assertNoImplicitLearning(project, eventsOf(result), "P03 zero-provider reaction");
  });
});
