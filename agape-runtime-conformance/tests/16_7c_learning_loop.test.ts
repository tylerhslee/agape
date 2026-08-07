import { beforeEach, describe, expect, it } from "vitest";
import { loadAdapter } from "../src/loader.js";
import { packetText, requireEvent } from "../src/assertions.js";
import type { AgentRef } from "../src/adapter.js";

const adapter = await loadAdapter();
const suite = adapter ? describe : describe.skip;

function agent(instanceId: string): AgentRef {
  return { template: "ImplementationAgent", instanceId };
}

suite("SPEC 16.7c longitudinal learning loop", () => {
  beforeEach(async () => {
    await adapter!.reset();
  });

  it("learns from a failed implementation attempt and applies the lesson on a later turn", async () => {
    const a = agent("learns-from-failure");
    const badSource = `
      enum Verdict { Publish, Revise }
      action PublishMemo(text body);
      agent Drafter grants { perform PublishMemo } {
        on awake {
          text body = self <- "draft a memo";
          Credence<Verdict> c = self <- f"is this memo ready: {body}";
          Decision<Verdict> d = decide c by confidence 0.9;
          if (d.committed == Publish) { perform PublishMemo(body); }
        }
      }
      spawn Drafter d; awake d;
    `;

    const loop = await adapter!.implementationLearningLoop({
      agent: a,
      task: "Implement an Agape drafter that publishes a model-written memo only after a valid endorsement.",
      firstCandidateSource: badSource,
      expectedFirstFailure: "TaintViolation",
      revisionRequest: "Revise the implementation using the learned failure lesson. The memo body must reach PublishMemo only through an Endorsement in a committed arm.",
      revisedMustContain: ["Decision<Verdict>", "endorse body by d", "Publish as e", "perform PublishMemo(e)"],
      revisedMustNotContain: ["perform PublishMemo(body)"],
    });

    expect(loop.firstTurn.memoryPacket.consulted).toBe(true);
    requireEvent(loop.firstTurn.events, "MemoryConsulted");
    expect(loop.firstSource).toContain("perform PublishMemo(body)");
    expect(loop.firstCheck.ok).toBe(false);
    const taintDiagnostic = loop.firstCheck.diagnostics.find((d) => d.category === "TaintViolation");
    expect(taintDiagnostic).toBeTruthy();
    const diagnosticMessage = String(taintDiagnostic?.message || "").toLowerCase();
    expect(diagnosticMessage).toContain("publishmemo");
    expect(diagnosticMessage).toContain("body");
    expect(diagnosticMessage).toContain("endorse");

    expect(Number.isInteger(loop.failureExperience.originTick)).toBe(true);
    const failureExperience = JSON.stringify(loop.failureExperience).toLowerCase();
    expect(loop.failureExperience.raw.toLowerCase()).toContain("taintviolation");
    expect(loop.failureExperience.summary.toLowerCase()).toContain("endorse");
    expect(loop.failureExperience.facts.length).toBeGreaterThanOrEqual(2);
    expect(loop.failureExperience.triples.length).toBeGreaterThanOrEqual(1);
    expect(loop.failureExperience.vectorTexts.length).toBeGreaterThanOrEqual(1);
    expect(failureExperience).toContain("publishmemo");
    expect(failureExperience).toContain("body");
    expect(failureExperience).toContain("endorsement");

    const failureMemory = packetText(loop.failureMemory);
    expect(failureMemory).toContain("taintviolation");
    expect(failureMemory).toContain("endorsement");

    expect(loop.secondTurn.memoryPacket.consulted).toBe(true);
    requireEvent(loop.secondTurn.events, "MemoryConsulted");
    const secondPacket = packetText(loop.secondTurn.memoryPacket);
    expect(secondPacket).toContain("taintviolation");
    expect(secondPacket).toContain("endorsement");

    expect(loop.revisedSource).not.toBe(loop.firstSource);
    for (const fragment of ["Decision<Verdict>", "endorse body by d", "Publish as e", "perform PublishMemo(e)"]) {
      expect(loop.revisedSource).toContain(fragment);
    }
    expect(loop.revisedSource).not.toContain("perform PublishMemo(body)");
    expect(loop.revisedCheck.ok).toBe(true);

    expect(Number.isInteger(loop.successExperience.originTick)).toBe(true);
    const successExperience = JSON.stringify(loop.successExperience).toLowerCase();
    expect(loop.successExperience.summary.toLowerCase()).toContain("passed");
    expect(loop.successExperience.facts.length).toBeGreaterThanOrEqual(2);
    expect(loop.successExperience.triples.length).toBeGreaterThanOrEqual(1);
    expect(loop.successExperience.vectorTexts.length).toBeGreaterThanOrEqual(1);
    expect(successExperience).toContain("endorse body by d");
    expect(successExperience).toContain("perform publishmemo(e)");

    const finalMemory = packetText(loop.finalMemory);
    expect(finalMemory).toContain("failed");
    expect(finalMemory).toContain("passed");
    expect(finalMemory).toContain("publishmemo");
  });

  it("persists a successful pattern after the correction so future turns retrieve it", async () => {
    const a = agent("learns-success-pattern");
    const badSource = `
      enum Verdict { Publish, Revise }
      action PublishMemo(text body);
      agent Drafter grants { perform PublishMemo } {
        on awake {
          text body = self <- "draft a memo";
          Credence<Verdict> c = self <- f"is this memo ready: {body}";
          Decision<Verdict> d = decide c by confidence 0.9;
          if (d.committed == Publish) { perform PublishMemo(body); }
        }
      }
      spawn Drafter d; awake d;
    `;

    await adapter!.implementationLearningLoop({
      agent: a,
      task: "Implement an Agape drafter with proper endorsement before publish.",
      firstCandidateSource: badSource,
      expectedFirstFailure: "TaintViolation",
      revisionRequest: "Fix the taint failure by endorsing the exact memo body before publishing.",
      revisedMustContain: ["endorse body by d", "perform PublishMemo(e)"],
      revisedMustNotContain: ["perform PublishMemo(body)"],
    });

    const laterMemory = await adapter!.memoryContext({
      agent: a,
      task: "Write another publishing workflow. Use prior implementation experience.",
    });
    const later = await adapter!.agentRespond({
      agent: a,
      task: "Write another publishing workflow. Use prior implementation experience.",
      stimulus: { kind: "user", text: "make another publishing agent" },
      testMode: {
        requireMemoryUse: true,
        expectedRetrievedPatterns: ["endorse body by d", "perform PublishMemo(e)"],
      },
    });

    expect(later.ok).toBe(true);
    expect(later.memoryPacket.consulted).toBe(false);
    const packet = packetText(laterMemory);
    expect(packet).toContain("endorse");
    expect(packet).toContain("publishmemo");
    expect(packet).not.toContain("perform publishmemo(body)");
  });
});
