import { describe, expect, it } from "vitest";
import { Ledger } from "../src/runtime.js";
import {
  NamedMemoryCoordinator,
  NamedMemoryScopeError,
  NamedMemorySessionBarrier,
  type NamedMemoryDriverCallKind,
  type NamedMemoryRetrievalIndex,
  type TransactionalNamedMemoryDriver,
} from "../src/named_memory_coordinator.js";
import {
  DurableTransactionalNamedMemoryDriver,
  LocalTransactionalNamedMemoryDriver,
} from "../src/named_memory_local.js";
import {
  decodeExactValue,
  type MemoryRegionKeyInput,
  type ResolvedMemoryDescriptor,
} from "../src/named_memory.js";

const descriptor = (
  retention: "session" | "durable" = "session",
  scopes: readonly ("project" | "user")[] = ["project"],
): ResolvedMemoryDescriptor => ({
  name: "notes",
  schema: { kind: "scalar", name: "text" },
  modality: "episodic",
  scopes,
  retention,
});

const region = (
  overrides: Partial<Omit<MemoryRegionKeyInput, "descriptor">> = {},
): Omit<MemoryRegionKeyInput, "descriptor"> => ({
  projectSubject: "project-private",
  sessionLineageId: "lineage-private",
  sessionId: "session-private",
  stableAgentInstanceId: "agent-instance-v1:" + "a".repeat(64),
  user: { issuer: "issuer-private", subject: "alice-private", verified: true },
  ...overrides,
});

function harness() {
  const ledger = new Ledger(0);
  const calls = { read: 0, mutation: 0 };
  const onDriverCall = (kind: NamedMemoryDriverCallKind) => {
    calls[kind] += 1;
  };
  return { ledger, calls, onDriverCall };
}

function coordinator(input: {
  descriptor?: ResolvedMemoryDescriptor;
  driver?: TransactionalNamedMemoryDriver;
  region?: Omit<MemoryRegionKeyInput, "descriptor">;
  capabilities?: readonly ("project" | "user")[];
  ledger: Ledger;
  onDriverCall?: (kind: NamedMemoryDriverCallKind) => void;
  maxRecallCap?: number;
  retrievalIndex?: NamedMemoryRetrievalIndex;
  barrier?: NamedMemorySessionBarrier;
}) {
  const resolvedRegion = input.region ?? region();
  return new NamedMemoryCoordinator({
    descriptor: input.descriptor ?? descriptor(),
    driver: input.driver ?? new LocalTransactionalNamedMemoryDriver(),
    region: resolvedRegion,
    agentInstanceId: resolvedRegion.stableAgentInstanceId,
    identityCapabilities: input.capabilities ?? ["project"],
    ledger: input.ledger,
    onDriverCall: input.onDriverCall,
    maxRecallCap: input.maxRecallCap,
    retrievalIndex: input.retrievalIndex,
    barrier: input.barrier,
  });
}

describe("runtime-owned named-memory coordinator", async () => {
  it("preflights capabilities without ledger or driver access", async () => {
    const { ledger, calls, onDriverCall } = harness();
    expect(() => coordinator({
      descriptor: descriptor("durable"),
      driver: new LocalTransactionalNamedMemoryDriver(),
      ledger,
      onDriverCall,
    })).toThrow(/does not advertise retention durable/);
    expect(ledger.events).toEqual([]);
    expect(calls).toEqual({ read: 0, mutation: 0 });
  });

  it("owns prepare, ledger commit, finalize, exact recall, and private receipts", async () => {
    const { ledger, calls, onDriverCall } = harness();
    const retrievalIndex: NamedMemoryRetrievalIndex = {
      algorithm: "test-equal-score",
      version: 1,
      rank: ({ cells }) => [...cells].reverse().map((cell) => ({
        operationId: cell.operationId,
        cellId: cell.cellId,
        score: 0.8,
      })),
    };
    const runtime = coordinator({ ledger, onDriverCall, retrievalIndex });
    const first = await runtime.store({
      invocationCorrelation: "invocation-private",
      evaluationOrdinal: 0,
      operationResultId: "one",
      site: "same-site",
      value: { kind: "text", v: "equal-private", trust: "raw" },
    });
    const second = await runtime.store({
      invocationCorrelation: "invocation-private",
      evaluationOrdinal: 1,
      operationResultId: "two",
      site: "same-site",
      value: { kind: "text", v: "equal-private", trust: "raw" },
    });
    const recalled = await runtime.recall({
      invocationCorrelation: "invocation-private",
      operationResultId: "recall",
      query: "equal-private-query",
      cap: 2,
    });

    expect(first.stage.operationId).not.toBe(second.stage.operationId);
    expect(first.stage.originId).not.toBe(second.stage.originId);
    expect(recalled.hits.map((hit) => hit.cellId)).toEqual(
      recalled.hits.map((hit) => hit.cellId).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    );
    expect(recalled.hits.map((hit) =>
      decodeExactValue(hit.cell.value, descriptor().schema))).toEqual([
      { kind: "text", v: "equal-private", trust: "raw" },
      { kind: "text", v: "equal-private", trust: "raw" },
    ]);
    expect(ledger.events.map((event) => event.etype))
      .toEqual(["Internalized", "Internalized", "MemoryConsulted"]);
    const publicText = JSON.stringify(ledger.events);
    for (const secret of [
      "equal-private", "project-private", "lineage-private", "session-private",
      "issuer-private", "alice-private", "invocation-private", "equal-private-query",
    ]) {
      expect(publicText).not.toContain(secret);
    }
    const consultPayload = ledger.events[2]!.payload as Record<string, unknown>;
    expect(consultPayload).toMatchObject({
      generation: 0,
      region: "notes",
      retrieval: { algorithm: "test-equal-score", version: 1 },
    });
    expect(String(consultPayload.query_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(consultPayload.hit_hashes).toEqual(
      recalled.hits.map((hit) => hit.cell.value.valueHash),
    );
    expect(ledger.events[0]!.payload).toMatchObject({
      operation: "store",
      write_source: "explicit_store",
      region: "notes",
      operation_id: first.stage.operationId,
    });
    expect(calls).toEqual({ read: 1, mutation: 6 });
    expect(runtime.traceSince(0).map((entry) => entry.phase)).toEqual([
      "prepare", "ledger-commit", "finalize",
      "prepare", "ledger-commit", "finalize",
      "recall",
    ]);
  });

  it("fails malformed or missing scope subjects before any seam access", async () => {
    const { ledger, calls, onDriverCall } = harness();
    const runtime = coordinator({
      descriptor: descriptor("session", ["project", "user"]),
      region: region({ user: undefined }),
      capabilities: ["project", "user"],
      ledger,
      onDriverCall,
    });
    await expect(runtime.recall({
      invocationCorrelation: "missing",
      operationResultId: "recall",
      query: "anything-private",
    })).rejects.toThrow(NamedMemoryScopeError);
    expect(ledger.events).toEqual([]);
    expect(calls).toEqual({ read: 0, mutation: 0 });
    expect(runtime.traceSince(0)).toEqual([]);
    runtime.close();
  });

  it("auto-reconciles a lost acknowledgement before later recall", async () => {
    const { ledger, calls, onDriverCall } = harness();
    const runtime = coordinator({
      descriptor: descriptor("durable"),
      driver: new DurableTransactionalNamedMemoryDriver(),
      ledger,
      onDriverCall,
    });
    const stored = await runtime.store({
      invocationCorrelation: "store-invocation",
      evaluationOrdinal: 0,
      operationResultId: "store",
      site: "store-site",
      value: { kind: "text", v: "committed", trust: "raw" },
      loseFinalizeAck: true,
    });
    const recalled = await runtime.recall({
      invocationCorrelation: "recall-invocation",
      operationResultId: "recall",
      query: "committed",
    });

    expect(recalled.hits[0]!.cell.operationId).toBe(stored.stage.operationId);
    expect(runtime.traceSince(0).map((entry) => entry.phase)).toEqual([
      "prepare", "ledger-commit", "finalize", "reconcile", "recall",
    ]);
    expect(calls).toEqual({ read: 1, mutation: 5 });
  });

  it("shares an async pending barrier across agent regions", async () => {
    const { ledger, calls, onDriverCall } = harness();
    const base = new DurableTransactionalNamedMemoryDriver();
    const driver: TransactionalNamedMemoryDriver = {
      capabilities: base.capabilities,
      prepareStore: async (...args: Parameters<typeof base.prepareStore>) => base.prepareStore(...args),
      prepareForget: async (...args: Parameters<typeof base.prepareForget>) => base.prepareForget(...args),
      finalize: async (...args: Parameters<typeof base.finalize>) => base.finalize(...args),
      abort: async (...args: Parameters<typeof base.abort>) => base.abort(...args),
      status: async (...args: Parameters<typeof base.status>) => base.status(...args),
      reconcile: async (...args: Parameters<typeof base.reconcile>) => base.reconcile(...args),
      recall: async (...args: Parameters<typeof base.recall>) => base.recall(...args),
      snapshot: async () => base.snapshot(),
    };
    const barrier = new NamedMemorySessionBarrier();
    const first = coordinator({
      descriptor: descriptor("durable"),
      driver,
      ledger,
      onDriverCall,
      barrier,
    });
    const secondRegion = region({
      stableAgentInstanceId: "agent-instance-v1:" + "b".repeat(64),
    });
    const second = coordinator({
      descriptor: descriptor("durable"),
      driver,
      region: secondRegion,
      ledger,
      onDriverCall,
      barrier,
    });
    await first.store({
      invocationCorrelation: "first",
      evaluationOrdinal: 0,
      operationResultId: "store",
      site: "store",
      value: { kind: "text", v: "first-only", trust: "raw" },
      loseFinalizeAck: true,
    });

    const recalled = await second.recall({
      invocationCorrelation: "second",
      operationResultId: "recall",
      query: "anything",
    });
    expect(recalled.hits).toEqual([]);
    expect(first.traceSince(0).map((entry) => entry.phase)).toEqual([
      "prepare", "ledger-commit", "finalize", "reconcile",
    ]);
    expect(second.traceSince(0).map((entry) => entry.phase)).toEqual(["recall"]);
    expect(calls).toEqual({ read: 1, mutation: 5 });
  });

  it("snapshots descriptor and nested identity inputs against caller mutation", async () => {
    const { ledger, onDriverCall } = harness();
    const mutableDescriptor = descriptor();
    const mutableRegion = region();
    const runtime = coordinator({
      descriptor: mutableDescriptor,
      region: mutableRegion,
      ledger,
      onDriverCall,
    });
    const originalHash = runtime.descriptorHash;
    (mutableDescriptor as { name: string }).name = "mutated";
    (mutableDescriptor.scopes as ("project" | "user")[]).push("user");
    mutableRegion.projectSubject = "mutated-project";
    mutableRegion.user!.subject = "mutated-user";

    await runtime.store({
      invocationCorrelation: "immutable",
      evaluationOrdinal: 0,
      operationResultId: "store",
      site: "store",
      value: { kind: "text", v: "kept", trust: "raw" },
    });
    const recalled = await runtime.recall({
      invocationCorrelation: "immutable",
      operationResultId: "recall",
      query: "kept",
    });
    expect(runtime.descriptor.name).toBe("notes");
    expect(runtime.descriptorHash).toBe(originalHash);
    expect(recalled.hits).toHaveLength(1);
    expect((ledger.events[0]!.payload as Record<string, unknown>).region).toBe("notes");
    await expect(runtime.snapshot()).resolves.toBeTruthy();
  });

  it("enforces the configured cap and rejects noncanonical retrieval ids", async () => {
    const { ledger, onDriverCall } = harness();
    let corruptIds = false;
    const retrievalIndex: NamedMemoryRetrievalIndex = {
      algorithm: "test-index",
      version: 1,
      rank: ({ cells }) => cells.map((cell) => ({
        operationId: cell.operationId,
        cellId: corruptIds ? "fake-cell" : cell.cellId,
        score: 1,
      })),
    };
    const runtime = coordinator({
      ledger,
      onDriverCall,
      retrievalIndex,
      maxRecallCap: 1,
    });
    for (let index = 0; index < 2; index += 1) {
      await runtime.store({
        invocationCorrelation: "cap",
        evaluationOrdinal: index,
        operationResultId: `store-${index}`,
        site: "store",
        value: { kind: "text", v: String(index), trust: "raw" },
      });
    }
    expect((await runtime.recall({
      invocationCorrelation: "cap",
      operationResultId: "capped",
      query: "all",
      cap: 9,
    })).hits).toHaveLength(1);
    corruptIds = true;
    await expect(runtime.recall({
      invocationCorrelation: "cap",
      operationResultId: "corrupt",
      query: "all",
    })).rejects.toThrow(/cannot replace a canonical cell id/);
  });

  it("contains observer failure and aborts only a provably failed ledger append", async () => {
    const ledger = new Ledger(0);
    const runtime = coordinator({
      ledger,
      onDriverCall: () => { throw new Error("observer failure"); },
    });
    await expect(runtime.store({
      invocationCorrelation: "contained",
      evaluationOrdinal: 0,
      operationResultId: "store",
      site: "store",
      value: { kind: "text", v: "visible", trust: "raw" },
    })).resolves.toBeTruthy();

    class ThrowingLedger extends Ledger {
      override append(): never {
        throw new Error("append failed before commit");
      }
    }
    const driver = new LocalTransactionalNamedMemoryDriver();
    const failed = coordinator({ ledger: new ThrowingLedger(0), driver });
    await expect(failed.store({
      invocationCorrelation: "failed",
      evaluationOrdinal: 0,
      operationResultId: "store",
      site: "store",
      value: { kind: "text", v: "invisible", trust: "raw" },
    })).rejects.toThrow(/append failed/);
    expect(driver.recall({ descriptor: descriptor(), region: region() }).values).toEqual([]);
  });
});
