import { beforeEach, describe, expect, it } from "vitest";
import { loadAdapter } from "../src/loader.js";
import { inspectText, packetText, payloadObject, requireEvent, expectOriginTicks, totalMemoryCells } from "../src/assertions.js";
import type { AgentRef } from "../src/adapter.js";

const adapter = await loadAdapter();
const suite = adapter ? describe : describe.skip;

function agent(instanceId: string): AgentRef {
  return { template: "ConformanceAgent", instanceId };
}

suite("SPEC 16.7 memory envelope", () => {
  beforeEach(async () => {
    await adapter!.reset();
  });

  it("records MemoryConsulted for every agent turn, including empty memory", async () => {
    const a = agent("mem-empty");
    const turn = await adapter!.agentRespond({
      agent: a,
      task: "answer a simple greeting",
      stimulus: { kind: "user", text: "hello" },
      testMode: { provider: { kind: "static", text: "hello" } },
    });

    expect(turn.ok).toBe(true);
    expect(turn.memoryPacket.consulted).toBe(true);
    expect(turn.memoryPacket.empty).toBe(true);

    const event = requireEvent(turn.events.length ? turn.events : await adapter!.ledgerRead({ agent: a.instanceId }), "MemoryConsulted");
    const payload = payloadObject(event);
    expect(payload).toHaveProperty("counts");
    expect(JSON.stringify(payload).toLowerCase()).toContain("query");
  });

  it("keeps memory private per agent instance", async () => {
    const a = agent("mem-owner");
    const b = agent("mem-other");
    const token = "private-isolation-token-6f7a";

    await adapter!.memoryIngest({
      agent: a,
      artifact: {
        kind: "doc",
        uri: "mem://isolation",
        title: "Isolation Note",
        text: `# Isolation\nOnly the owning agent may recall ${token}.`,
      },
    });

    const ownerContext = await adapter!.memoryContext({ agent: a, task: `recall ${token}` });
    const otherContext = await adapter!.memoryContext({ agent: b, task: `recall ${token}` });

    expect(packetText(ownerContext)).toContain(token);
    expect(packetText(otherContext)).not.toContain(token);
  });

  it("internalizes artifacts as summary, chunks, facts, graph, vectors, and provenance", async () => {
    const a = agent("artifact-agent");
    const artifact = {
      kind: "spec",
      uri: "mem://artifact-contract",
      title: "Artifact Contract",
      text: [
        "# Runtime Artifact Contract",
        "Agents preserve whole-artifact summaries.",
        "## Memory Envelope",
        "Every chunk is decomposed into facts, graph triples, and vectors.",
        "## Provenance",
        "Every memory cell records the ledger origin tick and artifact hash.",
      ].join("\n"),
    };

    const result = await adapter!.memoryIngest({ agent: a, artifact });
    expect(result.created).toBe(true);
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.sourceHash.length).toBeGreaterThan(0);
    expect(result.chunkCount).toBeGreaterThanOrEqual(2);
    expect(result.factCount).toBeGreaterThanOrEqual(1);
    expect(result.tripleCount).toBeGreaterThanOrEqual(1);
    expect(result.vectorCount).toBeGreaterThanOrEqual(1);
    requireEvent(result.events, "ArtifactObserved", artifact.uri);

    const inspect = await adapter!.memoryInspect({ agent: a });
    expect(inspect.counts.summaries).toBeGreaterThanOrEqual(1);
    expect(inspect.counts.chunks).toBeGreaterThanOrEqual(2);
    expect(inspect.counts.facts).toBeGreaterThanOrEqual(1);
    expect(inspect.counts.triples).toBeGreaterThanOrEqual(1);
    expect(inspect.counts.vectors).toBeGreaterThanOrEqual(1);
    expect(inspectText(inspect)).toContain(result.sourceHash.toLowerCase());
    expectOriginTicks(inspect);
  });

  it("does not duplicate memory or ledger events when the same artifact is ingested unchanged", async () => {
    const a = agent("idempotent-agent");
    const artifact = {
      kind: "doc",
      uri: "mem://idempotent",
      title: "Idempotent Artifact",
      text: "# Same\nThis artifact is intentionally unchanged.",
    };

    await adapter!.memoryIngest({ agent: a, artifact });
    const afterFirst = await adapter!.memoryInspect({ agent: a });
    const healthAfterFirst = await adapter!.health();

    const second = await adapter!.memoryIngest({ agent: a, artifact });
    const afterSecond = await adapter!.memoryInspect({ agent: a });
    const healthAfterSecond = await adapter!.health();

    expect(second.created).toBe(false);
    expect(totalMemoryCells(afterSecond)).toBe(totalMemoryCells(afterFirst));
    expect(healthAfterSecond.ledgerHead).toBe(healthAfterFirst.ledgerHead);
  });

  it("internalizes failed and successful implementation experiences", async () => {
    const a = agent("experience-agent");

    await adapter!.recordExperience({
      agent: a,
      kind: "check",
      subject: "bad.ag",
      ok: false,
      text: "TypeError: a Credence must be gated before use.",
    });
    await adapter!.recordExperience({
      agent: a,
      kind: "test",
      subject: "good.ag",
      ok: true,
      text: "Pattern: decide a Credence, endorse the subject, then use the endorsement at the sink.",
    });

    const context = await adapter!.memoryContext({ agent: a, task: "how should I use a Credence at a sink?" });
    const text = packetText(context);
    expect(text).toContain("typeerror");
    expect(text).toContain("pattern");
    expect(text).toContain("endorse");
  });

  it("ranks explicit user correction over inferred lessons", async () => {
    const a = agent("correction-agent");

    await adapter!.recordExperience({
      agent: a,
      kind: "run",
      subject: "gate-style",
      ok: true,
      text: "Inferred lesson: use a local fallback action when a gate is cold.",
    });
    await adapter!.recordUserCorrection({
      agent: a,
      subject: "gate-style",
      supersedes: "local fallback action",
      text: "User correction: cold consequential gates must use a principal prefix or abstain; local fallback is not a substitute for labels.",
    });

    const context = await adapter!.memoryContext({ agent: a, task: "cold consequential gate behavior" });
    const text = packetText(context);
    const correctionIndex = text.indexOf("user correction");
    const inferredIndex = text.indexOf("inferred lesson");
    expect(correctionIndex).toBeGreaterThanOrEqual(0);
    expect(inferredIndex).toBeGreaterThanOrEqual(0);
    expect(correctionIndex).toBeLessThan(inferredIndex);
  });

  it("does not let memory recall launder trust into a consequential sink", async () => {
    const result = await adapter!.check({
      source: `
        action Publish(text body);
        agent A grants { perform Publish } {
          on awake {
            mem note <- "remembered draft";
            text recalled = note -> "draft";
            perform Publish(recalled);
          }
        }
        spawn A a; awake a;
      `,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.category === "TaintViolation")).toBe(true);
  });
});
