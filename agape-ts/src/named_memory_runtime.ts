import { createHash } from "node:crypto";
import { snapshotCanonicalPayload } from "./ledger_hash.js";
import {
  NamedMemoryCoordinator,
  NamedMemorySessionBarrier,
  type NamedMemoryDriverCallKind,
  type NamedMemoryMutationAck,
  type NamedMemoryMutationResult,
  type NamedMemoryRecallHit,
  type NamedMemoryRecallResult,
  type TransactionalNamedMemoryDriver,
} from "./named_memory_coordinator.js";
import { LocalTransactionalNamedMemoryDriver } from "./named_memory_local.js";
import {
  encodeExactValue,
  hashMemoryDescriptor,
  type ResolvedMemoryDescriptor,
} from "./named_memory.js";
import {
  Ledger,
  type LedgerEvent,
  type Value,
} from "./runtime.js";

export interface NamedMemoryRuntimeIdentity {
  projectSubject: string;
  sessionLineageId: string;
  sessionId: string;
  conversationId: string;
  user?: { issuer: string; subject: string; verified: true };
}

export type NamedMemoryDriverBinding = "local" | "markdown";
type Awaitable<T> = T | Promise<T>;

export type NamedMemoryDriverFactory = (
  binding: NamedMemoryDriverBinding,
) => Awaitable<TransactionalNamedMemoryDriver>;

interface RecordedEvent {
  tick: number;
  etype: string;
  subject: string;
  payload: unknown;
  corr: string | number | null;
  agent: string;
  head: string;
}

interface RecordedRequest {
  agentInstanceId: string;
  descriptorHash: string;
  invocationCorrelation: string;
  evaluationOrdinal: number;
  operationResultId: string;
  site: string;
  originEvidence?: {
    reactionEvent?: number;
    prompt?: { attester: string; prompt_name: string };
  };
}

export interface NamedMemoryRecordedStore extends RecordedRequest {
  kind: "store";
  valueHash: string;
  stage: NamedMemoryMutationResult["stage"];
  ack: NamedMemoryMutationAck;
  event: RecordedEvent;
}

export interface NamedMemoryRecordedForget extends RecordedRequest {
  kind: "forget";
  stage: NamedMemoryMutationResult["stage"];
  ack: NamedMemoryMutationAck;
  event: RecordedEvent;
}

export interface NamedMemoryRecordedRecall extends RecordedRequest {
  kind: "recall";
  queryHash: string;
  cap?: number;
  generation: number;
  hits: readonly NamedMemoryRecallHit[];
  event: RecordedEvent;
}

export type NamedMemoryRecordedOperation =
  | NamedMemoryRecordedStore
  | NamedMemoryRecordedForget
  | NamedMemoryRecordedRecall;

export interface NamedMemoryRuntimeRecording {
  kind: "agape-named-memory-recording";
  version: 1;
  identityCommitment: string;
  operations: readonly NamedMemoryRecordedOperation[];
}

export interface NamedMemoryRuntimeOptions {
  binding?: NamedMemoryDriverBinding;
  driver?: TransactionalNamedMemoryDriver;
  driverFactory?: NamedMemoryDriverFactory;
  replay?: NamedMemoryRuntimeRecording;
  onDriverCall?: (kind: NamedMemoryDriverCallKind) => void;
  maxRecallCap?: number;
}

export interface NamedMemoryOriginEvidence {
  reactionEvent?: number;
  prompt?: { attester: string; prompt_name: string };
}

export interface NamedMemoryOperationInput {
  agentInstanceId: string;
  descriptor: ResolvedMemoryDescriptor;
  invocationCorrelation: string;
  evaluationOrdinal: number;
  operationResultId: string;
  site: string;
  originEvidence?: NamedMemoryOriginEvidence;
}

export interface NamedMemoryStoreInput extends NamedMemoryOperationInput {
  value: Value;
}

export interface NamedMemoryRecallInput extends NamedMemoryOperationInput {
  query: string;
  cap?: number;
}

export interface NamedMemoryStoreOutput {
  stage: NamedMemoryMutationResult["stage"];
  ack: NamedMemoryMutationAck;
  event: LedgerEvent;
}

export interface NamedMemoryForgetOutput {
  stage: NamedMemoryMutationResult["stage"];
  ack: NamedMemoryMutationAck;
  event: LedgerEvent;
}

function sha256(domain: string, value: string): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function runtimeIdentityCommitment(identity: Readonly<NamedMemoryRuntimeIdentity>): string {
  const hash = createHash("sha256").update("agape.named-memory-runtime-identity.v1", "utf8");
  const fields = [
    identity.projectSubject,
    identity.sessionLineageId,
    identity.sessionId,
    identity.conversationId,
    identity.user?.issuer ?? "",
    identity.user?.subject ?? "",
    identity.user?.verified === true ? "verified" : "missing",
  ];
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return `named-memory-runtime-identity-v1:${hash.digest("hex")}`;
}

function sameOriginEvidence(
  left: NamedMemoryOriginEvidence | undefined,
  right: NamedMemoryOriginEvidence | undefined,
): boolean {
  return left?.reactionEvent === right?.reactionEvent
    && left?.prompt?.attester === right?.prompt?.attester
    && left?.prompt?.prompt_name === right?.prompt?.prompt_name;
}

function recordedEvent(event: LedgerEvent, head: string): RecordedEvent {
  return snapshotCanonicalPayload({
    tick: event.tick,
    etype: event.etype,
    subject: event.subject,
    payload: event.payload,
    corr: event.corr,
    agent: event.agent,
    head,
  }) as unknown as RecordedEvent;
}

function assertNonblank(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be nonblank`);
  }
}

function assertRequest(
  expected: NamedMemoryRecordedOperation,
  actual: NamedMemoryOperationInput,
  kind: NamedMemoryRecordedOperation["kind"],
): void {
  if (expected.kind !== kind) {
    throw new Error(`named-memory replay expected ${expected.kind}, received ${kind}`);
  }
  const descriptorHash = hashMemoryDescriptor(actual.descriptor);
  for (const [label, left, right] of [
    ["agent instance", expected.agentInstanceId, actual.agentInstanceId],
    ["descriptor", expected.descriptorHash, descriptorHash],
    ["invocation", expected.invocationCorrelation, actual.invocationCorrelation],
    ["evaluation ordinal", expected.evaluationOrdinal, actual.evaluationOrdinal],
    ["operation result", expected.operationResultId, actual.operationResultId],
    ["source site", expected.site, actual.site],
  ] as const) {
    if (left !== right) throw new Error(`named-memory replay ${label} mismatch`);
  }
  if (!sameOriginEvidence(expected.originEvidence, actual.originEvidence)) {
    throw new Error("named-memory replay origin evidence mismatch");
  }
}

function commonRequest(input: NamedMemoryOperationInput): RecordedRequest {
  return {
    agentInstanceId: input.agentInstanceId,
    descriptorHash: hashMemoryDescriptor(input.descriptor),
    invocationCorrelation: input.invocationCorrelation,
    evaluationOrdinal: input.evaluationOrdinal,
    operationResultId: input.operationResultId,
    site: input.site,
    ...(input.originEvidence === undefined ? {} : { originEvidence: input.originEvidence }),
  };
}

/**
 * One production named-memory owner for an interpreter session. It owns one
 * driver and one reconciliation barrier, then binds coordinators lazily after
 * the real Spawned tick establishes each stable instance id.
 */
export class NamedMemoryRuntime {
  readonly #ledger: Ledger;
  readonly #identity: Readonly<NamedMemoryRuntimeIdentity>;
  #driver?: TransactionalNamedMemoryDriver;
  #driverPromise?: Promise<TransactionalNamedMemoryDriver>;
  readonly #binding: NamedMemoryDriverBinding;
  readonly #driverFactory?: NamedMemoryDriverFactory;
  readonly #barrier = new NamedMemorySessionBarrier();
  readonly #onDriverCall?: (kind: NamedMemoryDriverCallKind) => void;
  readonly #maxRecallCap?: number;
  readonly #coordinators = new Map<string, Promise<NamedMemoryCoordinator>>();
  readonly #operations: NamedMemoryRecordedOperation[] = [];
  readonly #originEvidence = new Map<string, NamedMemoryOriginEvidence>();
  readonly #replay?: NamedMemoryRuntimeRecording;
  #replayCursor = 0;
  #closed = false;
  #closePromise?: Promise<void>;

  constructor(input: {
    ledger: Ledger;
    identity: Readonly<NamedMemoryRuntimeIdentity>;
    options?: NamedMemoryRuntimeOptions;
  }) {
    this.#ledger = input.ledger;
    this.#identity = input.identity;
    this.#onDriverCall = input.options?.onDriverCall;
    this.#maxRecallCap = input.options?.maxRecallCap;
    this.#binding = input.options?.binding ?? "local";
    this.#driverFactory = input.options?.driverFactory;
    this.#replay = input.options?.replay === undefined
      ? undefined
      : snapshotCanonicalPayload(input.options.replay) as unknown as NamedMemoryRuntimeRecording;
    if (this.#replay) {
      if (this.#replay.kind !== "agape-named-memory-recording" || this.#replay.version !== 1) {
        throw new Error("invalid named-memory replay recording");
      }
      if (this.#replay.identityCommitment !== runtimeIdentityCommitment(this.#identity)) {
        throw new Error("named-memory replay runtime identity mismatch");
      }
      return;
    }
    if (input.options?.driver && input.options.driverFactory) {
      throw new Error("named memory accepts a driver or driverFactory, not both");
    }
    this.#driver = input.options?.driver;
  }

  async validateDescriptors(descriptors: readonly ResolvedMemoryDescriptor[]): Promise<void> {
    this.assertOpen();
    if (this.#replay) return;
    if (descriptors.length === 0) return;
    const driver = await this.ensureDriver();
    for (const descriptor of descriptors) {
      if (!driver.capabilities.modalities.includes(descriptor.modality)) {
        throw new Error(`memory driver does not advertise modality ${descriptor.modality}`);
      }
      if (!driver.capabilities.retentions.includes(descriptor.retention)) {
        throw new Error(`memory driver does not advertise retention ${descriptor.retention}`);
      }
      for (const scope of descriptor.scopes) {
        if (!driver.capabilities.scopes.includes(scope)) {
          throw new Error(`memory driver does not advertise scope ${scope}`);
        }
      }
    }
  }

  async store(input: NamedMemoryStoreInput): Promise<NamedMemoryStoreOutput> {
    this.assertOpen();
    if (this.#replay) return this.replayStore(input);
    const result = await (await this.coordinator(input)).store(input);
    if (!result.event || !result.ack) {
      throw new Error("source memory store did not produce a committed receipt");
    }
    const output = { stage: result.stage, ack: result.ack, event: result.event };
    this.#operations.push(snapshotCanonicalPayload({
      kind: "store",
      ...commonRequest(input),
      valueHash: encodeExactValue(input.value, input.descriptor.schema).valueHash,
      stage: result.stage,
      ack: result.ack,
      event: recordedEvent(result.event, this.#ledger.head()),
    }) as unknown as NamedMemoryRecordedStore);
    if (input.originEvidence) {
      this.#originEvidence.set(result.stage.originId, snapshotCanonicalPayload(input.originEvidence) as NamedMemoryOriginEvidence);
    }
    return output;
  }

  async forget(input: NamedMemoryOperationInput): Promise<NamedMemoryForgetOutput> {
    this.assertOpen();
    if (this.#replay) return this.replayForget(input);
    const result = await (await this.coordinator(input)).forget(input);
    if (!result.event || !result.ack) {
      throw new Error("source memory forget did not produce a committed receipt");
    }
    const output = { stage: result.stage, ack: result.ack, event: result.event };
    this.#operations.push(snapshotCanonicalPayload({
      kind: "forget",
      ...commonRequest(input),
      stage: result.stage,
      ack: result.ack,
      event: recordedEvent(result.event, this.#ledger.head()),
    }) as unknown as NamedMemoryRecordedForget);
    return output;
  }

  async recall(input: NamedMemoryRecallInput): Promise<NamedMemoryRecallResult> {
    this.assertOpen();
    if (this.#replay) return this.replayRecall(input);
    const result = await (await this.coordinator(input)).recall(input);
    this.#operations.push(snapshotCanonicalPayload({
      kind: "recall",
      ...commonRequest(input),
      queryHash: sha256("agape.named-memory-query.v1", input.query),
      ...(input.cap === undefined ? {} : { cap: input.cap }),
      generation: result.generation,
      hits: result.hits,
      event: recordedEvent(result.event, this.#ledger.head()),
    }) as unknown as NamedMemoryRecordedRecall);
    return result;
  }

  recording(): NamedMemoryRuntimeRecording {
    const operations = this.#replay
      ? this.#replay.operations.slice(0, this.#replayCursor)
      : this.#operations;
    return snapshotCanonicalPayload({
      kind: "agape-named-memory-recording",
      version: 1,
      identityCommitment: runtimeIdentityCommitment(this.#identity),
      operations,
    }) as unknown as NamedMemoryRuntimeRecording;
  }

  originEvidence(originId: string): NamedMemoryOriginEvidence | undefined {
    return this.#originEvidence.get(originId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = (async () => {
      if (this.#replay && this.#replayCursor !== this.#replay.operations.length) {
        throw new Error("named-memory replay closed before its journal was fully consumed");
      }
      for (const coordinator of this.#coordinators.values()) await (await coordinator).close();
      const driver = this.#driver ?? (this.#driverPromise ? await this.#driverPromise : undefined);
      const close = (driver as { close?: () => Awaitable<void> } | undefined)?.close;
      if (close) await close.call(driver);
      this.#closed = true;
    })();
    try {
      await this.#closePromise;
    } catch (error) {
      this.#closePromise = undefined;
      throw error;
    }
  }

  private async coordinator(input: NamedMemoryOperationInput): Promise<NamedMemoryCoordinator> {
    this.assertOpen();
    const descriptorHash = hashMemoryDescriptor(input.descriptor);
    const key = `${input.agentInstanceId}\0${descriptorHash}`;
    const existing = this.#coordinators.get(key);
    if (existing) return await existing;
    const pending = (async () => new NamedMemoryCoordinator({
      descriptor: input.descriptor,
      driver: await this.ensureDriver(),
      region: {
        projectSubject: this.#identity.projectSubject,
        sessionLineageId: this.#identity.sessionLineageId,
        sessionId: this.#identity.sessionId,
        stableAgentInstanceId: input.agentInstanceId,
        user: this.#identity.user,
      },
      agentInstanceId: input.agentInstanceId,
      identityCapabilities: ["project", "user"],
      ledger: this.#ledger,
      onDriverCall: this.#onDriverCall,
      maxRecallCap: this.#maxRecallCap,
      barrier: this.#barrier,
    }))();
    this.#coordinators.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.#coordinators.get(key) === pending) this.#coordinators.delete(key);
      throw error;
    }
  }

  private replayStore(input: NamedMemoryStoreInput): NamedMemoryStoreOutput {
    const recorded = this.nextReplay("store");
    assertRequest(recorded, input, "store");
    const valueHash = encodeExactValue(input.value, input.descriptor.schema).valueHash;
    if (recorded.valueHash !== valueHash) throw new Error("named-memory replay store value mismatch");
    const event = this.appendRecorded(recorded.event);
    if (recorded.originEvidence) {
      this.#originEvidence.set(recorded.stage.originId, recorded.originEvidence);
    }
    return { stage: recorded.stage, ack: recorded.ack, event };
  }

  private replayForget(input: NamedMemoryOperationInput): NamedMemoryForgetOutput {
    const recorded = this.nextReplay("forget");
    assertRequest(recorded, input, "forget");
    const event = this.appendRecorded(recorded.event);
    return { stage: recorded.stage, ack: recorded.ack, event };
  }

  private replayRecall(input: NamedMemoryRecallInput): NamedMemoryRecallResult {
    const recorded = this.nextReplay("recall");
    assertRequest(recorded, input, "recall");
    if (recorded.queryHash !== sha256("agape.named-memory-query.v1", input.query)) {
      throw new Error("named-memory replay query mismatch");
    }
    if (recorded.cap !== input.cap) throw new Error("named-memory replay cap mismatch");
    const event = this.appendRecorded(recorded.event);
    return snapshotCanonicalPayload({
      generation: recorded.generation,
      hits: recorded.hits,
      event,
    }) as unknown as NamedMemoryRecallResult;
  }

  private nextReplay<K extends NamedMemoryRecordedOperation["kind"]>(
    kind: K,
  ): Extract<NamedMemoryRecordedOperation, { kind: K }> {
    const operation = this.#replay!.operations[this.#replayCursor++];
    if (!operation) throw new Error(`named-memory replay journal exhausted at ${kind}`);
    if (operation.kind !== kind) {
      throw new Error(`named-memory replay expected ${operation.kind}, received ${kind}`);
    }
    return operation as Extract<NamedMemoryRecordedOperation, { kind: K }>;
  }

  private appendRecorded(recorded: RecordedEvent): LedgerEvent {
    if (this.#ledger.events.length !== recorded.tick) {
      throw new Error("named-memory replay ledger tick mismatch");
    }
    const event = this.#ledger.append(
      recorded.etype,
      recorded.subject,
      recorded.payload,
      recorded.agent,
      recorded.corr,
    );
    if (this.#ledger.head() !== recorded.head) {
      throw new Error("named-memory replay ledger head mismatch");
    }
    return event;
  }

  private async ensureDriver(): Promise<TransactionalNamedMemoryDriver> {
    this.assertOpen();
    if (this.#driver) return this.#driver;
    const pending = this.#driverPromise ?? Promise.resolve(
      this.#driverFactory?.(this.#binding) ?? this.defaultDriver(this.#binding),
    );
    this.#driverPromise = pending;
    try {
      const driver = await pending;
      this.#driver = driver;
      return driver;
    } catch (error) {
      if (this.#driverPromise === pending) this.#driverPromise = undefined;
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.#closed || this.#closePromise) throw new Error("named-memory runtime is closed");
  }

  private defaultDriver(binding: NamedMemoryDriverBinding): TransactionalNamedMemoryDriver {
    if (binding === "local") return new LocalTransactionalNamedMemoryDriver();
    throw new Error("markdown named-memory driver requires a production driverFactory binding");
  }
}
