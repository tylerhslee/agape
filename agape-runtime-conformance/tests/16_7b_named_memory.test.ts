import { beforeEach, describe, expect, it } from "vitest";
import { loadAdapter } from "../src/loader.js";
import { eventsOf, payloadObject } from "../src/assertions.js";
import type {
  NamedMemoryDescriptor, NamedMemoryInvocationResult, NamedMemoryProgram,
  NamedMemorySession, NamedMemorySessionStartResult, PersistedSchema,
  RuntimeIdentityContext,
} from "../src/adapter.js";

const adapter = await loadAdapter();
const suite = adapter ? describe : describe.skip;

const schema: PersistedSchema = {
  kind: "struct", name: "MemoryNote",
  fields: {
    text: { kind: "scalar", scalar: "text" },
    weight: { kind: "scalar", scalar: "int" },
  },
};
const alice: RuntimeIdentityContext = {
  projectSubject: "project-private-a7",
  sessionLineageId: "lineage-private-a6",
  sessionId: "session-a1",
  conversationId: "conversation-a",
  user: { issuer: "issuer-private-3", subject: "alice-private-8", verified: true },
};
const note = (text: string, weight: number) => ({ text, weight });
const desc = (x: Partial<NamedMemoryDescriptor> = {}): NamedMemoryDescriptor => ({
  name: "notes", schema, modality: "opaque", scopes: ["project"], retention: "session", ...x,
});
const prog = (x: Partial<NamedMemoryProgram> & { descriptor?: NamedMemoryDescriptor } = {}): NamedMemoryProgram => ({
  programId: "program-memory-v1", manifestId: "manifest-memory-v1",
  agentTemplate: "MemoryAgent", agentAliases: ["owner"], descriptor: desc(), ...x,
});
function session(r: NamedMemorySessionStartResult): NamedMemorySession {
  expect(r.ok).toBe(true); expect(r.session).toBeTruthy(); return r.session!;
}
function op(r: NamedMemoryInvocationResult, id: string) {
  const found = r.operations.find((x) => x.id === id);
  expect(found, `missing operation ${id}`).toBeTruthy(); return found!;
}
function receiptHashes(receipt: unknown, s: NamedMemorySession) {
  const p = payloadObject(receipt as any);
  expect(p.descriptor_hash).toBe(s.descriptorHash);
  expect(p.schema_hash).toBe(s.schemaHash);
  expect(typeof p.scope_hash).toBe("string");
}
function publicReceiptsHide(events: unknown[], secrets: unknown[]) {
  const text = JSON.stringify((events as Array<{ etype?: string }>).filter((e) =>
    ["Internalized", "MemoryConsulted", "Forgotten"].includes(String(e.etype))));
  for (const secret of secrets) expect(text).not.toContain(String(secret));
}
function bytewiseCompare(left: string, right: string): number {
  const l = new TextEncoder().encode(left);
  const r = new TextEncoder().encode(right);
  const length = Math.min(l.length, r.length);
  for (let i = 0; i < length; i += 1) {
    if (l[i] !== r[i]) return l[i]! - r[i]!;
  }
  return l.length - r.length;
}
function canonicalCellIds(values: NonNullable<ReturnType<typeof op>["values"]>): string[] {
  const ids = values.map((value) => value.cellId);
  expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}
async function invoke(s: NamedMemorySession, invocationId: string, operations: any[], alias = "owner") {
  return adapter!.invokeNamedMemory({
    sessionHandle: s.sessionHandle,
    agentInstanceId: s.agents[alias]!.stableInstanceId,
    invocationId, operations,
  });
}

suite("SPEC 10 / 16.1a / 16.5 / 16.7 qualified named memory", () => {
  beforeEach(async () => { await adapter!.reset(); });

  it("returns an exact typed empty array without a provider call", async () => {
    const s = session(await adapter!.openNamedMemorySession({
      name: "typed-empty", driverNamespace: "typed-empty", driver: { kind: "local" },
      program: prog(), identity: alice, identityCapabilities: ["project"],
    }));
    const before = await adapter!.oracleStats();
    const r = await invoke(s, "invoke-empty", [
      { id: "empty", site: "handler:recall", operation: "recall", query: "query-private-19" },
    ]);
    const after = await adapter!.oracleStats();
    expect(op(r, "empty").resultType).toBe("MemoryNote[]");
    expect(op(r, "empty").values).toEqual([]);
    expect(payloadObject(op(r, "empty").receipt!)).toMatchObject({ hit_ids: [], scores: [], origins: [] });
    receiptHashes(op(r, "empty").receipt, s);
    expect(after.providerCalls).toBe(before.providerCalls);
    publicReceiptsHide(r.events, [alice.projectSubject, "query-private-19"]);
  });

  it("preserves separate origins for equal episodic evaluations", async () => {
    const value = note("equal-private-55", 7);
    const s = session(await adapter!.openNamedMemorySession({
      name: "episodic", driverNamespace: "episodic", driver: { kind: "local" },
      program: prog({ descriptor: desc({ modality: "episodic" }) }),
      identity: alice, identityCapabilities: ["project"],
      testMode: { recallCandidates: { recall: [
        { storeOperationId: "two", score: 0.8 },
        { storeOperationId: "one", score: 0.8 },
      ] } },
    }));
    const r = await invoke(s, "invoke-two-evaluations", [
      { id: "one", site: "same-store-site", operation: "store", value },
      { id: "two", site: "same-store-site", operation: "store", value },
      { id: "recall", site: "recall-site", operation: "recall", query: "equal" },
    ]);
    expect(eventsOf(r.events, "Internalized")).toHaveLength(2);
    expect(new Set([op(r, "one").operationId, op(r, "two").operationId]).size).toBe(2);
    const values = op(r, "recall").values!;
    expect(values.map((x) => x.value)).toEqual([value, value]);
    expect(new Set(values.map((x) => x.originRef)).size).toBe(2);
    const ids = canonicalCellIds(values);
    expect(ids).toEqual([...ids].sort(bytewiseCompare));
    for (const entry of values) {
      expect(entry.schema).toEqual(schema);
      expect(entry.schemaHash).toBe(s.schemaHash);
      expect(entry.descriptorHash).toBe(s.descriptorHash);
      expect(entry.taint).toBe("raw");
    }
    for (const e of eventsOf(r.events, "Internalized")) {
      receiptHashes(e, s); expect(typeof payloadObject(e).value_hash).toBe("string");
    }
    publicReceiptsHide(r.events, [value.text, alice.projectSubject, alice.user!.subject, alice.user!.issuer]);
  });

  it("keeps forget generation local and reopens exactly once", async () => {
    const s = session(await adapter!.openNamedMemorySession({
      name: "generation", driverNamespace: "generation", driver: { kind: "local" },
      program: prog({ descriptor: desc({ scopes: ["project", "user"] }) }),
      identity: alice, identityCapabilities: ["project", "user"],
    }));
    const r = await invoke(s, "invoke-generation", [
      { id: "store0", site: "store", operation: "store", value: note("g0", 0) },
      { id: "forget0", site: "forget", operation: "forget" },
      { id: "empty", site: "recall", operation: "recall", query: "g" },
      { id: "forgetAgain", site: "forget", operation: "forget" },
      { id: "store1", site: "store", operation: "store", value: note("g1", 1) },
      { id: "recall1", site: "recall", operation: "recall", query: "g" },
    ]);
    expect(op(r, "store0").generation).toBe(0);
    expect(op(r, "forget0").generation).toBe(0);
    expect(op(r, "empty").values).toEqual([]);
    expect(op(r, "forgetAgain").generation).toBe(0);
    expect(payloadObject(op(r, "forgetAgain").receipt!)).toMatchObject({ already_forgotten: true });
    expect(op(r, "store1").generation).toBe(1);
    expect(op(r, "recall1").values?.map((x) => x.value)).toEqual([note("g1", 1)]);
  });

  it("isolates concrete instances and authenticated user/project tuples", async () => {
    const p = prog({
      agentAliases: ["owner", "peer"],
      descriptor: desc({ scopes: ["project", "user"], retention: "durable" }),
    });
    const first = session(await adapter!.openNamedMemorySession({
      name: "isolation-a", driverNamespace: "isolation-shared", driver: { kind: "markdown" },
      program: p, identity: alice, identityCapabilities: ["project", "user"],
    }));
    expect(first.agents.owner!.stableInstanceId).not.toBe(first.agents.peer!.stableInstanceId);
    await invoke(first, "store-owner", [
      { id: "store", site: "store", operation: "store", value: note("owner-private", 1) },
    ]);
    expect(op(await invoke(first, "recall-peer", [
      { id: "peer", site: "recall", operation: "recall", query: "owner" },
    ], "peer"), "peer").values).toEqual([]);

    const closed = await adapter!.closeNamedMemorySession({ sessionHandle: first.sessionHandle });
    const bob = { ...alice, sessionId: "session-a2", conversationId: "conversation-b",
      user: { issuer: alice.user!.issuer, subject: "bob-private", verified: true as const } };
    const second = session(await adapter!.resumeNamedMemorySession({
      name: "isolation-b", driverNamespace: "isolation-shared", driver: { kind: "markdown" },
      program: p, identity: bob, identityCapabilities: ["project", "user"], snapshot: closed.snapshot,
    }));
    expect(second.agents.owner!.stableInstanceId).toBe(first.agents.owner!.stableInstanceId);
    expect(op(await invoke(second, "recall-bob", [
      { id: "bob", site: "recall", operation: "recall", query: "owner" },
    ]), "bob").values).toEqual([]);

    const beta = { ...alice, projectSubject: "project-private-beta", sessionLineageId: "lineage-beta",
      sessionId: "session-beta", conversationId: "conversation-beta" };
    const third = session(await adapter!.openNamedMemorySession({
      name: "isolation-beta", driverNamespace: "isolation-shared", driver: { kind: "markdown" },
      program: p, identity: beta, identityCapabilities: ["project", "user"],
    }));
    expect(op(await invoke(third, "recall-beta", [
      { id: "beta", site: "recall", operation: "recall", query: "owner" },
    ]), "beta").values).toEqual([]);
  });

  it("records missing-user crash with no memory seam access", async () => {
    const s = session(await adapter!.openNamedMemorySession({
      name: "missing-user", driverNamespace: "missing-user", driver: { kind: "local" },
      program: prog({ descriptor: desc({ scopes: ["project", "user"] }) }),
      identity: { ...alice, user: undefined }, identityCapabilities: ["project", "user"],
    }));
    const r = await invoke(s, "invoke-missing-user", [
      { id: "denied", site: "recall", operation: "recall", query: "anything" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.fault).toMatchObject({ code: "MissingScopeSubject", scope: "user" });
    expect(eventsOf(r.events, "AgentCrashed")).toHaveLength(1);
    expect(eventsOf(r.events, "MemoryConsulted")).toHaveLength(0);
    expect(r.trace).toEqual([]);
  });

  it("sorts score descending then id bytewise before top_k", async () => {
    const s = session(await adapter!.openNamedMemorySession({
      name: "ranking", driverNamespace: "ranking", driver: { kind: "local", topK: 4 },
      program: prog({ descriptor: desc({ modality: "semantic" }) }),
      identity: alice, identityCapabilities: ["project"],
      testMode: { recallCandidates: {
        discover: ["a", "b", "c", "d"].map((storeOperationId) => ({ storeOperationId, score: 1 })),
        rank: [
          { storeOperationId: "a", score: 0.7 },
          { storeOperationId: "b", score: 0.9 },
          { storeOperationId: "c", score: 0.9 },
          { storeOperationId: "d", score: 0.99 },
        ],
      } },
    }));
    const r = await invoke(s, "invoke-ranking", [
      ...["A", "B", "C", "D"].map((text, i) => ({
        id: text.toLowerCase(), site: "store-" + text, operation: "store", value: note(text, i),
      })),
      { id: "discover", site: "discover", operation: "recall", query: "all" },
      { id: "rank", site: "rank", operation: "recall", query: "all", cap: 3 },
    ]);
    const discovered = op(r, "discover").values!;
    const discoveredIds = canonicalCellIds(discovered);
    expect(discoveredIds).toEqual([...discoveredIds].sort(bytewiseCompare));
    const idByText = new Map(discovered.map((entry) => [(entry.value as { text: string }).text, entry.cellId]));
    expect([...idByText.keys()].sort()).toEqual(["A", "B", "C", "D"]);
    const tieIds = [idByText.get("B")!, idByText.get("C")!].sort(bytewiseCompare);
    const expectedIds = [idByText.get("D")!, ...tieIds];
    const ranked = op(r, "rank").values!;
    expect(canonicalCellIds(ranked)).toEqual(expectedIds);
    expect(ranked.map((x) => x.value)).toEqual(expectedIds.map((id) =>
      discovered.find((entry) => entry.cellId === id)!.value));
    expect(payloadObject(op(r, "rank").receipt!)).toMatchObject({
      cap: 3, hit_ids: expectedIds, scores: [0.99, 0.9, 0.9],
    });
  });

  it("rejects local durable memory during preflight", async () => {
    const before = await adapter!.oracleStats();
    const r = await adapter!.openNamedMemorySession({
      name: "local-durable", driverNamespace: "local-durable", driver: { kind: "local" },
      program: prog({ descriptor: desc({ retention: "durable" }) }),
      identity: alice, identityCapabilities: ["project"],
    });
    const after = await adapter!.oracleStats();
    expect(r.ok).toBe(false); expect(r.session).toBeUndefined();
    expect(r.error?.category).toBe("ConfigError");
    expect(after.memoryDriverCalls).toBe(before.memoryDriverCalls);
    expect(await adapter!.ledgerRead()).toEqual([]);
  });

  it("restores exact durable state into a fresh runtime instance", async () => {
    const p = prog({ descriptor: desc({ retention: "durable", scopes: ["project", "user"] }) });
    const first = session(await adapter!.openNamedMemorySession({
      name: "durable-a", driverNamespace: "durable", driver: { kind: "markdown" },
      program: p, identity: alice, identityCapabilities: ["project", "user"],
    }));
    const value = note("durable-private-62", 9);
    await invoke(first, "store-before-close", [
      { id: "store", site: "store", operation: "store", value },
    ]);
    const closed = await adapter!.closeNamedMemorySession({ sessionHandle: first.sessionHandle });
    expect(closed.destroyed).toBe(true); expect(closed.snapshot).toBeTruthy();
    const resumed = session(await adapter!.resumeNamedMemorySession({
      name: "durable-b", driverNamespace: "durable", driver: { kind: "markdown" },
      program: p, identity: { ...alice, sessionId: "session-a2", conversationId: "conversation-resumed" },
      identityCapabilities: ["project", "user"], snapshot: closed.snapshot,
    }));
    expect(resumed.sessionHandle).not.toBe(first.sessionHandle);
    expect(resumed.runtimeInstanceId).not.toBe(first.runtimeInstanceId);
    expect(resumed.agents.owner!.stableInstanceId).toBe(first.agents.owner!.stableInstanceId);
    const r = await invoke(resumed, "recall-after-resume", [
      { id: "recall", site: "recall", operation: "recall", query: "durable" },
    ]);
    expect(op(r, "recall").values?.map((x) => x.value)).toEqual([value]);
    publicReceiptsHide(r.events, [value.text, alice.projectSubject, alice.user!.subject, alice.user!.issuer]);
  });

  it("rejects one session-lineage binding mismatch before driver read", async () => {
    const p = prog({ descriptor: desc({ retention: "durable" }) });
    const first = session(await adapter!.openNamedMemorySession({
      name: "wrong-a", driverNamespace: "wrong", driver: { kind: "markdown" },
      program: p, identity: alice, identityCapabilities: ["project"],
    }));
    const closed = await adapter!.closeNamedMemorySession({ sessionHandle: first.sessionHandle });
    const before = await adapter!.oracleStats();
    const r = await adapter!.resumeNamedMemorySession({
      name: "wrong-b", driverNamespace: "wrong", driver: { kind: "markdown" }, program: p,
      identity: { ...alice, sessionLineageId: "lineage-wrong-only", sessionId: "session-a2" },
      identityCapabilities: ["project"], snapshot: closed.snapshot,
    });
    const after = await adapter!.oracleStats();
    expect(r.ok).toBe(false); expect(r.session).toBeUndefined();
    expect(r.fault).toMatchObject({ code: "SnapshotBindingMismatch", binding: "sessionLineageId" });
    expect(after.memoryDriverCalls).toBe(before.memoryDriverCalls);
  });

  it("normalizes ledger-bound lost-ack reconciliation before later recall", async () => {
    const s = session(await adapter!.openNamedMemorySession({
      name: "lost-ack", driverNamespace: "lost-ack", driver: { kind: "markdown" },
      program: prog({ descriptor: desc({ retention: "durable" }) }),
      identity: alice, identityCapabilities: ["project"],
      testMode: { loseFinalizeAckAfterLedger: ["store"] },
    }));
    const stored = await invoke(s, "invoke-store", [
      { id: "store", site: "store", operation: "store", value: note("committed", 1) },
    ]);
    const recalled = await invoke(s, "invoke-recall", [
      { id: "recall", site: "recall", operation: "recall", query: "committed" },
    ]);
    expect(eventsOf(stored.events, "Internalized")).toHaveLength(1);
    expect(op(recalled, "recall").values?.map((x) => x.value)).toEqual([note("committed", 1)]);
    const operationId = op(stored, "store").operationId;
    const trace = [...stored.trace, ...recalled.trace];
    const phase = (name: string) => trace.find((x) => x.phase === name
      && (name === "recall" || x.operationId === operationId));
    expect(phase("prepare")?.sequence).toBeLessThan(phase("ledger-commit")!.sequence);
    expect(phase("ledger-commit")?.sequence).toBeLessThan(phase("finalize")!.sequence);
    expect(phase("finalize")?.sequence).toBeLessThan(phase("reconcile")!.sequence);
    expect(phase("reconcile")?.sequence).toBeLessThan(phase("recall")!.sequence);
  });

  it("replays exact outputs and mutation acks with zero live seams or mutation", async () => {
    const s = session(await adapter!.openNamedMemorySession({
      name: "replay", driverNamespace: "replay", driver: { kind: "markdown" },
      program: prog({ descriptor: desc({ retention: "durable" }) }),
      identity: alice, identityCapabilities: ["project"], record: true,
    }));
    await invoke(s, "invoke-recorded", [
      { id: "store", site: "store", operation: "store", value: note("replay-private-94", 4) },
      { id: "recall", site: "recall", operation: "recall", query: "replay-query-private-12" },
    ]);
    const closed = await adapter!.closeNamedMemorySession({ sessionHandle: s.sessionHandle });
    expect(closed.recording).toBeTruthy();
    const before = await adapter!.oracleStats();
    expect(Number.isInteger(before.memoryDriverCalls)).toBe(true);
    expect(Number.isInteger(before.memoryMutationCalls)).toBe(true);
    const replay = await adapter!.replay(closed.recording);
    const after = await adapter!.oracleStats();
    expect(replay.headHash).toBe(closed.headHash);
    expect(replay.namedMemory).toEqual({
      invocations: closed.invocations, mutationAcks: closed.mutationAcks,
    });
    expect(after.providerCalls).toBe(before.providerCalls);
    expect(after.memoryDriverCalls).toBe(before.memoryDriverCalls);
    expect(after.memoryMutationCalls).toBe(before.memoryMutationCalls);
    publicReceiptsHide(replay.events, [
      "replay-private-94", "replay-query-private-12",
      alice.projectSubject, alice.user!.subject, alice.user!.issuer,
    ]);
  });
});
