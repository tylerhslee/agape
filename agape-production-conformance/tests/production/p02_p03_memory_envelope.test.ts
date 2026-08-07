import { afterEach, describe, expect, it } from "vitest";
import { createTempProject, eventsOf, fixture, payloadObject, runCli, runDiagnostic, sentinel, type TempProject } from "./harness.js";
import { chatCompletion, OpenAILoopback, twoVariantCandidates } from "./openai-loopback.js";

function assertAutomaticEnvelope(events: ReturnType<typeof eventsOf>, label: string): void {
  const consulted = events.filter((event) => event.etype === "MemoryConsulted"
    && payloadObject(event).consult_kind === "automatic_reaction");
  const evaluated = events.filter((event) => event.etype === "MemoryWriteEvaluated"
    && payloadObject(event).closure_kind === "automatic_reaction");
  expect.soft(consulted, `${label}: expected exactly one automatic-reaction consultation`).toHaveLength(1);
  expect.soft(evaluated, `${label}: expected exactly one automatic-reaction closure`).toHaveLength(1);
  if (!consulted[0] || !evaluated[0]) return;

  const consultPayload = payloadObject(consulted[0]);
  const evaluationPayload = payloadObject(evaluated[0]);
  expect.soft(consultPayload.reaction_event, `${label}: consultation must name its stimulus event`).toEqual(expect.any(Number));
  expect.soft(evaluationPayload.reaction_event, `${label}: closure must correlate to the same stimulus`)
    .toBe(consultPayload.reaction_event);
  expect.soft(evaluationPayload.write_source, `${label}: automatic closure must identify its write source`)
    .toBe("automatic_reaction");
  const disposition = evaluationPayload.disposition;
  expect.soft(disposition, `${label}: disposition must use the canonical lowercase vocabulary`)
    .toSatisfy((value) => typeof value === "string"
      && ["stored", "skipped", "deduplicated", "failed"].includes(value));

  const correlatedWrites = events.filter((event) => {
    const payload = payloadObject(event);
    return event.etype === "Internalized"
      && payload.write_source === "automatic_reaction"
      && payload.evaluation_event === evaluated[0]!.tick;
  });
  const correlatedFailures = events.filter((event) => event.etype === "MemoryWriteFailed"
    && payloadObject(event).evaluation_event === evaluated[0]!.tick);
  if (disposition === "stored") {
    expect.soft(correlatedWrites, `${label}: stored closure must atomically commit one linked Internalized`).toHaveLength(1);
    expect.soft(correlatedWrites[0]?.tick, `${label}: evaluation and store receipt must be an atomic adjacent pair`)
      .toBe(evaluated[0].tick + 1);
    expect.soft(payloadObject(correlatedWrites[0]).reaction_event).toBe(consultPayload.reaction_event);
    expect.soft(evaluationPayload.committed_receipt_id, `${label}: stored closure must link its committed receipt`)
      .toBe(correlatedWrites[0]?.tick);
    expect.soft(payloadObject(correlatedWrites[0]).explicit_evaluation_event,
      `${label}: automatic Internalized must not masquerade as an explicit-store receipt`).toBeNull();
  } else {
    expect.soft(correlatedWrites, `${label}: non-stored closure must not fabricate an Internalized`).toHaveLength(0);
    expect.soft(evaluationPayload.committed_receipt_id, `${label}: non-stored closure has no committed receipt`).toBeNull();
  }
  if (disposition === "failed") {
    expect.soft(correlatedFailures, `${label}: failed closure must atomically record MemoryWriteFailed`).toHaveLength(1);
  } else {
    expect.soft(correlatedFailures, `${label}: non-failed closure must not record MemoryWriteFailed`).toHaveLength(0);
  }
}

function assertStoredOutcome(
  events: ReturnType<typeof eventsOf>,
  expected: { kind: "raw" | "structured" | "credence"; trust: "raw" | "graded"; sourceCount: number; credence?: boolean },
  label: string,
): void {
  const evaluation = events.find((event) => event.etype === "MemoryWriteEvaluated"
    && payloadObject(event).closure_kind === "automatic_reaction");
  if (!evaluation || payloadObject(evaluation).disposition !== "stored") return;
  const receipt = events.find((event) => event.etype === "Internalized"
    && payloadObject(event).evaluation_event === evaluation.tick);
  expect.soft(receipt, `${label}: stored outcome must have its linked receipt`).toBeTruthy();
  expect.soft(payloadObject(receipt), `${label}: stored receipt must truthfully classify the provider outcome`).toMatchObject({
    outcome_kind: expected.kind,
    outcome_trust: expected.trust,
  });
  const payload = payloadObject(receipt);
  const evaluationPayload = payloadObject(evaluation);
  const stimulusEvent = payload.stimulus_event ?? payload.reaction_event;
  expect.soft(stimulusEvent, `${label}: stored receipt must name the reaction stimulus`)
    .toBe(evaluationPayload.reaction_event);
  const sourceEvents = (payload.source_events ?? (payload.source_event !== undefined ? [payload.source_event] : [])) as unknown[];
  const promptHashes = (payload.prompt_hashes ?? (payload.prompt_hash !== undefined ? [payload.prompt_hash] : [])) as unknown[];
  expect.soft(sourceEvents, `${label}: stored receipt must name every provider source event`)
    .toHaveLength(expected.sourceCount);
  expect.soft(promptHashes, `${label}: stored receipt must name every protected prompt by hash`)
    .toHaveLength(expected.sourceCount);
  expect.soft(payload.outcome_hash, `${label}: stored receipt must hash the protected outcome`)
    .toEqual(expect.any(String));
  if (expected.credence) {
    const gateScores = (payload.gate_scores ?? (payload.outcome as Record<string, unknown> | undefined)?.gate_scores);
    expect.soft(gateScores, `${label}: stored Credence must retain every public variant score`).toMatchObject({
      Approve: expect.any(Number),
      Reject: expect.any(Number),
    });
    const evidence = (payload.outcome as Record<string, unknown> | undefined) ?? payload;
    expect.soft(evidence, `${label}: stored Credence must link its immutable evidence`).toMatchObject({
      evidence_id: expect.any(String),
      evidence_hash: expect.any(String),
      evidence_ref: expect.any(String),
    });
  }
}

describe("P02/P03 production reaction memory envelope", () => {
  let project: TempProject | undefined;
  let loopback: OpenAILoopback | undefined;

  afterEach(async () => {
    await loopback?.close();
    await project?.cleanup();
  });

  it("[P02.awake-credence] wraps a Credence-producing awake reaction with one consult and one write evaluation", async () => {
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
    assertAutomaticEnvelope(events, "P02/P03 Credence reaction");
    assertStoredOutcome(events, { kind: "credence", trust: "graded", sourceCount: 1, credence: true }, "P02 Credence reaction");
    const consulted = events.find((event) => event.etype === "MemoryConsulted"
      && payloadObject(event).consult_kind === "automatic_reaction");
    const evaluated = events.find((event) => event.etype === "MemoryWriteEvaluated"
      && payloadObject(event).closure_kind === "automatic_reaction");
    if (consulted) {
      const sentTick = events.find((event) => event.etype === "Sent")?.tick ?? Number.POSITIVE_INFINITY;
      expect.soft(consulted.tick, "P02/P03: consultation must precede cognition").toBeLessThan(sentTick);
      expect.soft(payloadObject(consulted), "P02/P03: an empty packet is explicit rather than omitted")
        .toMatchObject({ empty: true });
    }
    if (evaluated) {
      const resolvedTick = events.find((event) => event.etype === "Resolved")?.tick ?? -1;
      expect.soft(evaluated.tick, "P02/P03: automatic write evaluation closes the reaction").toBeGreaterThan(resolvedTick);
    }
  });

  it("[P03.raw] wraps bound and unbound raw provider replies in one automatic envelope", async () => {
    const values = { BOUND_PROMPT: sentinel("P03_BOUND_RAW"), UNBOUND_PROMPT: sentinel("P03_UNBOUND_RAW") };
    project = await createTempProject(sentinel("p03-raw-project"));
    const file = await project.write("main.ag", await fixture("p02-p03/raw.ag.tmpl", values));
    loopback = new OpenAILoopback(({ index }) => ({ body: chatCompletion({ content: index === 0 ? "bound-raw" : "unbound-raw" }) }));
    await loopback.start();

    const result = await runCli({ project, file, env: loopback.env() });
    expect(result.json?.ok, runDiagnostic(result)).toBe(true);
    expect(loopback.transcript, "P03 raw control requires bound and unbound production calls").toHaveLength(2);
    const events = eventsOf(result);
    assertAutomaticEnvelope(events, "P03 raw reaction");
    assertStoredOutcome(events, { kind: "raw", trust: "raw", sourceCount: 2 }, "P03 raw reaction");
  });

  it("[P03.structured] wraps a nested structured provider reply and classifies its raw trust truthfully", async () => {
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
    assertAutomaticEnvelope(events, "P03 nested structured reaction");
    assertStoredOutcome(events, { kind: "structured", trust: "raw", sourceCount: 1 }, "P03 nested structured reaction");
  });

  it("[P03.no-provider] runs the full envelope for a deterministic reaction with zero provider calls", async () => {
    project = await createTempProject(sentinel("p03-no-provider-project"));
    const file = await project.write("main.ag", await fixture("p02-p03/no-provider.ag.tmpl"));
    loopback = new OpenAILoopback(() => ({ body: chatCompletion({ content: "unexpected" }) }));
    await loopback.start();

    const result = await runCli({ project, file, env: loopback.env() });
    expect(result.json?.ok, runDiagnostic(result)).toBe(true);
    expect(loopback.transcript, "P03 control: local work must not fabricate cognition calls").toHaveLength(0);
    const events = eventsOf(result);
    assertAutomaticEnvelope(events, "P03 zero-provider reaction");
    const consulted = events.find((event) => event.etype === "MemoryConsulted"
      && payloadObject(event).consult_kind === "automatic_reaction");
    const evaluated = events.find((event) => event.etype === "MemoryWriteEvaluated"
      && payloadObject(event).closure_kind === "automatic_reaction");
    if (consulted && evaluated) expect.soft(consulted.tick).toBeLessThan(evaluated.tick);
  });
});
