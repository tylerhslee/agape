import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NamedMemoryAdapterRuntime } from "../src/runtime_adapter_named_memory.js";

const schema = {
  kind: "struct" as const,
  name: "MemoryNote",
  fields: {
    text: { kind: "scalar" as const, scalar: "text" as const },
    weight: { kind: "scalar" as const, scalar: "int" as const },
  },
};
const identity = {
  projectSubject: "project-a",
  sessionLineageId: "lineage-a",
  sessionId: "session-a",
  conversationId: "conversation-a",
  user: { issuer: "issuer-a", subject: "user-a", verified: true },
};
const input = (record = false) => ({
  name: "lifecycle",
  driverNamespace: "lifecycle",
  driver: { kind: "markdown" as const },
  program: {
    programId: "program-a",
    manifestId: "manifest-a",
    agentTemplate: "MemoryAgent",
    agentAliases: ["owner"],
    descriptor: {
      name: "notes",
      schema,
      modality: "opaque" as const,
      scopes: ["project" as const],
      retention: "durable" as const,
    },
  },
  identity,
  identityCapabilities: ["project" as const],
  record,
});
function requireSession(result: ReturnType<NamedMemoryAdapterRuntime["open"]>) {
  if (!result.ok || !result.session) throw new Error("expected named-memory session");
  return result.session;
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
function resignRecording(recording: any, key: Buffer) {
  const clone = structuredClone(recording);
  const { mac: _mac, ...body } = clone;
  clone.mac = createHmac("sha256", key)
    .update("agape/named-memory/recording/v1\0")
    .update(canonicalJson(body))
    .digest("hex");
  return clone;
}
function hostileProxy<T extends object>(target: T) {
  let traps = 0;
  const fail = () => { traps += 1; throw new Error("proxy trap executed"); };
  return {
    proxy: new Proxy(target, {
      get: fail, getOwnPropertyDescriptor: fail, getPrototypeOf: fail, ownKeys: fail,
    }),
    traps: () => traps,
  };
}

describe("named-memory adapter lifecycle", () => {
  it("restores an authenticated snapshot in a fresh manager and preserves the ledger prefix", async () => {
    const counters = { memoryDriverCalls: 0, memoryMutationCalls: 0 };
    const snapshotKey = Buffer.alloc(32, 7);
    const firstRuntime = new NamedMemoryAdapterRuntime(counters, snapshotKey);
    const first = requireSession(firstRuntime.open(input(true)));
    await firstRuntime.invoke({
      sessionHandle: first.sessionHandle,
      agentInstanceId: first.agents.owner!.stableInstanceId,
      invocationId: "store-before-close",
      operations: [{
        id: "store", site: "handler:store", operation: "store",
        value: { text: "remember me", weight: 1 },
      }],
    });
    const closed = await firstRuntime.close({ sessionHandle: first.sessionHandle });
    const firstRecording = closed.recording!;

    const freshRuntime = new NamedMemoryAdapterRuntime(counters, snapshotKey);
    const resumedResult = await freshRuntime.resume({
      ...input(true),
      name: "lifecycle-resumed",
      identity: { ...identity, sessionId: "session-b", conversationId: "conversation-b" },
      snapshot: closed.snapshot,
    });
    expect(resumedResult.ok).toBe(true);
    if (!resumedResult.ok || !resumedResult.session) throw new Error("expected resumed session");
    const resumed = resumedResult.session;
    expect(resumed.agents.owner!.stableInstanceId).toBe(first.agents.owner!.stableInstanceId);

    const recalled = await freshRuntime.invoke({
      sessionHandle: resumed.sessionHandle,
      agentInstanceId: resumed.agents.owner!.stableInstanceId,
      invocationId: "recall-after-resume",
      operations: [{ id: "recall", site: "handler:recall", operation: "recall", query: "remember" }],
    });
    expect(recalled.operations[0]!.values?.map((value) => value.value)).toEqual([
      { text: "remember me", weight: 1 },
    ]);
    const reclosed = await freshRuntime.close({ sessionHandle: resumed.sessionHandle });
    expect(reclosed.recording!.events.slice(0, firstRecording.events.length)).toEqual(firstRecording.events);
    expect(reclosed.headHash).not.toBe(closed.headHash);
  });

  it("returns an exact cached invocation and rejects conflicting reuse before a driver call", async () => {
    const counters = { memoryDriverCalls: 0, memoryMutationCalls: 0 };
    const runtime = new NamedMemoryAdapterRuntime(counters, Buffer.alloc(32, 9));
    const opened = requireSession(runtime.open(input()));
    const request = {
      sessionHandle: opened.sessionHandle,
      agentInstanceId: opened.agents.owner!.stableInstanceId,
      invocationId: "stable-invocation",
      operations: [{
        id: "store", site: "handler:store", operation: "store" as const,
        value: { text: "first", weight: 1 },
      }],
    };
    const first = await runtime.invoke(request);
    const afterFirst = { ...counters };
    const retry = await runtime.invoke(request);
    expect(retry).toEqual(first);
    expect(counters).toEqual(afterFirst);

    await expect(runtime.invoke({
      ...request,
      operations: [{ ...request.operations[0]!, value: { text: "conflict", weight: 2 } }],
    })).rejects.toThrow("invocation id was reused");
    expect(counters).toEqual(afterFirst);
  });

  it("serializes concurrent retries and drains accepted work before close", async () => {
    const counters = { memoryDriverCalls: 0, memoryMutationCalls: 0 };
    const runtime = new NamedMemoryAdapterRuntime(counters, Buffer.alloc(32, 10));
    const opened = requireSession(runtime.open(input()));
    const request = {
      sessionHandle: opened.sessionHandle,
      agentInstanceId: opened.agents.owner!.stableInstanceId,
      invocationId: "concurrent-store",
      operations: [{
        id: "store", site: "handler:store", operation: "store" as const,
        value: { text: "once", weight: 1 },
      }],
    };
    const [first, retry] = await Promise.all([runtime.invoke(request), runtime.invoke(request)]);
    expect(retry).toEqual(first);
    expect(first.events.filter((event) => event.etype === "Internalized")).toHaveLength(1);
    expect(Object.isFrozen(first.operations)).toBe(true);
    expect(Object.isFrozen(first.operations[0])).toBe(true);
    expect(Object.isFrozen(first.events)).toBe(true);

    const pending = runtime.invoke({
      sessionHandle: opened.sessionHandle,
      agentInstanceId: opened.agents.owner!.stableInstanceId,
      invocationId: "accepted-before-close",
      operations: [{ id: "recall", site: "handler:recall", operation: "recall", query: "once" }],
    });
    const closing = runtime.close({ sessionHandle: opened.sessionHandle });
    await expect(pending).resolves.toMatchObject({ ok: true });
    const closed = await closing;
    expect(closed.invocations).toHaveLength(2);
    await expect(runtime.invoke({ ...request, invocationId: "after-close" }))
      .rejects.toThrow("unknown or destroyed");
  });

  it("persists exact invocation idempotency across resume", async () => {
    const counters = { memoryDriverCalls: 0, memoryMutationCalls: 0 };
    const key = Buffer.alloc(32, 11);
    const firstRuntime = new NamedMemoryAdapterRuntime(counters, key);
    const first = requireSession(firstRuntime.open(input(true)));
    const operations = [{
      id: "store", site: "handler:store", operation: "store" as const,
      value: { text: "cached", weight: 3 },
    }];
    const original = await firstRuntime.invoke({
      sessionHandle: first.sessionHandle,
      agentInstanceId: first.agents.owner!.stableInstanceId,
      invocationId: "persisted-invocation",
      operations,
    });
    const closed = await firstRuntime.close({ sessionHandle: first.sessionHandle });

    const freshRuntime = new NamedMemoryAdapterRuntime(counters, key);
    const resumedResult = await freshRuntime.resume({ ...input(true), snapshot: closed.snapshot });
    if (!resumedResult.ok || !resumedResult.session) throw new Error("expected resumed session");
    const before = { ...counters };
    const retry = await freshRuntime.invoke({
      sessionHandle: resumedResult.session.sessionHandle,
      agentInstanceId: resumedResult.session.agents.owner!.stableInstanceId,
      invocationId: "persisted-invocation",
      operations,
    });
    expect(retry).toEqual(original);
    expect(counters).toEqual(before);
    const reclosed = await freshRuntime.close({ sessionHandle: resumedResult.session.sessionHandle });
    expect(reclosed.recording!.invocations).toHaveLength(1);
  });

  it("rejects wrong keys, changed topology, local resume, recording tamper, and accessor snapshots", async () => {
    const counters = { memoryDriverCalls: 0, memoryMutationCalls: 0 };
    const key = Buffer.alloc(32, 12);
    const runtime = new NamedMemoryAdapterRuntime(counters, key);
    const opened = requireSession(runtime.open(input(true)));
    await runtime.invoke({
      sessionHandle: opened.sessionHandle,
      agentInstanceId: opened.agents.owner!.stableInstanceId,
      invocationId: "record-one",
      operations: [{ id: "recall", site: "handler:recall", operation: "recall", query: "none" }],
    });
    const closed = await runtime.close({ sessionHandle: opened.sessionHandle });

    const wrongKey = new NamedMemoryAdapterRuntime(counters, Buffer.alloc(32, 13));
    await expect(wrongKey.resume({ ...input(), snapshot: closed.snapshot }))
      .resolves.toMatchObject({ ok: false, fault: { code: "SnapshotAuthenticationFailed" } });
    await expect(runtime.resume({
      ...input(),
      program: { ...input().program, agentTemplate: "ChangedAgent" },
      snapshot: closed.snapshot,
    })).resolves.toMatchObject({ ok: false, fault: { binding: "topologyHash" } });
    await expect(runtime.resume({
      ...input(), driver: { kind: "local" }, snapshot: closed.snapshot,
    })).resolves.toMatchObject({ ok: false, error: { category: "ConfigError" } });

    expect(() => runtime.replay({ ...closed.recording!, headHash: "0".repeat(64) }))
      .toThrow("recording authentication failed");
    let getterCalls = 0;
    const accessorSnapshot: Record<string, unknown> = {
      kind: "agape-ts-named-memory-snapshot",
      mac: (closed.snapshot as { mac: string }).mac,
    };
    Object.defineProperty(accessorSnapshot, "payload", {
      enumerable: true,
      get() { getterCalls += 1; return (closed.snapshot as { payload: unknown }).payload; },
    });
    await expect(runtime.resume({ ...input(), snapshot: accessorSnapshot })).rejects.toThrow("data property");
    expect(getterCalls).toBe(0);
  });

  it("rejects cyclic and prototype-polluting invocation data before any driver call", async () => {
    const counters = { memoryDriverCalls: 0, memoryMutationCalls: 0 };
    const runtime = new NamedMemoryAdapterRuntime(counters, Buffer.alloc(32, 14));
    const opened = requireSession(runtime.open(input()));
    const cyclic: Record<string, unknown> = { text: "cycle", weight: 1 };
    cyclic.self = cyclic;
    const base = {
      sessionHandle: opened.sessionHandle,
      agentInstanceId: opened.agents.owner!.stableInstanceId,
      invocationId: "bad-data",
      operations: [{ id: "store", site: "handler:store", operation: "store" as const, value: cyclic }],
    };
    await expect(runtime.invoke(base)).rejects.toThrow("cycle");
    const polluted = { text: "pollution", weight: 1 } as Record<string, unknown>;
    Object.defineProperty(polluted, "__proto__", { value: "bad", enumerable: true });
    await expect(runtime.invoke({ ...base, invocationId: "bad-prototype", operations: [
      { ...base.operations[0]!, value: polluted },
    ] })).rejects.toThrow("not an allowed data key");
    expect(counters.memoryDriverCalls).toBe(0);
  });

  it("rejects root and nested proxies without executing any proxy trap", async () => {
    const counters = { memoryDriverCalls: 0, memoryMutationCalls: 0 };
    const runtime = new NamedMemoryAdapterRuntime(counters, Buffer.alloc(32, 15));
    const opened = requireSession(runtime.open(input(true)));
    const request = {
      sessionHandle: opened.sessionHandle,
      agentInstanceId: opened.agents.owner!.stableInstanceId,
      invocationId: "proxy-root",
      operations: [{ id: "recall", site: "recall", operation: "recall" as const, query: "none" }],
    };
    const rootInvocation = hostileProxy(request);
    await expect(runtime.invoke(rootInvocation.proxy as any)).rejects.toThrow("proxies");
    expect(rootInvocation.traps()).toBe(0);

    const nestedValue = hostileProxy({ text: "nested", weight: 1 });
    await expect(runtime.invoke({
      ...request,
      invocationId: "proxy-nested",
      operations: [{ id: "store", site: "store", operation: "store", value: nestedValue.proxy }],
    })).rejects.toThrow("proxies");
    expect(nestedValue.traps()).toBe(0);

    await runtime.invoke(request);
    const closed = await runtime.close({ sessionHandle: opened.sessionHandle });
    const rootSnapshot = hostileProxy(closed.snapshot as object);
    await expect(runtime.resume({ ...input(), snapshot: rootSnapshot.proxy })).rejects.toThrow("proxies");
    expect(rootSnapshot.traps()).toBe(0);
    const originalSnapshot = closed.snapshot as { kind: string; payload: object; mac: string };
    const nestedSnapshot = hostileProxy(originalSnapshot.payload);
    await expect(runtime.resume({
      ...input(), snapshot: { ...originalSnapshot, payload: nestedSnapshot.proxy },
    })).rejects.toThrow("proxies");
    expect(nestedSnapshot.traps()).toBe(0);

    const rootRecording = hostileProxy(closed.recording! as object);
    expect(() => runtime.replay(rootRecording.proxy)).toThrow("proxies");
    expect(rootRecording.traps()).toBe(0);
    const originalRecording = closed.recording! as any;
    const nestedRecording = hostileProxy(originalRecording.events as object);
    expect(() => runtime.replay({ ...originalRecording, events: nestedRecording.proxy })).toThrow("proxies");
    expect(nestedRecording.traps()).toBe(0);
  });

  it("freezes authenticated outers and rejects extra snapshot or recording fields", async () => {
    const counters = { memoryDriverCalls: 0, memoryMutationCalls: 0 };
    const runtime = new NamedMemoryAdapterRuntime(counters, Buffer.alloc(32, 16));
    const opened = requireSession(runtime.open(input(true)));
    await runtime.invoke({
      sessionHandle: opened.sessionHandle,
      agentInstanceId: opened.agents.owner!.stableInstanceId,
      invocationId: "exact-keys",
      operations: [{ id: "recall", site: "recall", operation: "recall", query: "none" }],
    });
    const closed = await runtime.close({ sessionHandle: opened.sessionHandle });
    expect(Object.isFrozen(closed.snapshot)).toBe(true);
    expect(Object.isFrozen((closed.snapshot as any).payload)).toBe(true);
    expect(Object.isFrozen(closed.recording)).toBe(true);

    const extraOuter = structuredClone(closed.snapshot) as any;
    extraOuter.extra = true;
    await expect(runtime.resume({ ...input(), snapshot: extraOuter })).resolves.toMatchObject({
      ok: false, fault: { code: "SnapshotAuthenticationFailed", message: expect.stringContaining("unexpected fields") },
    });
    const extraPayload = structuredClone(closed.snapshot) as any;
    extraPayload.payload.extra = true;
    await expect(runtime.resume({ ...input(), snapshot: extraPayload })).resolves.toMatchObject({
      ok: false, fault: { code: "SnapshotAuthenticationFailed", message: expect.stringContaining("unexpected fields") },
    });
    const extraBinding = structuredClone(closed.snapshot) as any;
    extraBinding.payload.bindings.extra = true;
    await expect(runtime.resume({ ...input(), snapshot: extraBinding })).resolves.toMatchObject({
      ok: false, fault: { code: "SnapshotAuthenticationFailed", message: expect.stringContaining("unexpected fields") },
    });
    expect(() => runtime.replay({ ...closed.recording!, extra: true }))
      .toThrow("unexpected fields");
  });

  it("rejects overlapping event slices, wrong receipt kinds, and non-bijective ack evidence", async () => {
    const counters = { memoryDriverCalls: 0, memoryMutationCalls: 0 };
    const key = Buffer.alloc(32, 17);
    const runtime = new NamedMemoryAdapterRuntime(counters, key);
    const opened = requireSession(runtime.open(input(true)));
    await runtime.invoke({
      sessionHandle: opened.sessionHandle,
      agentInstanceId: opened.agents.owner!.stableInstanceId,
      invocationId: "evidence-store",
      operations: [
        { id: "store-a", site: "store-a", operation: "store", value: { text: "evidence-a", weight: 1 } },
        { id: "store-b", site: "store-b", operation: "store", value: { text: "evidence-b", weight: 2 } },
      ],
    });
    await runtime.invoke({
      sessionHandle: opened.sessionHandle,
      agentInstanceId: opened.agents.owner!.stableInstanceId,
      invocationId: "evidence-recall",
      operations: [{ id: "recall", site: "recall", operation: "recall", query: "evidence" }],
    });
    const closed = await runtime.close({ sessionHandle: opened.sessionHandle });
    expect(runtime.replay(closed.recording)).toMatchObject({ ok: true });

    const overlap = structuredClone(closed.recording!) as any;
    overlap.invocations[1].events = overlap.invocations[0].events;
    expect(() => runtime.replay(resignRecording(overlap, key))).toThrow(/event evidence|contiguous/);

    const wrongKind = structuredClone(closed.recording!) as any;
    wrongKind.invocations[0].operations[0].operation = "recall";
    expect(() => runtime.replay(resignRecording(wrongKind, key))).toThrow("receipt evidence");

    const swappedReceipts = structuredClone(closed.recording!) as any;
    const firstReceipt = swappedReceipts.invocations[0].operations[0].receipt;
    swappedReceipts.invocations[0].operations[0].receipt = swappedReceipts.invocations[0].operations[1].receipt;
    swappedReceipts.invocations[0].operations[1].receipt = firstReceipt;
    expect(() => runtime.replay(resignRecording(swappedReceipts, key)))
      .toThrow("receipt operation binding");

    const pairedDeletion = structuredClone(closed.recording!) as any;
    const deletedOperationId = pairedDeletion.invocations[0].operations[0].operationId;
    delete pairedDeletion.invocations[0].operations[0].mutationAck;
    pairedDeletion.mutationAcks = pairedDeletion.mutationAcks.filter(
      (ack: any) => ack.operationId !== deletedOperationId,
    );
    expect(() => runtime.replay(resignRecording(pairedDeletion, key))).toThrow("missing its operation ack");

    const falseOperation = structuredClone(closed.recording!) as any;
    const falseResult = falseOperation.invocations[0].operations[0];
    const falseOperationId = falseResult.operationId;
    falseResult.ok = false;
    delete falseResult.receipt;
    delete falseResult.mutationAck;
    falseOperation.mutationAcks = falseOperation.mutationAcks.filter(
      (ack: any) => ack.operationId !== falseOperationId,
    );
    expect(() => runtime.replay(resignRecording(falseOperation, key))).toThrow("operation evidence");

    const missingFault = structuredClone(closed.recording!) as any;
    missingFault.invocations[0].ok = false;
    expect(() => runtime.replay(resignRecording(missingFault, key))).toThrow("invocation status evidence");

    const falseSuccess = structuredClone(closed.recording!) as any;
    falseSuccess.invocations[0].fault = { code: "AgentCrashed", message: "forged" };
    expect(() => runtime.replay(resignRecording(falseSuccess, key))).toThrow("invocation status evidence");

    const unclaimedMemoryEvent = structuredClone(closed.recording!) as any;
    const removedOperation = unclaimedMemoryEvent.invocations[0].operations.pop();
    unclaimedMemoryEvent.mutationAcks = unclaimedMemoryEvent.mutationAcks.filter(
      (ack: any) => ack.operationId !== removedOperation.operationId,
    );
    expect(() => runtime.replay(resignRecording(unclaimedMemoryEvent, key)))
      .toThrow("unclaimed memory event evidence");

    const wrongAgent = structuredClone(closed.recording!) as any;
    wrongAgent.invocations[0].agentInstanceId = "forged-agent";
    expect(() => runtime.replay(resignRecording(wrongAgent, key))).toThrow("event evidence");

    const mismatchedAck = structuredClone(closed.recording!) as any;
    const changedAck = mismatchedAck.invocations[0].operations[0].mutationAck;
    changedAck.generation += 1;
    mismatchedAck.mutationAcks.find((ack: any) => ack.operationId === changedAck.operationId).generation += 1;
    expect(() => runtime.replay(resignRecording(mismatchedAck, key))).toThrow("operation ack evidence");

    const duplicateAck = structuredClone(closed.recording!) as any;
    duplicateAck.mutationAcks.push(structuredClone(duplicateAck.mutationAcks[0]));
    expect(() => runtime.replay(resignRecording(duplicateAck, key))).toThrow("mutation ack evidence");

    const missingAck = structuredClone(closed.recording!) as any;
    missingAck.mutationAcks = [];
    expect(() => runtime.replay(resignRecording(missingAck, key))).toThrow("mutation ack evidence");
  });

  it("binds failed invocation fault metadata to its terminal crash event", async () => {
    const counters = { memoryDriverCalls: 0, memoryMutationCalls: 0 };
    const key = Buffer.alloc(32, 19);
    const runtime = new NamedMemoryAdapterRuntime(counters, key);
    const missingUserInput = input(true) as any;
    missingUserInput.program.descriptor.scopes = ["project", "user"];
    missingUserInput.identity = { ...identity, user: undefined };
    missingUserInput.identityCapabilities = ["project", "user"];
    const opened = requireSession(runtime.open(missingUserInput));
    const failed = await runtime.invoke({
      sessionHandle: opened.sessionHandle,
      agentInstanceId: opened.agents.owner!.stableInstanceId,
      invocationId: "missing-user",
      operations: [{ id: "recall", site: "recall", operation: "recall", query: "anything" }],
    });
    expect(failed).toMatchObject({
      ok: false,
      fault: { code: "MissingScopeSubject", scope: "user" },
    });
    const closed = await runtime.close({ sessionHandle: opened.sessionHandle });
    expect(runtime.replay(closed.recording)).toMatchObject({ ok: true });

    const malformedFault = structuredClone(closed.recording!) as any;
    malformedFault.invocations[0].fault = {};
    expect(() => runtime.replay(resignRecording(malformedFault, key)))
      .toThrow("invocation status evidence");

    const invalidMessage = structuredClone(closed.recording!) as any;
    invalidMessage.invocations[0].fault.message = 42;
    expect(() => runtime.replay(resignRecording(invalidMessage, key)))
      .toThrow("invocation status evidence");

    const mismatchedCode = structuredClone(closed.recording!) as any;
    mismatchedCode.invocations[0].fault.code = "ForgedCode";
    expect(() => runtime.replay(resignRecording(mismatchedCode, key)))
      .toThrow("invocation status evidence");

    const mismatchedScope = structuredClone(closed.recording!) as any;
    mismatchedScope.invocations[0].fault.scope = "project";
    expect(() => runtime.replay(resignRecording(mismatchedScope, key)))
      .toThrow("invocation status evidence");
  });
});
