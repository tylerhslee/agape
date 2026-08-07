import { describe, expect, it } from "vitest";
import {
  LocalTransactionalNamedMemoryJournal,
  LocalTransactionalNamedMemoryDriver,
  type NamedMemoryMutationContext,
} from "../src/named_memory_local.js";
import {
  encodeExactValue,
  type MemoryRegionKeyInput,
  type ResolvedMemoryDescriptor,
} from "../src/named_memory.js";

const descriptor = (
  retention: "session" | "durable" = "session",
): ResolvedMemoryDescriptor => ({
  name: "notes",
  schema: { kind: "scalar", name: "text" },
  modality: "opaque",
  scopes: ["project", "user"],
  retention,
});

const region = (
  overrides: Partial<Omit<MemoryRegionKeyInput, "descriptor">> = {},
): Omit<MemoryRegionKeyInput, "descriptor"> => ({
  projectSubject: "project://agape",
  sessionLineageId: "lineage-1",
  sessionId: "session-1",
  stableAgentInstanceId: "agent-instance-v1:" + "a".repeat(64),
  user: { issuer: "https://idp.example", subject: "alice", verified: true },
  ...overrides,
});

const mutation = (
  overrides: Partial<NamedMemoryMutationContext> = {},
): NamedMemoryMutationContext => ({
  descriptor: descriptor(),
  region: region(),
  site: "app.ag:12:7",
  origin: { invocationCorrelation: "prompt:17", evaluationOrdinal: 0 },
  ...overrides,
});

const binding = { tick: 41, head: "ledger-head-41" };

describe("transactional Local named memory", () => {
  it("advertises its exact transactional Local capabilities immutably", () => {
    const capabilities = new LocalTransactionalNamedMemoryDriver().capabilities;
    expect(capabilities).toEqual({
      version: 1,
      modalities: ["opaque", "episodic", "semantic"],
      retentions: ["session"],
      scopes: ["project", "user"],
      exactEncoding: true,
      idempotentReconciliation: true,
    });
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities.modalities)).toBe(true);
    expect(Object.isFrozen(capabilities.retentions)).toBe(true);
    expect(Object.isFrozen(capabilities.scopes)).toBe(true);
  });

  it("prepares deterministically and invisibly, then finalizes exactly once", () => {
    const driver = new LocalTransactionalNamedMemoryDriver();
    const request = {
      ...mutation(),
      value: { kind: "text" as const, v: "first", trust: "settled" as const },
    };

    const first = driver.prepareStore(request);
    const retry = driver.prepareStore(request);

    expect(retry).toBe(first);
    expect(first.operationId).toMatch(/^memory-operation-v1:[0-9a-f]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.effects)).toBe(true);
    expect(Object.isFrozen(first.refs)).toBe(true);
    const publicStage = JSON.stringify(first);
    for (const secret of ["first", "project://agape", "https://idp.example", "alice", "lineage-1", "session-1"]) {
      expect(publicStage).not.toContain(secret);
    }
    expect(driver.recall({ descriptor: request.descriptor, region: request.region })).toMatchObject({
      generation: 0,
      state: "open",
      values: [],
    });
    expect(Object.isFrozen(driver.status(first.operationId))).toBe(true);
    expect(Object.isFrozen(driver.reconcile(first.operationId))).toBe(true);
    expect(driver.status(first.operationId)).toEqual({ status: "prepared", stage: first });
    expect(driver.reconcile(first.operationId)).toEqual({ status: "prepared", stage: first });

    const receipt = driver.finalize(first.operationId, binding);
    expect(receipt).toMatchObject({
      operationId: first.operationId,
      generation: 0,
      ledger: binding,
      effects: { cells: { upserted: 1, tombstoned: 0 } },
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.ledger)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("first");
    expect(JSON.stringify(receipt)).not.toContain("lineage-1");
    expect(JSON.stringify(receipt)).not.toContain("session-1");
    expect(JSON.stringify(receipt)).not.toContain("project://agape");
    expect(JSON.stringify(receipt)).not.toContain("https://idp.example");
    expect(JSON.stringify(receipt)).not.toContain("alice");
    expect(driver.recall({ descriptor: request.descriptor, region: request.region }).values)
      .toEqual([encodeExactValue(request.value, request.descriptor.schema)]);

    const duplicate = driver.finalize(first.operationId, binding);
    expect(duplicate).toBe(receipt);
    expect(driver.recall({ descriptor: request.descriptor, region: request.region }).values)
      .toHaveLength(1);
    const distinct = driver.prepareStore({
      ...request,
      origin: { invocationCorrelation: "prompt:17", evaluationOrdinal: 1 },
    });
    expect(distinct.operationId).not.toBe(first.operationId);
    expect(distinct.originId).not.toBe(first.originId);
    expect(distinct.cellId).not.toBe(first.cellId);
    expect(JSON.stringify(distinct)).not.toContain("prompt:17");
    driver.finalize(distinct.operationId, { tick: 42, head: "ledger-head-42" });
    const recalled = driver.recall({ descriptor: request.descriptor, region: request.region });
    expect(recalled.cells).toHaveLength(2);
    expect(recalled.cells.map((cell) => cell.operationId))
      .toEqual([first.operationId, distinct.operationId]);
    expect(new Set(recalled.cells.map((cell) => cell.originId)).size).toBe(2);
    expect(new Set(recalled.cells.map((cell) => cell.cellId)).size).toBe(2);
    expect(recalled.values).toEqual([
      encodeExactValue(request.value, request.descriptor.schema),
      encodeExactValue(request.value, request.descriptor.schema),
    ]);
  });

  it("aborts without mutation and distinguishes prepared, finalized, aborted, and unknown", () => {
    const driver = new LocalTransactionalNamedMemoryDriver();
    const abortedRequest = {
      ...mutation({ origin: { invocationCorrelation: "prompt:17", evaluationOrdinal: 1 } }),
      value: { kind: "text" as const, v: "never visible", trust: "raw" as const },
    };
    const aborted = driver.prepareStore(abortedRequest);
    expect(driver.abort(aborted.operationId)).toEqual({ status: "aborted" });
    expect(driver.abort(aborted.operationId)).toEqual({ status: "aborted" });
    expect(driver.status(aborted.operationId)).toEqual({ status: "aborted" });
    expect(driver.reconcile(aborted.operationId)).toEqual({ status: "aborted" });
    expect(Object.isFrozen(driver.status(aborted.operationId))).toBe(true);
    expect(() => driver.prepareStore(abortedRequest)).toThrow(/aborted/i);
    expect(driver.status("memory-operation-v1:" + "0".repeat(64))).toEqual({ status: "unknown" });
    expect(driver.reconcile("memory-operation-v1:" + "0".repeat(64))).toEqual({ status: "unknown" });
    expect(driver.recall({ descriptor: descriptor(), region: region() }).values).toEqual([]);

    const finalized = driver.prepareStore({
      ...mutation({ origin: { invocationCorrelation: "prompt:17", evaluationOrdinal: 2 } }),
      value: { kind: "text", v: "visible", trust: "settled" },
    });
    const receipt = driver.finalize(finalized.operationId, binding);
    expect(driver.status(finalized.operationId)).toEqual({ status: "finalized", receipt });
    expect(driver.reconcile(finalized.operationId)).toEqual({ status: "finalized", receipt });
    expect(Object.isFrozen(driver.status(finalized.operationId))).toBe(true);
    expect(Object.isFrozen(driver.reconcile(finalized.operationId))).toBe(true);
  });

  it("closes an empty open generation before treating later forgets as repeats", () => {
    const driver = new LocalTransactionalNamedMemoryDriver();
    const first = driver.prepareForget(mutation());

    expect(first).toMatchObject({
      generation: 0,
      alreadyForgotten: false,
      effects: { cells: { upserted: 0, tombstoned: 0 } },
    });
    expect(driver.recall({ descriptor: descriptor(), region: region() })).toMatchObject({
      generation: 0,
      state: "open",
    });
    driver.finalize(first.operationId, { tick: 1, head: "empty-h1" });
    expect(driver.recall({ descriptor: descriptor(), region: region() })).toMatchObject({
      generation: 0,
      state: "closed",
      cells: [],
      values: [],
    });

    const repeated = driver.prepareForget(
      mutation({ origin: { invocationCorrelation: "prompt:17", evaluationOrdinal: 1 } }),
    );
    expect(repeated).toMatchObject({
      generation: 0,
      alreadyForgotten: true,
      effects: { cells: { upserted: 0, tombstoned: 0 } },
    });
  });

  it("pins store and forget generation transitions with exact encoded values", () => {
    const driver = new LocalTransactionalNamedMemoryDriver();
    const first = driver.prepareStore({
      ...mutation(),
      value: { kind: "text", v: "generation zero", trust: "settled" },
    });
    driver.finalize(first.operationId, { tick: 1, head: "h1" });

    const forget = driver.prepareForget(
      mutation({ origin: { invocationCorrelation: "prompt:17", evaluationOrdinal: 1 } }),
    );
    expect(forget).toMatchObject({ generation: 0, alreadyForgotten: false });
    const forgot = driver.finalize(forget.operationId, { tick: 2, head: "h2" });
    expect(forgot.effects).toEqual({ cells: { upserted: 0, tombstoned: 1 } });
    expect(driver.recall({ descriptor: descriptor(), region: region() })).toMatchObject({
      generation: 0,
      state: "closed",
      values: [],
    });

    const repeated = driver.prepareForget(
      mutation({ origin: { invocationCorrelation: "prompt:17", evaluationOrdinal: 2 } }),
    );
    expect(repeated).toMatchObject({ generation: 0, alreadyForgotten: true });
    expect(driver.finalize(repeated.operationId, { tick: 3, head: "h3" }).effects)
      .toEqual({ cells: { upserted: 0, tombstoned: 0 } });

    const abortedReopen = driver.prepareStore({
      ...mutation({ origin: { invocationCorrelation: "prompt:17", evaluationOrdinal: 3 } }),
      value: { kind: "text", v: "aborted generation one", trust: "settled" },
    });
    expect(abortedReopen.generation).toBe(1);
    expect(driver.abort(abortedReopen.operationId)).toEqual({ status: "aborted" });
    expect(driver.recall({ descriptor: descriptor(), region: region() })).toMatchObject({
      generation: 0,
      state: "closed",
      values: [],
    });

    const reopened = driver.prepareStore({
      ...mutation({ origin: { invocationCorrelation: "prompt:17", evaluationOrdinal: 4 } }),
      value: { kind: "text", v: "generation one", trust: "graded" },
    });
    expect(reopened.generation).toBe(1);
    driver.finalize(reopened.operationId, { tick: 4, head: "h4" });
    const recalled = driver.recall({ descriptor: descriptor(), region: region() });
    expect(recalled).toMatchObject({
      generation: 1,
      state: "open",
      values: [encodeExactValue(
        { kind: "text", v: "generation one", trust: "graded" },
        descriptor().schema,
      )],
    });
    expect(recalled.cells).toHaveLength(1);
    expect(recalled.cells[0]).toMatchObject({
      cellId: reopened.cellId,
      originId: reopened.originId,
      operationId: reopened.operationId,
      value: encodeExactValue(
        { kind: "text", v: "generation one", trust: "graded" },
        descriptor().schema,
      ),
    });
  });

  it("isolates project, user, stable instance, and session dimensions while rejecting durable", () => {
    const driver = new LocalTransactionalNamedMemoryDriver();
    const base = mutation();
    const prepared = driver.prepareStore({
      ...base,
      value: { kind: "text", v: "isolated", trust: "settled" },
    });
    driver.finalize(prepared.operationId, binding);

    const variants = [
      { descriptor: base.descriptor, region: region({ projectSubject: "project://other" }) },
      { descriptor: base.descriptor, region: region({ user: { issuer: "https://idp.example", subject: "bob", verified: true } }) },
      { descriptor: base.descriptor, region: region({ stableAgentInstanceId: "agent-instance-v1:" + "b".repeat(64) }) },
      { descriptor: base.descriptor, region: region({ sessionId: "session-2" }) },
    ];
    for (const variant of variants) {
      expect(driver.recall(variant).values).toEqual([]);
    }
    expect(() => driver.recall({ descriptor: descriptor("durable"), region: region() }))
      .toThrow(/session retention only/i);
    expect(() => driver.prepareStore({
      ...mutation({ descriptor: descriptor("durable") }),
      value: { kind: "text", v: "not local durable", trust: "settled" },
    })).toThrow(/session retention only/i);

    expect(new Set([
      prepared.regionKey,
      ...variants.map((variant, index) => driver.prepareStore({
        ...mutation({
          descriptor: variant.descriptor,
          region: variant.region,
          origin: { invocationCorrelation: "isolation", evaluationOrdinal: index },
        }),
        value: { kind: "text", v: "variant", trust: "settled" },
      }).regionKey),
    ]).size).toBe(variants.length + 1);
  });

  it("resolves evaluation retries to their original operations after generations advance", () => {
    const driver = new LocalTransactionalNamedMemoryDriver();
    const originalRequest = {
      ...mutation(),
      value: { kind: "text" as const, v: "generation zero", trust: "settled" as const },
    };
    const original = driver.prepareStore(originalRequest);
    driver.finalize(original.operationId, { tick: 1, head: "retry-h1" });
    const forgotten = driver.prepareForget(
      mutation({ origin: { invocationCorrelation: "prompt:17", evaluationOrdinal: 1 } }),
    );
    driver.finalize(forgotten.operationId, { tick: 2, head: "retry-h2" });

    expect(driver.prepareStore({ ...originalRequest, operationId: original.operationId })).toBe(original);
    expect(driver.prepareStore(originalRequest)).toBe(original);
    expect(driver.recall({ descriptor: descriptor(), region: region() })).toMatchObject({
      generation: 0,
      state: "closed",
      cells: [],
    });

    const reopened = driver.prepareStore({
      ...mutation({ origin: { invocationCorrelation: "prompt:17", evaluationOrdinal: 2 } }),
      value: { kind: "text", v: "generation one", trust: "settled" },
    });
    driver.finalize(reopened.operationId, { tick: 3, head: "retry-h3" });
    expect(driver.prepareForget({
      ...mutation({ origin: { invocationCorrelation: "prompt:17", evaluationOrdinal: 1 } }),
      operationId: forgotten.operationId,
    })).toBe(forgotten);
    expect(driver.prepareForget(
      mutation({ origin: { invocationCorrelation: "prompt:17", evaluationOrdinal: 1 } }),
    )).toBe(forgotten);
    expect(driver.recall({ descriptor: descriptor(), region: region() })).toMatchObject({
      generation: 1,
      state: "open",
    });

    expect(() => driver.prepareStore({
      ...originalRequest,
      operationId: original.operationId,
      value: { kind: "text", v: "altered retry", trust: "settled" },
    })).toThrow(/fingerprint|conflict|operation.*id/i);
    expect(() => driver.prepareStore({
      ...originalRequest,
      value: { kind: "text", v: "altered implicit retry", trust: "settled" },
    })).toThrow(/fingerprint|conflict|operation.*id/i);
    expect(() => driver.prepareStore({
      ...originalRequest,
      region: region({ projectSubject: "project://other" }),
    })).toThrow(/fingerprint|conflict|operation.*id/i);
  });

  it("rejects fingerprint, active-stage, and ledger-binding conflicts", () => {
    const driver = new LocalTransactionalNamedMemoryDriver();
    const first = driver.prepareStore({
      ...mutation(),
      value: { kind: "text", v: "one", trust: "settled" },
    });
    expect(() => driver.prepareStore({
      ...mutation({ origin: { invocationCorrelation: "other", evaluationOrdinal: 0 } }),
      value: { kind: "text", v: "two", trust: "settled" },
    })).toThrow(/prepared|conflict/i);
    expect(() => driver.prepareStore({
      ...mutation({ region: region({ projectSubject: "project://other" }) }),
      operationId: first.operationId,
      value: { kind: "text", v: "one", trust: "settled" },
    })).toThrow(/operation.*fingerprint|operation.*id/i);

    const receipt = driver.finalize(first.operationId, binding);
    expect(() => driver.finalize(first.operationId, { tick: 42, head: "other-head" }))
      .toThrow(/binding|ledger|commit/i);
    expect(() => driver.abort(first.operationId)).toThrow(/finalized|committed/i);
    expect(driver.status(first.operationId)).toEqual({ status: "finalized", receipt });
  });

  it("recovers a lost finalize acknowledgement without duplicate mutation", () => {
    let loseAck = true;
    const driver = new LocalTransactionalNamedMemoryDriver({
      afterFinalize: () => {
        if (loseAck) {
          loseAck = false;
          throw new Error("simulated lost finalize acknowledgement");
        }
      },
    });
    const stage = driver.prepareStore({
      ...mutation(),
      value: { kind: "text", v: "committed once", trust: "settled" },
    });

    expect(() => driver.finalize(stage.operationId, binding))
      .toThrow(/lost finalize acknowledgement/);
    const reconciled = driver.reconcile(stage.operationId, binding);
    expect(reconciled.status).toBe("finalized");
    if (reconciled.status !== "finalized") throw new Error("expected finalized reconciliation");
    expect(reconciled.receipt.ledger).toEqual(binding);
    expect(driver.recall({ descriptor: descriptor(), region: region() }).values).toHaveLength(1);
    expect(driver.finalize(stage.operationId, binding)).toBe(reconciled.receipt);
  });

  it("reconciles a ledger-decided prepared mutation after driver reconstruction", () => {
    const journal = new LocalTransactionalNamedMemoryJournal();
    expect(Object.isFrozen(journal)).toBe(true);
    expect(Object.keys(journal)).toEqual([]);

    const firstDriver = new LocalTransactionalNamedMemoryDriver({ journal });
    const stage = firstDriver.prepareStore({
      ...mutation(),
      value: { kind: "text", v: "survives reconstruction", trust: "settled" },
    });

    const reconcilingDriver = new LocalTransactionalNamedMemoryDriver({ journal });
    expect(reconcilingDriver.status(stage.operationId)).toEqual({ status: "prepared", stage });
    const reconciled = reconcilingDriver.reconcile(stage.operationId, binding);
    expect(reconciled.status).toBe("finalized");

    const resumedDriver = new LocalTransactionalNamedMemoryDriver({ journal });
    expect(resumedDriver.status(stage.operationId)).toEqual(reconciled);
    expect(resumedDriver.recall({ descriptor: descriptor(), region: region() }).cells)
      .toHaveLength(1);
    expect(resumedDriver.reconcile(stage.operationId, binding)).toEqual(reconciled);
    expect(resumedDriver.recall({ descriptor: descriptor(), region: region() }).cells)
      .toHaveLength(1);
  });
});
