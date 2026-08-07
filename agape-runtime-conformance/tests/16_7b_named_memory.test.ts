import { beforeEach, describe, expect, it } from "vitest";
import { loadAdapter } from "../src/loader.js";
import { eventsOf, payloadObject } from "../src/assertions.js";
import type {
  NamedMemoryDescriptor,
  NamedMemoryScenarioResult,
  NamedMemoryStepResult,
  RuntimeIdentityContext,
} from "../src/adapter.js";

const adapter = await loadAdapter();
const suite = adapter ? describe : describe.skip;

const projectAlice: RuntimeIdentityContext = {
  projectSubject: "project-alpha",
  sessionLineageId: "lineage-alpha",
  sessionId: "session-a1",
  conversationId: "conversation-a",
  user: { issuer: "test-issuer", subject: "alice", verified: true },
};

function descriptor(
  overrides: Partial<NamedMemoryDescriptor> = {},
): NamedMemoryDescriptor {
  return {
    name: "notes",
    valueType: "MemoryNote",
    modality: "opaque",
    scopes: ["project"],
    retention: "session",
    ...overrides,
  };
}

function step(result: NamedMemoryScenarioResult, id: string): NamedMemoryStepResult {
  const found = result.steps.find((candidate) => candidate.id === id);
  expect(found, `missing named-memory step ${id}`).toBeTruthy();
  return found!;
}

suite("SPEC 10 / 16.5 / 16.7 qualified named memory", () => {
  beforeEach(async () => {
    await adapter!.reset();
  });

  it("returns an exact typed empty array and a truthful empty consultation receipt", async () => {
    const before = await adapter!.oracleStats();
    const result = await adapter!.namedMemoryScenario({
      name: "typed-empty-recall",
      driver: { kind: "local" },
      descriptor: descriptor(),
      identities: { alice: projectAlice },
      steps: [{ id: "recall-empty", operation: "recall", identity: "alice", query: "missing" }],
    });
    const after = await adapter!.oracleStats();

    expect(result.ok).toBe(true);
    const recall = step(result, "recall-empty");
    expect(recall.ok).toBe(true);
    expect(recall.resultType).toBe("MemoryNote[]");
    expect(recall.values).toEqual([]);
    expect(recall.receipt?.etype).toBe("MemoryConsulted");
    expect(payloadObject(recall.receipt!)).toMatchObject({
      hit_ids: [],
      scores: [],
      origins: [],
    });
    expect(after.providerCalls).toBe(before.providerCalls);
  });

  it("preserves separate origins for equal episodic writes", async () => {
    const value = { text: "same episode", weight: 7 };
    const result = await adapter!.namedMemoryScenario({
      name: "episodic-equal-values",
      driver: { kind: "local" },
      descriptor: descriptor({ modality: "episodic" }),
      identities: { alice: projectAlice },
      steps: [
        { id: "store-one", operation: "store", identity: "alice", value },
        { id: "store-two", operation: "store", identity: "alice", value },
        { id: "recall-both", operation: "recall", identity: "alice", query: "same episode" },
      ],
      testMode: {
        recallCandidates: {
          "recall-both": [
            { storeStepId: "store-two", cellId: "cell-b", score: 0.8 },
            { storeStepId: "store-one", cellId: "cell-a", score: 0.8 },
          ],
        },
      },
    });

    const stores = [step(result, "store-one"), step(result, "store-two")];
    expect(stores.every((item) => item.ok)).toBe(true);
    expect(new Set(stores.map((item) => item.operationId)).size).toBe(2);
    expect(eventsOf(result.events, "Internalized")).toHaveLength(2);

    const values = step(result, "recall-both").values!;
    expect(values.map((item) => item.value)).toEqual([value, value]);
    expect(new Set(values.map((item) => item.originRef)).size).toBe(2);
    expect(new Set(values.map((item) => item.cellId)).size).toBe(2);
  });

  it("keeps forget generations local to the authenticated tuple and reopens exactly once", async () => {
    const bob = {
      ...projectAlice,
      conversationId: "conversation-b",
      user: { issuer: "test-issuer", subject: "bob", verified: true as const },
    };
    const result = await adapter!.namedMemoryScenario({
      name: "tuple-generations",
      driver: { kind: "local" },
      descriptor: descriptor({ scopes: ["project", "user"] }),
      identities: { alice: projectAlice, bob },
      steps: [
        { id: "store-alice-g0", operation: "store", identity: "alice", value: { text: "alice g0" } },
        { id: "store-bob-g0", operation: "store", identity: "bob", value: { text: "bob g0" } },
        { id: "forget-alice", operation: "forget", identity: "alice" },
        { id: "recall-alice-empty", operation: "recall", identity: "alice", query: "g0" },
        { id: "recall-bob", operation: "recall", identity: "bob", query: "g0" },
        { id: "forget-alice-again", operation: "forget", identity: "alice" },
        { id: "store-alice-g1", operation: "store", identity: "alice", value: { text: "alice g1" } },
        { id: "recall-alice-g1", operation: "recall", identity: "alice", query: "g1" },
      ],
    });

    expect(step(result, "store-alice-g0").generation).toBe(0);
    expect(step(result, "forget-alice").generation).toBe(0);
    expect(step(result, "recall-alice-empty").values).toEqual([]);
    expect(step(result, "recall-bob").values?.map((item) => item.value)).toEqual([{ text: "bob g0" }]);
    expect(step(result, "forget-alice-again").generation).toBe(0);
    expect(payloadObject(step(result, "forget-alice-again").receipt!)).toMatchObject({
      already_forgotten: true,
    });
    expect(step(result, "store-alice-g1").generation).toBe(1);
    expect(step(result, "recall-alice-g1").values?.map((item) => item.value)).toEqual([
      { text: "alice g1" },
    ]);
  });

  it("isolates full project/user tuples and never calls the driver without kappa.user", async () => {
    const identities: Record<string, RuntimeIdentityContext> = {
      p1alice: projectAlice,
      p1bob: {
        ...projectAlice,
        user: { issuer: "test-issuer", subject: "bob", verified: true },
      },
      p2alice: {
        ...projectAlice,
        projectSubject: "project-beta",
        user: { issuer: "test-issuer", subject: "alice", verified: true },
      },
      missingUser: {
        ...projectAlice,
        conversationId: "conversation-missing-user",
        user: undefined,
      },
    };
    const result = await adapter!.namedMemoryScenario({
      name: "authenticated-tuple-isolation",
      driver: { kind: "local" },
      descriptor: descriptor({ scopes: ["project", "user"] }),
      identities,
      steps: [
        { id: "store-p1-alice", operation: "store", identity: "p1alice", value: { text: "p1 alice" } },
        { id: "store-p1-bob", operation: "store", identity: "p1bob", value: { text: "p1 bob" } },
        { id: "store-p2-alice", operation: "store", identity: "p2alice", value: { text: "p2 alice" } },
        { id: "recall-p1-alice", operation: "recall", identity: "p1alice", query: "alice" },
        { id: "recall-p1-bob", operation: "recall", identity: "p1bob", query: "bob" },
        { id: "recall-p2-alice", operation: "recall", identity: "p2alice", query: "alice" },
        { id: "recall-missing-user", operation: "recall", identity: "missingUser", query: "anything" },
      ],
    });

    expect(step(result, "recall-p1-alice").values?.map((item) => item.value)).toEqual([{ text: "p1 alice" }]);
    expect(step(result, "recall-p1-bob").values?.map((item) => item.value)).toEqual([{ text: "p1 bob" }]);
    expect(step(result, "recall-p2-alice").values?.map((item) => item.value)).toEqual([{ text: "p2 alice" }]);

    const denied = step(result, "recall-missing-user");
    expect(denied.ok).toBe(false);
    expect(denied.error?.category).toBe("AgentCrashed");
    expect(result.events.some((event) => event.etype === "AgentCrashed")).toBe(true);
    expect(result.trace.some((entry) => entry.kind === "driver" && entry.stepId === denied.id)).toBe(false);
    expect(eventsOf(result.events, "MemoryConsulted")).toHaveLength(3);
  });

  it("orders by descending score then bytewise cell id and applies top_k last", async () => {
    const result = await adapter!.namedMemoryScenario({
      name: "deterministic-ranking",
      driver: { kind: "local", topK: 3 },
      descriptor: descriptor({ modality: "semantic" }),
      identities: { alice: projectAlice },
      steps: [
        { id: "store-a", operation: "store", identity: "alice", value: { text: "A" } },
        { id: "store-b", operation: "store", identity: "alice", value: { text: "B" } },
        { id: "store-c", operation: "store", identity: "alice", value: { text: "C" } },
        { id: "store-d", operation: "store", identity: "alice", value: { text: "D" } },
        { id: "rank", operation: "recall", identity: "alice", query: "all" },
      ],
      testMode: {
        recallCandidates: {
          rank: [
            { storeStepId: "store-a", cellId: "cell-m", score: 0.7 },
            { storeStepId: "store-b", cellId: "cell-z", score: 0.9 },
            { storeStepId: "store-c", cellId: "cell-a", score: 0.9 },
            { storeStepId: "store-d", cellId: "cell-q", score: 0.99 },
          ],
        },
      },
    });

    const rank = step(result, "rank");
    expect(rank.values?.map((item) => item.value)).toEqual([
      { text: "D" },
      { text: "C" },
      { text: "B" },
    ]);
    expect(rank.values?.map((item) => item.cellId)).toEqual(["cell-q", "cell-a", "cell-z"]);
    expect(payloadObject(rank.receipt!)).toMatchObject({
      cap: 3,
      hit_ids: ["cell-q", "cell-a", "cell-z"],
      scores: [0.99, 0.9, 0.9],
    });
  });

  it("rejects durable memory on the local driver during preflight", async () => {
    const result = await adapter!.namedMemoryScenario({
      name: "local-durable-preflight",
      driver: { kind: "local" },
      descriptor: descriptor({ retention: "durable" }),
      identities: { alice: projectAlice },
      steps: [{ id: "must-not-run", operation: "recall", identity: "alice", query: "x" }],
    });

    expect(result.ok).toBe(false);
    expect(result.preflightError?.category).toBe("ConfigError");
    expect(result.steps).toEqual([]);
    expect(result.trace).toEqual([]);
    expect(result.events.some((event) =>
      ["Internalized", "MemoryConsulted", "Forgotten"].includes(event.etype))).toBe(false);
  });

  it("recalls exact durable Markdown values after close and authenticated resume", async () => {
    const resumed = { ...projectAlice, sessionId: "session-a2" };
    const value = { text: "durable note", nested: { count: 2 } };
    const result = await adapter!.namedMemoryScenario({
      name: "markdown-authenticated-resume",
      driver: { kind: "markdown" },
      descriptor: descriptor({ retention: "durable", scopes: ["project", "user"] }),
      identities: { initial: projectAlice, resumed },
      steps: [
        { id: "store", operation: "store", identity: "initial", value },
        { id: "close", operation: "close" },
        { id: "resume", operation: "resume", identity: "resumed", snapshotFrom: "close" },
        { id: "recall", operation: "recall", identity: "resumed", query: "durable" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(step(result, "close").snapshot).toBeTruthy();
    expect(step(result, "resume").ok).toBe(true);
    expect(step(result, "recall").values?.map((item) => item.value)).toEqual([value]);
    expect(step(result, "recall").values?.[0]?.generation).toBe(0);
  });

  it("rejects a resume token that is not bound to the authenticated lineage", async () => {
    const resumed = {
      ...projectAlice,
      sessionLineageId: "different-lineage",
      sessionId: "session-other",
    };
    const result = await adapter!.namedMemoryScenario({
      name: "markdown-wrong-resume",
      driver: { kind: "markdown" },
      descriptor: descriptor({ retention: "durable" }),
      identities: { initial: projectAlice, resumed },
      steps: [
        { id: "store", operation: "store", identity: "initial", value: { text: "secret" } },
        { id: "close", operation: "close" },
        {
          id: "resume-wrong-lineage",
          operation: "resume",
          identity: "resumed",
          snapshotFrom: "close",
          tamper: "session-lineage",
        },
      ],
    });

    const resume = step(result, "resume-wrong-lineage");
    expect(resume.ok).toBe(false);
    expect(resume.error?.category).toBeTruthy();
    expect(result.events.some((event) => event.etype === "MemoryConsulted")).toBe(false);
    expect(result.trace.some((entry) =>
      entry.kind === "driver" && entry.stepId === resume.id && entry.action === "recall")).toBe(false);
  });

  it("reconciles a lost finalize acknowledgement after the ledger commit", async () => {
    const result = await adapter!.namedMemoryScenario({
      name: "lost-finalize-ack",
      driver: { kind: "markdown" },
      descriptor: descriptor({ retention: "durable" }),
      identities: { alice: projectAlice },
      steps: [
        { id: "store-lost-ack", operation: "store", identity: "alice", value: { text: "committed" } },
        { id: "recall-after-reconcile", operation: "recall", identity: "alice", query: "committed" },
      ],
      testMode: { loseFinalizeAckAfterLedger: ["store-lost-ack"] },
    });

    expect(step(result, "store-lost-ack").ok).toBe(true);
    expect(eventsOf(result.events, "Internalized")).toHaveLength(1);
    expect(step(result, "recall-after-reconcile").values?.map((item) => item.value)).toEqual([
      { text: "committed" },
    ]);

    const operationId = step(result, "store-lost-ack").operationId;
    const prepare = result.trace.find((entry) =>
      entry.operationId === operationId && entry.kind === "driver" && entry.action === "prepare");
    const ledger = result.trace.find((entry) =>
      entry.operationId === operationId && entry.kind === "ledger" && entry.etype === "Internalized");
    const finalizes = result.trace.filter((entry) =>
      entry.operationId === operationId && entry.kind === "driver" && entry.action === "finalize");
    const status = result.trace.find((entry) =>
      entry.operationId === operationId && entry.kind === "driver" && entry.action === "status");
    const recall = result.trace.find((entry) =>
      entry.stepId === "recall-after-reconcile" && entry.kind === "driver" && entry.action === "recall");

    expect(prepare?.sequence).toBeLessThan(ledger!.sequence);
    expect(ledger?.sequence).toBeLessThan(finalizes[0]!.sequence);
    expect(finalizes.length).toBeGreaterThanOrEqual(1);
    expect(finalizes[0]!.sequence).toBeLessThan(status!.sequence);
    expect(status!.sequence).toBeLessThan(recall!.sequence);
    if (finalizes[1]) {
      expect(status!.sequence).toBeLessThan(finalizes[1].sequence);
      expect(finalizes[1].sequence).toBeLessThan(recall!.sequence);
    }
  });

  it("replays journaled recall with zero provider/driver calls and no durable mutation", async () => {
    const live = await adapter!.namedMemoryScenario({
      name: "durable-recorded-replay",
      driver: { kind: "markdown" },
      descriptor: descriptor({ retention: "durable" }),
      identities: { alice: projectAlice },
      steps: [
        { id: "store", operation: "store", identity: "alice", value: { text: "journal me" } },
        { id: "recall", operation: "recall", identity: "alice", query: "journal" },
      ],
      record: true,
    });
    expect(live.recording).toBeTruthy();

    const expectedHeadHash = await adapter!.canonicalHash(live.events);
    const before = await adapter!.oracleStats();
    expect(Number.isInteger(before.memoryDriverCalls)).toBe(true);
    expect(Number.isInteger(before.memoryMutationCalls)).toBe(true);

    const replay = await adapter!.replay(live.recording);
    const after = await adapter!.oracleStats();

    expect(replay.ok).toBe(true);
    expect(replay.headHash).toBe(expectedHeadHash);
    expect(after.providerCalls).toBe(before.providerCalls);
    expect(after.memoryDriverCalls).toBe(before.memoryDriverCalls);
    expect(after.memoryMutationCalls).toBe(before.memoryMutationCalls);
  });
});
