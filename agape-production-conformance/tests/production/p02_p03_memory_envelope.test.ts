import { afterEach, describe, expect, it } from "vitest";
import { createTempProject, eventsOf, fixture, runCli, runDiagnostic, sentinel, type TempProject } from "./harness.js";
import { chatCompletion, OpenAILoopback, twoVariantCandidates } from "./openai-loopback.js";

function assertNoImplicitMemory(events: ReturnType<typeof eventsOf>, label: string): void {
  expect.soft(events.filter((event) => event.etype === "MemoryConsulted"),
    label + ": source without mem -> must not consult memory").toHaveLength(0);
  expect.soft(events.filter((event) => event.etype === "MemoryWriteEvaluated"),
    label + ": source without mem <- must not evaluate a memory write").toHaveLength(0);
  expect.soft(events.filter((event) => event.etype === "MemoryWriteFailed"),
    label + ": source without mem <- must not attempt a memory write").toHaveLength(0);
  expect.soft(events.filter((event) => event.etype === "Internalized"),
    label + ": source without mem <- must not append Internalized").toHaveLength(0);
}


describe("P02/P03 production explicit memory boundary", () => {
  let project: TempProject | undefined;
  let loopback: OpenAILoopback | undefined;

  afterEach(async () => {
    await loopback?.close();
    await project?.cleanup();
  });

  it("[P02.awake-credence] keeps a Credence-producing awake reaction free of implicit memory operations", async () => {
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
    const events = eventsOf(result);
    assertNoImplicitMemory(events, "P02 Credence reaction");
  });

  it("[P03.raw] keeps bound and unbound provider replies free of implicit memory operations", async () => {
    const values = { BOUND_PROMPT: sentinel("P03_BOUND_RAW"), UNBOUND_PROMPT: sentinel("P03_UNBOUND_RAW") };
    project = await createTempProject(sentinel("p03-raw-project"));
    const file = await project.write("main.ag", await fixture("p02-p03/raw.ag.tmpl", values));
    loopback = new OpenAILoopback(({ body }) => ({
      body: chatCompletion({ content: body.response_format ? JSON.stringify({ value: "bound-raw" }) : "unbound-raw" }),
    }));
    await loopback.start();

    const result = await runCli({ project, file, env: loopback.env() });
    expect(result.json?.ok, runDiagnostic(result)).toBe(true);
    expect(loopback.transcript, "P03 raw control requires bound and unbound production calls").toHaveLength(2);
    const events = eventsOf(result);
    assertNoImplicitMemory(events, "P03 raw reaction");
  });

  it("[P03.structured] keeps a nested structured provider reply free of implicit memory operations", async () => {
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
    expect.soft(loopback.transcript[0]!.body.response_format, "P03: nested typed send must use constrained structured output")
      .toEqual(expect.any(Object));
    const events = eventsOf(result);
    assertNoImplicitMemory(events, "P03 nested structured reaction");
  });

  it("[P03.no-provider] keeps deterministic local work free of implicit memory operations", async () => {
    project = await createTempProject(sentinel("p03-no-provider-project"));
    const file = await project.write("main.ag", await fixture("p02-p03/no-provider.ag.tmpl"));
    loopback = new OpenAILoopback(() => ({ body: chatCompletion({ content: "unexpected" }) }));
    await loopback.start();

    const result = await runCli({ project, file, env: loopback.env() });
    expect(result.json?.ok, runDiagnostic(result)).toBe(true);
    expect(loopback.transcript, "P03 control: local work must not fabricate cognition calls").toHaveLength(0);
    const events = eventsOf(result);
    assertNoImplicitMemory(events, "P03 zero-provider reaction");
  });
});
