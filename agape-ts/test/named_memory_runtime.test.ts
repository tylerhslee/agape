import { describe, expect, it } from "vitest";
import { Ledger } from "../src/runtime.js";
import {
  NamedMemoryRuntime,
  type NamedMemoryOperationInput,
  type NamedMemoryRuntimeIdentity,
  type NamedMemoryRuntimeRecording,
} from "../src/named_memory_runtime.js";
import {
  LocalTransactionalNamedMemoryDriver,
} from "../src/named_memory_local.js";
import type { TransactionalNamedMemoryDriver } from "../src/named_memory_coordinator.js";
import type { ResolvedMemoryDescriptor } from "../src/named_memory.js";

const identity = (user = "alice"): NamedMemoryRuntimeIdentity => ({
  projectSubject: "project://runtime-hardening",
  sessionLineageId: "lineage-runtime-hardening",
  sessionId: "session-runtime-hardening",
  conversationId: "conversation-runtime-hardening",
  user: { issuer: "https://issuer.example", subject: user, verified: true },
});

const descriptor: ResolvedMemoryDescriptor = {
  name: "episodes",
  schema: { kind: "scalar", name: "text" },
  modality: "episodic",
  scopes: ["project", "user"],
  retention: "session",
};

const agentInstanceId = `agent-instance-v1:${"a".repeat(64)}`;
const operation = (
  kind: "store" | "recall" | "forget" = "store",
): NamedMemoryOperationInput => ({
  agentInstanceId,
  descriptor,
  invocationCorrelation: "invocation-runtime-hardening",
  evaluationOrdinal: 0,
  operationResultId: `result-${kind}`,
  site: `Agent:1:1:${kind}`,
  originEvidence: {
    reactionEvent: 7,
    prompt: { attester: "verified-user", prompt_name: "question" },
  },
});

async function liveRecording(): Promise<NamedMemoryRuntimeRecording> {
  const runtime = new NamedMemoryRuntime({
    ledger: new Ledger(0),
    identity: identity(),
    options: { driver: new LocalTransactionalNamedMemoryDriver() },
  });
  await runtime.validateDescriptors([descriptor]);
  await runtime.store({
    ...operation("store"),
    value: { kind: "text", v: "private replay value", trust: "raw" },
  });
  const recording = runtime.recording();
  await runtime.close();
  return recording;
}

function delegatingDriver(
  base: LocalTransactionalNamedMemoryDriver,
  extra: Record<string, unknown> = {},
): TransactionalNamedMemoryDriver {
  return {
    capabilities: base.capabilities,
    prepareStore: (request) => base.prepareStore(request),
    prepareForget: (request) => base.prepareForget(request),
    finalize: (operationId, binding) => base.finalize(operationId, binding),
    abort: (operationId) => base.abort(operationId),
    status: (operationId) => base.status(operationId),
    reconcile: (operationId, binding) => base.reconcile(operationId, binding),
    recall: (request) => base.recall(request),
    snapshot: () => base.snapshot(),
    ...extra,
  };
}

describe("named-memory production session hardening", () => {
  it("binds replay to the full opaque runtime identity including the user tuple", async () => {
    const recording = await liveRecording();
    expect(recording.identityCommitment).toMatch(/^named-memory-runtime-identity-v1:[0-9a-f]{64}$/);
    expect(JSON.stringify(recording)).not.toContain("alice");
    expect(() => new NamedMemoryRuntime({
      ledger: new Ledger(0),
      identity: identity("bob"),
      options: { replay: recording },
    })).toThrow(/runtime identity mismatch/);
  });

  it("requires replay to consume every recorded operation before close", async () => {
    const recording = await liveRecording();
    const replay = new NamedMemoryRuntime({
      ledger: new Ledger(0),
      identity: identity(),
      options: { replay: recording },
    });
    await expect(replay.close()).rejects.toThrow(/fully consumed/);
    await replay.store({
      ...operation("store"),
      value: { kind: "text", v: "private replay value", trust: "raw" },
    });
    await expect(replay.close()).resolves.toBeUndefined();
  });

  it("compares origin evidence canonically rather than by object insertion order", async () => {
    const recording = await liveRecording();
    const first = recording.operations[0]!;
    const reordered: NamedMemoryRuntimeRecording = {
      ...recording,
      operations: [{
        ...first,
        originEvidence: {
          prompt: first.originEvidence!.prompt,
          reactionEvent: first.originEvidence!.reactionEvent,
        },
      }],
    };
    const replay = new NamedMemoryRuntime({
      ledger: new Ledger(0),
      identity: identity(),
      options: { replay: reordered },
    });
    await expect(replay.store({
      ...operation("store"),
      value: { kind: "text", v: "private replay value", trust: "raw" },
    })).resolves.toMatchObject({ event: { etype: "Internalized" } });
    await replay.close();
  });

  it("retries close safely when a driver close acknowledgement fails", async () => {
    const base = new LocalTransactionalNamedMemoryDriver();
    let closes = 0;
    const driver = delegatingDriver(base, {
      close: async () => {
        closes += 1;
        if (closes === 1) throw new Error("lost close acknowledgement");
      },
    });
    const runtime = new NamedMemoryRuntime({
      ledger: new Ledger(0),
      identity: identity(),
      options: { driver },
    });
    await expect(runtime.close()).rejects.toThrow(/lost close acknowledgement/);
    await expect(runtime.validateDescriptors([])).resolves.toBeUndefined();
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(closes).toBe(2);
  });

  it("fails validation and use after close without constructing a lazy driver", async () => {
    let factories = 0;
    const runtime = new NamedMemoryRuntime({
      ledger: new Ledger(0),
      identity: identity(),
      options: {
        driverFactory: () => {
          factories += 1;
          return new LocalTransactionalNamedMemoryDriver();
        },
      },
    });
    await runtime.close();
    await expect(runtime.validateDescriptors([descriptor])).rejects.toThrow(/closed/);
    await expect(runtime.recall({ ...operation("recall"), query: "q" })).rejects.toThrow(/closed/);
    expect(factories).toBe(0);
  });

  it("constructs one driver/coordinator path for concurrent first reads", async () => {
    let factories = 0;
    let reads = 0;
    const base = new LocalTransactionalNamedMemoryDriver();
    const driver = delegatingDriver(base, {
      recall: async (request: Parameters<TransactionalNamedMemoryDriver["recall"]>[0]) => {
        reads += 1;
        await Promise.resolve();
        return base.recall(request);
      },
    });
    const runtime = new NamedMemoryRuntime({
      ledger: new Ledger(0),
      identity: identity(),
      options: {
        driverFactory: async () => {
          factories += 1;
          await Promise.resolve();
          return driver;
        },
      },
    });
    await Promise.all([
      runtime.recall({ ...operation("recall"), operationResultId: "read-1", query: "q" }),
      runtime.recall({ ...operation("recall"), operationResultId: "read-2", query: "q" }),
    ]);
    expect(factories).toBe(1);
    expect(reads).toBe(2);
    await runtime.close();
  });

  it("retries a rejected lazy driver factory instead of caching the rejection", async () => {
    let factories = 0;
    const runtime = new NamedMemoryRuntime({
      ledger: new Ledger(0),
      identity: identity(),
      options: {
        driverFactory: async () => {
          factories += 1;
          if (factories === 1) throw new Error("transient driver open failure");
          return new LocalTransactionalNamedMemoryDriver();
        },
      },
    });
    await expect(runtime.validateDescriptors([descriptor])).rejects.toThrow(/transient driver open failure/);
    await expect(runtime.validateDescriptors([descriptor])).resolves.toBeUndefined();
    expect(factories).toBe(2);
    await runtime.close();
  });
});
