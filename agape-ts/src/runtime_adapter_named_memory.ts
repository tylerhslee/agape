import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isProxy } from "node:util/types";
import { Ledger, type LedgerEvent, type Value } from "./runtime.js";
import { canonicalLedgerHead, snapshotCanonicalPayload } from "./ledger_hash.js";
import { deriveStableAgentInstanceId } from "./interp.js";
import {
  NamedMemoryCoordinator,
  NamedMemoryReconciliationPendingError,
  NamedMemoryScopeError,
  NamedMemorySessionBarrier,
  type NamedMemoryDriverCallKind,
  type NamedMemoryMutationAck,
  type NamedMemoryRetrievalIndex,
  type NamedMemoryTraceEntry,
  type TransactionalNamedMemoryDriver,
} from "./named_memory_coordinator.js";
import {
  DurableTransactionalNamedMemoryDriver,
  LocalTransactionalNamedMemoryDriver,
  LocalTransactionalNamedMemoryJournal,
  type TransactionalNamedMemorySnapshot,
} from "./named_memory_local.js";
import {
  decodeExactValue,
  hashMemoryDescriptor,
  hashPersistedSchema,
  type PersistedSchema,
  type ResolvedMemoryDescriptor,
} from "./named_memory.js";

type Scope = "project" | "user";
type ExternalSchema =
  | { kind: "scalar"; scalar: "int" | "float" | "bool" | "text" | "null" }
  | { kind: "enum"; name: string; variants: string[] }
  | { kind: "array"; items: ExternalSchema }
  | { kind: "struct"; name: string; fields: Record<string, ExternalSchema> };
interface ExternalDescriptor {
  name: string;
  schema: ExternalSchema;
  modality: "opaque" | "episodic" | "semantic";
  scopes: Scope[];
  retention: "session" | "durable";
}
interface Program {
  programId: string;
  manifestId: string;
  agentTemplate: string;
  agentAliases: string[];
  descriptor: ExternalDescriptor;
}
interface Identity {
  projectSubject: string;
  sessionLineageId: string;
  sessionId: string;
  conversationId: string;
  user?: { issuer: string; subject: string; verified: true };
}
interface ScriptedCandidate { storeOperationId: string; score: number }
interface OpenInput {
  name: string;
  driverNamespace: string;
  driver: { kind: "local" | "markdown"; topK?: number };
  program: Program;
  identity: Identity;
  identityCapabilities: Scope[];
  record?: boolean;
  testMode?: {
    recallCandidates?: Record<string, ScriptedCandidate[]>;
    loseFinalizeAckAfterLedger?: string[];
  };
}
interface SessionAgent {
  alias: string;
  template: string;
  stableInstanceId: string;
  spawnTick: number;
}
interface PublicSession {
  sessionHandle: string;
  runtimeInstanceId: string;
  agents: Record<string, SessionAgent>;
  descriptorHash: string;
  schemaHash: string;
}
interface ExternalOperation {
  id: string;
  site: string;
  operation: "store" | "forget" | "recall";
  value?: unknown;
  query?: string;
  cap?: number;
}
interface OperationResult {
  id: string;
  ok: boolean;
  operation: "store" | "forget" | "recall";
  resultType?: string;
  values?: unknown[];
  generation?: number;
  operationId?: string;
  receipt?: LedgerEvent;
  mutationAck?: NamedMemoryMutationAck;
}
interface InvocationResult {
  ok: boolean;
  invocationId: string;
  agentInstanceId: string;
  operations: OperationResult[];
  fault?: { code: string; scope?: Scope; message?: string };
  events: LedgerEvent[];
  trace: readonly NamedMemoryTraceEntry[];
}
interface AdapterCounters {
  memoryDriverCalls: number;
  memoryMutationCalls: number;
}
interface SnapshotPayload {
  version: 1;
  bindings: {
    programId: string;
    manifestId: string;
    sessionLineageId: string;
    projectSubject: string;
    driverNamespace: string;
    descriptorHash: string;
    topologyHash: string;
    ledgerHead: string;
  };
  spawnTicks: Record<string, number>;
  events: LedgerEvent[];
  driver: TransactionalNamedMemorySnapshot;
  invocations: InvocationResult[];
  mutationAcks: NamedMemoryMutationAck[];
  invocationCache: Array<{ invocationId: string; fingerprint: string; result: InvocationResult }>;
}
interface AuthenticatedSnapshot {
  kind: "agape-ts-named-memory-snapshot";
  payload: SnapshotPayload;
  mac: string;
}
interface NamedRecording {
  kind: "agape-ts-named-memory-recording";
  events: LedgerEvent[];
  headHash: string;
  invocations: InvocationResult[];
  mutationAcks: NamedMemoryMutationAck[];
  mac: string;
}
type NamedRecordingBody = Omit<NamedRecording, "mac">;

class AdapterDriver implements TransactionalNamedMemoryDriver {
  readonly capabilities;

  constructor(
    private readonly base: LocalTransactionalNamedMemoryDriver | DurableTransactionalNamedMemoryDriver,
  ) {
    this.capabilities = base.capabilities;
  }

  prepareStore(...args: Parameters<LocalTransactionalNamedMemoryDriver["prepareStore"]>) {
    return this.base.prepareStore(...args);
  }
  prepareForget(...args: Parameters<LocalTransactionalNamedMemoryDriver["prepareForget"]>) {
    return this.base.prepareForget(...args);
  }
  finalize(...args: Parameters<LocalTransactionalNamedMemoryDriver["finalize"]>) {
    return this.base.finalize(...args);
  }
  abort(...args: Parameters<LocalTransactionalNamedMemoryDriver["abort"]>) {
    return this.base.abort(...args);
  }
  status(...args: Parameters<LocalTransactionalNamedMemoryDriver["status"]>) {
    return this.base.status(...args);
  }
  reconcile(...args: Parameters<LocalTransactionalNamedMemoryDriver["reconcile"]>) {
    return this.base.reconcile(...args);
  }
  recall(...args: Parameters<LocalTransactionalNamedMemoryDriver["recall"]>) {
    return this.base.recall(...args);
  }
  snapshot() {
    return this.base.snapshot();
  }
}

class AdapterRetrievalIndex implements NamedMemoryRetrievalIndex {
  readonly algorithm = "adapter-scripted-or-exact";
  readonly version = 1;
  readonly #canonical = new Map<string, string>();

  constructor(private readonly scripts: Record<string, ScriptedCandidate[]> = {}) {}

  register(externalId: string, canonicalId: string): void {
    this.#canonical.set(externalId, canonicalId);
  }

  rank(input: {
    cells: readonly { operationId: string; cellId: string }[];
    operationResultId: string;
  }) {
    const scripted = this.scripts[input.operationResultId];
    if (!scripted) {
      return input.cells.map((cell) => ({
        operationId: cell.operationId,
        cellId: cell.cellId,
        score: 1,
      }));
    }
    return scripted.map((candidate) => {
      const operationId = this.#canonical.get(candidate.storeOperationId);
      const cell = input.cells.find((value) => value.operationId === operationId);
      if (!operationId || !cell) throw new Error(`unknown scripted store ${candidate.storeOperationId}`);
      return { operationId, cellId: cell.cellId, score: candidate.score };
    });
  }
}

interface AgentRuntime {
  public: SessionAgent;
  coordinator: NamedMemoryCoordinator;
  retrieval: AdapterRetrievalIndex;
}
interface SessionState {
  public: PublicSession;
  input: OpenInput;
  identity: Identity;
  descriptor: ResolvedMemoryDescriptor;
  ledger: Ledger;
  driver: AdapterDriver;
  agents: Map<string, AgentRuntime>;
  invocations: InvocationResult[];
  mutationAcks: NamedMemoryMutationAck[];
  invocationCache: Map<string, { fingerprint: string; result: InvocationResult }>;
  lifecycle: "open" | "closing" | "closed";
  operationTail: Promise<void>;
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite snapshot number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(bytewise)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`unsupported snapshot value ${typeof value}`);
}

function strictDataSnapshot(
  value: unknown,
  path = "$external",
  seen: Set<object> = new Set(),
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") throw new Error(`${path} contains unsupported ${typeof value}`);
  if (isProxy(value)) throw new Error(`${path} must not contain proxies`);
  if (seen.has(value)) throw new Error(`${path} contains a cycle or repeated object reference`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${path} must be an ordinary array`);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
      throw new Error(`${path} has an invalid array length`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) throw new Error(`${path} contains symbol keys`);
    const stringKeys = ownKeys as string[];
    const expected = Array.from({ length: value.length }, (_, index) => String(index));
    if (stringKeys.length !== expected.length + 1 || !stringKeys.includes("length")
      || expected.some((key) => !stringKeys.includes(key))) {
      throw new Error(`${path} must be a dense array without extra properties`);
    }
    const result = expected.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(`${path}[${key}] must be an enumerable data property`);
      }
      return strictDataSnapshot(descriptor.value, `${path}[${key}]`, seen);
    });
    seen.delete(value);
    return Object.freeze(result);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain object`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) throw new Error(`${path} contains symbol keys`);
  const result: Record<string, unknown> = {};
  for (const key of (ownKeys as string[]).sort(bytewise)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error(`${path}.${key} is not an allowed data key`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${path}.${key} must be an enumerable defined data property`);
    }
    if (descriptor.value === undefined && key === "user" && path.endsWith(".identity")) continue;
    if (descriptor.value === undefined) throw new Error(`${path}.${key} must be a defined data property`);
    result[key] = strictDataSnapshot(descriptor.value, `${path}.${key}`, seen);
  }
  seen.delete(value);
  return Object.freeze(result);
}
function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(bytewise);
  const wanted = [...expected].sort(bytewise);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}
function toInternalSchema(schema: ExternalSchema): PersistedSchema {
  switch (schema.kind) {
    case "scalar": return { kind: "scalar", name: schema.scalar };
    case "enum": return { kind: "enum", name: schema.name, variants: [...schema.variants] };
    case "array": return { kind: "array", items: toInternalSchema(schema.items) };
    case "struct":
      return {
        kind: "struct",
        name: schema.name,
        fields: Object.entries(schema.fields).sort(([a], [b]) => bytewise(a, b))
          .map(([name, value]) => ({ name, schema: toInternalSchema(value) })),
      };
  }
}
function toDescriptor(value: ExternalDescriptor): ResolvedMemoryDescriptor {
  return {
    name: value.name,
    schema: toInternalSchema(value.schema),
    modality: value.modality,
    scopes: [...value.scopes],
    retention: value.retention,
  };
}
function toValue(value: unknown, schema: PersistedSchema): Value {
  switch (schema.kind) {
    case "scalar":
      if (schema.name === "text" && typeof value === "string") return { kind: "text", v: value, trust: "raw" };
      if (schema.name === "int" && Number.isSafeInteger(value)) return { kind: "int", v: value as number, trust: "raw" };
      if (schema.name === "float" && typeof value === "number" && Number.isFinite(value)) return { kind: "float", v: value, trust: "raw" };
      if (schema.name === "bool" && typeof value === "boolean") return { kind: "bool", v: value, trust: "raw" };
      if (schema.name === "null" && value === null) return { kind: "null", trust: "raw" };
      throw new Error(`memory value does not match ${schema.name}`);
    case "enum":
      if (typeof value !== "string" || !schema.variants.includes(value)) throw new Error(`memory value does not match ${schema.name}`);
      return { kind: "enumval", enumName: schema.name, variant: value, trust: "raw" };
    case "array":
      if (!Array.isArray(value)) throw new Error("memory value is not an array");
      return { kind: "array", items: value.map((item) => toValue(item, schema.items)), trust: "raw" };
    case "struct": {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`memory value is not ${schema.name}`);
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== schema.fields.length) throw new Error(`${schema.name} field set mismatch`);
      const fields = new Map<string, Value>();
      for (const field of schema.fields) {
        if (!Object.prototype.hasOwnProperty.call(record, field.name)) throw new Error(`missing ${field.name}`);
        fields.set(field.name, toValue(record[field.name], field.schema));
      }
      return { kind: "struct", typeName: schema.name, fields, trust: "raw" };
    }
  }
}
function fromValue(value: Value): unknown {
  switch (value.kind) {
    case "text": case "int": case "float": case "bool": return value.v;
    case "null": return null;
    case "enumval": return value.variant;
    case "array": return value.items.map(fromValue);
    case "struct": return Object.fromEntries([...value.fields].map(([key, item]) => [key, fromValue(item)]));
    default: throw new Error(`unsupported persisted value ${value.kind}`);
  }
}
function arrayType(schema: ExternalSchema): string {
  return schema.kind === "struct" || schema.kind === "enum"
    ? `${schema.name}[]`
    : schema.kind === "scalar" ? `${schema.scalar}[]` : "Array[]";
}
function faultOf(error: unknown) {
  if (error instanceof NamedMemoryScopeError) return { code: error.code, scope: error.scope, message: error.message };
  if (error instanceof NamedMemoryReconciliationPendingError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return { code: /field|match|missing|type/i.test(message) ? "TypeMismatch" : "MemoryDriverFailure", message };
}

export class NamedMemoryAdapterRuntime {
  readonly #sessions = new Map<string, SessionState>();
  readonly #secret: Buffer;
  readonly #runtimeNonce = randomBytes(16).toString("hex");
  #sequence = 0;

  constructor(
    private readonly counters: AdapterCounters,
    snapshotKey: Uint8Array,
  ) {
    this.#secret = Buffer.from(snapshotKey);
    if (this.#secret.length < 32) throw new Error("named-memory snapshot key must be at least 256 bits");
  }

  reset(): void {
    for (const state of this.#sessions.values()) state.lifecycle = "closed";
    this.#sessions.clear();
  }

  open(input: OpenInput) {
    try {
      const request = strictDataSnapshot(input, "$open") as OpenInput;
      return { ok: true, session: this.createSession(request) };
    } catch (error) {
      return { ok: false, error: { category: "ConfigError", message: error instanceof Error ? error.message : String(error) } };
    }
  }

  async invoke(input: {
    sessionHandle: string;
    agentInstanceId: string;
    invocationId: string;
    operations: ExternalOperation[];
  }): Promise<InvocationResult> {
    const request = strictDataSnapshot(input, "$invoke") as typeof input;
    const state = this.session(request.sessionHandle);
    if (state.lifecycle !== "open") throw new Error("named-memory session is closing or closed");
    return this.enqueue(state, () => this.invokeNow(state, request));
  }

  private async invokeNow(state: SessionState, input: {
    sessionHandle: string;
    agentInstanceId: string;
    invocationId: string;
    operations: ExternalOperation[];
  }): Promise<InvocationResult> {
    if (new Set(input.operations.map((operation) => operation.id)).size !== input.operations.length) {
      throw new Error("named-memory invocation operation ids must be unique");
    }
    const fingerprint = this.mac("invocation-fingerprint", {
      agentInstanceId: input.agentInstanceId,
      operations: input.operations,
    });
    const cached = state.invocationCache.get(input.invocationId);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new Error("named-memory invocation id was reused with a conflicting request");
      }
      return cached.result;
    }
    const agent = [...state.agents.values()].find((value) => value.public.stableInstanceId === input.agentInstanceId);
    if (!agent) throw new Error("unknown named-memory agent instance");
    const eventStart = state.ledger.events.length;
    const traceStart = agent.coordinator.traceLength;
    const results: OperationResult[] = [];
    try {
      for (const value of state.agents.values()) await value.coordinator.reconcilePending();
      for (let ordinal = 0; ordinal < input.operations.length; ordinal += 1) {
        const operation = input.operations[ordinal]!;
        if (operation.operation === "store") {
          const result = await agent.coordinator.store({
            invocationCorrelation: input.invocationId,
            evaluationOrdinal: ordinal,
            operationResultId: operation.id,
            site: operation.site,
            value: toValue(operation.value, state.descriptor.schema),
            loseFinalizeAck: state.input.testMode?.loseFinalizeAckAfterLedger?.includes(operation.id),
          });
          agent.retrieval.register(operation.id, result.stage.operationId);
          if (result.ack) state.mutationAcks.push(result.ack);
          results.push({
            id: operation.id, ok: true, operation: "store", generation: result.stage.generation,
            operationId: result.stage.operationId, receipt: result.event, mutationAck: result.ack,
          });
        } else if (operation.operation === "forget") {
          const result = await agent.coordinator.forget({
            invocationCorrelation: input.invocationId,
            evaluationOrdinal: ordinal,
            operationResultId: operation.id,
            site: operation.site,
            loseFinalizeAck: state.input.testMode?.loseFinalizeAckAfterLedger?.includes(operation.id),
          });
          if (result.ack) state.mutationAcks.push(result.ack);
          results.push({
            id: operation.id, ok: true, operation: "forget", generation: result.stage.generation,
            operationId: result.stage.operationId, receipt: result.event, mutationAck: result.ack,
          });
        } else {
          const recalled = await agent.coordinator.recall({
            invocationCorrelation: input.invocationId,
            operationResultId: operation.id,
            query: operation.query ?? "",
            cap: operation.cap,
          });
          results.push({
            id: operation.id, ok: true, operation: "recall", resultType: arrayType(state.input.program.descriptor.schema),
            generation: recalled.generation, receipt: recalled.event,
            values: recalled.hits.map((hit) => ({
              value: fromValue(decodeExactValue(hit.cell.value, state.descriptor.schema)),
              schema: state.input.program.descriptor.schema,
              schemaHash: state.public.schemaHash,
              descriptorHash: state.public.descriptorHash,
              cellId: hit.cellId,
              score: hit.score,
              originRef: hit.cell.originId,
              generation: hit.generation,
              taint: "raw",
            })),
          });
        }
      }
      const invocation = strictDataSnapshot({
        ok: true, invocationId: input.invocationId, agentInstanceId: input.agentInstanceId,
        operations: results, events: state.ledger.events.slice(eventStart),
        trace: agent.coordinator.traceSince(traceStart),
      }, "$invocation.result") as InvocationResult;
      state.invocations.push(invocation);
      state.invocationCache.set(input.invocationId, { fingerprint, result: invocation });
      return invocation;
    } catch (error) {
      const fault = faultOf(error);
      state.ledger.append("AgentCrashed", input.agentInstanceId, {
        code: fault.code, ...("scope" in fault ? { scope: fault.scope } : {}),
      }, input.agentInstanceId, null);
      const invocation = strictDataSnapshot({
        ok: false, invocationId: input.invocationId, agentInstanceId: input.agentInstanceId,
        operations: results, fault, events: state.ledger.events.slice(eventStart),
        trace: agent.coordinator.traceSince(traceStart),
      }, "$invocation.result") as InvocationResult;
      state.invocations.push(invocation);
      state.invocationCache.set(input.invocationId, { fingerprint, result: invocation });
      return invocation;
    }
  }

  async close(input: { sessionHandle: string }) {
    const request = strictDataSnapshot(input, "$close") as typeof input;
    const state = this.session(request.sessionHandle);
    if (state.lifecycle !== "open") throw new Error("named-memory session is closing or closed");
    state.lifecycle = "closing";
    return this.enqueue(state, () => this.closeNow(state, request));
  }

  private async closeNow(state: SessionState, input: { sessionHandle: string }) {
    for (const value of state.agents.values()) await value.coordinator.reconcilePending();
    const first = state.agents.values().next().value as AgentRuntime;
    const driver = await first.coordinator.snapshot();
    const headHash = state.ledger.head();
    const payload: SnapshotPayload = {
      version: 1,
      bindings: {
        programId: this.mac("binding/program-id", state.input.program.programId),
        manifestId: this.mac("binding/manifest-id", state.input.program.manifestId),
        sessionLineageId: this.mac("binding/session-lineage", state.identity.sessionLineageId),
        projectSubject: this.mac("binding/project-subject", state.identity.projectSubject),
        driverNamespace: this.mac("binding/driver-namespace", state.input.driverNamespace),
        descriptorHash: state.public.descriptorHash,
        topologyHash: this.topologyHash(state.input),
        ledgerHead: headHash,
      },
      spawnTicks: Object.fromEntries([...state.agents].map(([key, value]) => [key, value.public.spawnTick])),
      events: [...state.ledger.events],
      driver,
      invocations: [...state.invocations],
      mutationAcks: [...state.mutationAcks],
      invocationCache: [...state.invocationCache].map(([invocationId, value]) => ({ invocationId, ...value })),
    };
    const snapshot = this.sign(payload);
    for (const value of state.agents.values()) await value.coordinator.close();
    this.#sessions.delete(input.sessionHandle);
    state.lifecycle = "closed";
    const recording: NamedRecording | undefined = state.input.record ? this.signRecording({
      kind: "agape-ts-named-memory-recording",
      events: [...state.ledger.events],
      headHash,
      invocations: [...state.invocations],
      mutationAcks: [...state.mutationAcks],
    }) : undefined;
    return {
      ok: true, destroyed: true, closedSessionHandle: state.public.sessionHandle,
      closedRuntimeInstanceId: state.public.runtimeInstanceId,
      agentInstanceIds: Object.fromEntries([...state.agents].map(([key, value]) => [key, value.public.stableInstanceId])),
      headHash, snapshot, ...(recording ? { recording } : {}),
      invocations: [...state.invocations], mutationAcks: [...state.mutationAcks],
    };
  }

  async resume(input: OpenInput & { snapshot: unknown }) {
    const request = strictDataSnapshot(input, "$resume") as OpenInput & { snapshot: unknown };
    if (request.driver.kind !== "markdown") {
      return { ok: false, error: { category: "ConfigError", message: "resume requires a durable markdown driver" } };
    }
    input = request;
    const verified = this.verify(request.snapshot);
    if (!verified.ok) return verified.result;
    const payload = verified.payload;
    const checks: Array<[keyof SnapshotPayload["bindings"], string]> = [
      ["programId", this.mac("binding/program-id", input.program.programId)],
      ["manifestId", this.mac("binding/manifest-id", input.program.manifestId)],
      ["sessionLineageId", this.mac("binding/session-lineage", input.identity.sessionLineageId)],
      ["projectSubject", this.mac("binding/project-subject", input.identity.projectSubject)],
      ["driverNamespace", this.mac("binding/driver-namespace", input.driverNamespace)],
      ["descriptorHash", hashMemoryDescriptor(toDescriptor(input.program.descriptor))],
      ["topologyHash", this.topologyHash(input)],
    ];
    for (const [binding, expected] of checks) {
      if (payload.bindings[binding] !== expected) {
        return { ok: false, fault: { code: "SnapshotBindingMismatch", binding: binding === "descriptorHash" ? "programId" : binding } };
      }
    }
    if (canonicalLedgerHead(payload.events) !== payload.bindings.ledgerHead) {
      return { ok: false, fault: { code: "SnapshotBindingMismatch", binding: "ledgerHead" } };
    }
    try {
      const session = this.createSession(input, {
        driver: payload.driver,
        spawnTicks: payload.spawnTicks,
        events: payload.events,
        ledgerHead: payload.bindings.ledgerHead,
        invocations: payload.invocations,
        mutationAcks: payload.mutationAcks,
        invocationCache: payload.invocationCache,
      });
      const state = this.session(session.sessionHandle);
      for (const value of state.agents.values()) await value.coordinator.markResumed();
      return { ok: true, session };
    } catch (error) {
      return { ok: false, error: { category: "ConfigError", message: error instanceof Error ? error.message : String(error) } };
    }
  }

  replay(recording: unknown) {
    if (!recording || typeof recording !== "object") return undefined;
    const value = strictDataSnapshot(recording, "$recording") as NamedRecording;
    if (value.kind !== "agape-ts-named-memory-recording") return undefined;
    exactKeys(value, ["events", "headHash", "invocations", "kind", "mac", "mutationAcks"], "named-memory recording");
    if (typeof value.mac !== "string" || !/^[0-9a-f]{64}$/.test(value.mac)) {
      throw new Error("named-memory recording authentication failed");
    }
    const body: NamedRecordingBody = {
      kind: value.kind,
      events: value.events,
      headHash: value.headHash,
      invocations: value.invocations,
      mutationAcks: value.mutationAcks,
    };
    exactKeys(body, ["events", "headHash", "invocations", "kind", "mutationAcks"], "named-memory recording body");
    const expected = Buffer.from(this.mac("recording", body), "hex");
    const supplied = Buffer.from(value.mac, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new Error("named-memory recording authentication failed");
    }
    const headHash = canonicalLedgerHead(value.events);
    if (headHash !== value.headHash) throw new Error("named-memory recording head mismatch");
    Ledger.restore(value.events);
    this.validateEvidence(value.events, value.invocations, value.mutationAcks);
    return {
      ok: true, head: value.events.length, headHash,
      events: value.events,
      namedMemory: {
        invocations: value.invocations,
        mutationAcks: value.mutationAcks,
      },
    };
  }

  private createSession(
    input: OpenInput,
    restore?: {
      driver: TransactionalNamedMemorySnapshot;
      spawnTicks: Record<string, number>;
      events: LedgerEvent[];
      ledgerHead: string;
      invocations: InvocationResult[];
      mutationAcks: NamedMemoryMutationAck[];
      invocationCache: Array<{ invocationId: string; fingerprint: string; result: InvocationResult }>;
    },
  ): PublicSession {
    if (!input.program.agentAliases.length || new Set(input.program.agentAliases).size !== input.program.agentAliases.length) {
      throw new Error("named-memory agents must be nonempty and unique");
    }
    const descriptor = toDescriptor(input.program.descriptor);
    const journal = new LocalTransactionalNamedMemoryJournal(restore?.driver);
    const base = input.driver.kind === "local"
      ? new LocalTransactionalNamedMemoryDriver({ journal })
      : new DurableTransactionalNamedMemoryDriver({ journal });
    const driver = new AdapterDriver(base);
    const ledger = restore ? Ledger.restore(restore.events) : new Ledger();
    if (restore && ledger.head() !== restore.ledgerHead) throw new Error("restored ledger head mismatch");
    const barrier = new NamedMemorySessionBarrier();
    const publicAgents: Record<string, SessionAgent> = {};
    const agents = new Map<string, AgentRuntime>();
    for (let index = 0; index < input.program.agentAliases.length; index += 1) {
      const alias = input.program.agentAliases[index]!;
      const spawnTick = restore?.spawnTicks[alias] ?? index;
      if (spawnTick !== index) throw new Error("restored Spawned tick mismatch");
      const stableInstanceId = deriveStableAgentInstanceId(input.identity.projectSubject, input.identity.sessionLineageId, spawnTick);
      const item = { alias, template: input.program.agentTemplate, stableInstanceId, spawnTick };
      const retrieval = new AdapterRetrievalIndex(input.testMode?.recallCandidates);
      const coordinator = new NamedMemoryCoordinator({
        descriptor, driver,
        region: {
          projectSubject: input.identity.projectSubject,
          sessionLineageId: input.identity.sessionLineageId,
          sessionId: input.identity.sessionId,
          stableAgentInstanceId: stableInstanceId,
          user: input.identity.user,
        },
        agentInstanceId: stableInstanceId,
        identityCapabilities: input.identityCapabilities,
        ledger, barrier, maxRecallCap: input.driver.topK,
        retrievalIndex: retrieval,
        onDriverCall: (kind: NamedMemoryDriverCallKind) => {
          this.counters.memoryDriverCalls += 1;
          if (kind === "mutation") this.counters.memoryMutationCalls += 1;
        },
      });
      publicAgents[alias] = item;
      agents.set(alias, { public: item, coordinator, retrieval });
    }
    if (!restore) {
      for (const alias of input.program.agentAliases) {
        const value = agents.get(alias)!;
        const event = ledger.append("Spawned", value.public.stableInstanceId, {
          alias, template: input.program.agentTemplate,
        }, value.public.stableInstanceId, null);
        if (event.tick !== value.public.spawnTick) throw new Error("Spawned tick mismatch");
      }
    }
    const publicSession = {
      sessionHandle: `named-memory-session-${this.#runtimeNonce}-${++this.#sequence}`,
      runtimeInstanceId: `named-memory-runtime-${this.#runtimeNonce}-${++this.#sequence}`,
      agents: publicAgents,
      descriptorHash: hashMemoryDescriptor(descriptor),
      schemaHash: hashPersistedSchema(descriptor.schema),
    };
    const invocationCache = new Map<string, { fingerprint: string; result: InvocationResult }>();
    for (const entry of restore?.invocationCache ?? []) {
      if (invocationCache.has(entry.invocationId) || entry.result.invocationId !== entry.invocationId
        || !/^[0-9a-f]{64}$/.test(entry.fingerprint)) {
        throw new Error("restored invocation cache is invalid");
      }
      invocationCache.set(entry.invocationId, { fingerprint: entry.fingerprint, result: entry.result });
    }
    this.#sessions.set(publicSession.sessionHandle, {
      public: publicSession,
      input: snapshotCanonicalPayload(input) as OpenInput,
      identity: snapshotCanonicalPayload(input.identity) as Identity,
      descriptor, ledger, driver, agents,
      invocations: [...(restore?.invocations ?? [])],
      mutationAcks: [...(restore?.mutationAcks ?? [])],
      invocationCache,
      lifecycle: "open",
      operationTail: Promise.resolve(),
    });
    return publicSession;
  }

  private mac(domain: string, value: unknown): string {
    return createHmac("sha256", this.#secret)
      .update(`agape/named-memory/${domain}/v1\0`)
      .update(canonicalJson(value))
      .digest("hex");
  }

  private topologyHash(input: OpenInput): string {
    return this.mac("topology", {
      programId: input.program.programId,
      manifestId: input.program.manifestId,
      agentTemplate: input.program.agentTemplate,
      agentAliases: input.program.agentAliases,
      descriptorHash: hashMemoryDescriptor(toDescriptor(input.program.descriptor)),
      driver: { kind: input.driver.kind, topK: input.driver.topK ?? 10 },
      retrieval: { algorithm: "adapter-scripted-or-exact", version: 1 },
    });
  }

  private signRecording(body: NamedRecordingBody): NamedRecording {
    const frozen = strictDataSnapshot(body, "$recording.body") as NamedRecordingBody;
    exactKeys(frozen, ["events", "headHash", "invocations", "kind", "mutationAcks"], "named-memory recording body");
    const outer = strictDataSnapshot({
      ...frozen,
      mac: this.mac("recording", frozen),
    }, "$recording") as NamedRecording;
    exactKeys(outer, ["events", "headHash", "invocations", "kind", "mac", "mutationAcks"], "named-memory recording");
    return outer;
  }

  private validateSnapshotPayload(payload: SnapshotPayload): void {
    exactKeys(payload, [
      "bindings", "driver", "events", "invocationCache", "invocations",
      "mutationAcks", "spawnTicks", "version",
    ], "named-memory snapshot payload");
    exactKeys(payload.bindings, [
      "descriptorHash", "driverNamespace", "ledgerHead", "manifestId", "programId",
      "projectSubject", "sessionLineageId", "topologyHash",
    ], "named-memory snapshot bindings");
  }

  private sign(payload: SnapshotPayload): AuthenticatedSnapshot {
    const frozen = strictDataSnapshot(payload, "$snapshot.payload") as SnapshotPayload;
    this.validateSnapshotPayload(frozen);
    const outer = strictDataSnapshot({
      kind: "agape-ts-named-memory-snapshot",
      payload: frozen,
      mac: this.mac("snapshot", frozen),
    }, "$snapshot") as AuthenticatedSnapshot;
    exactKeys(outer, ["kind", "mac", "payload"], "named-memory snapshot");
    return outer;
  }

  private verify(snapshot: unknown):
    | { ok: true; payload: SnapshotPayload }
    | { ok: false; result: { ok: false; fault: { code: string; message?: string } } } {
    try {
      const value = strictDataSnapshot(snapshot, "$snapshot") as AuthenticatedSnapshot;
      exactKeys(value, ["kind", "mac", "payload"], "named-memory snapshot");
      if (value.kind !== "agape-ts-named-memory-snapshot") throw new Error("invalid snapshot");
      this.validateSnapshotPayload(value.payload);
      const expected = Buffer.from(this.mac("snapshot", value.payload), "hex");
      if (typeof value.mac !== "string" || !/^[0-9a-f]{64}$/.test(value.mac)) {
        throw new Error("snapshot authentication failed");
      }
      const supplied = Buffer.from(value.mac, "hex");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("snapshot authentication failed");
      return { ok: true, payload: value.payload };
    } catch (error) {
      return { ok: false, result: { ok: false, fault: {
        code: "SnapshotAuthenticationFailed", message: error instanceof Error ? error.message : String(error),
      } } };
    }
  }

  private validateEvidence(
    events: readonly LedgerEvent[],
    invocations: readonly InvocationResult[],
    mutationAcks: readonly NamedMemoryMutationAck[],
  ): void {
    const eventByTick = new Map(events.map((event) => [event.tick, event]));
    const invocationIds = new Set<string>();
    const claimedTicks = new Set<number>();
    const receiptTicks = new Set<number>();
    const expectedAcks = new Map<string, number>();
    for (const invocation of invocations) {
      if (!invocation || typeof invocation !== "object" || typeof invocation.invocationId !== "string"
        || typeof invocation.agentInstanceId !== "string" || typeof invocation.ok !== "boolean"
        || !Array.isArray(invocation.operations) || !Array.isArray(invocation.events)
        || invocationIds.has(invocation.invocationId)) {
        throw new Error("named-memory recording invocation evidence is invalid");
      }
      invocationIds.add(invocation.invocationId);
      let priorTick: number | undefined;
      const sliceTicks = new Set<number>();
      const memoryEventTicks = new Set<number>();
      const invocationReceiptTicks = new Set<number>();
      for (const event of invocation.events) {
        const canonical = eventByTick.get(event.tick);
        if (!canonical || canonicalJson(canonical) !== canonicalJson(event)
          || event.agent !== invocation.agentInstanceId
          || claimedTicks.has(event.tick)
          || (priorTick !== undefined && event.tick !== priorTick + 1)) {
          throw new Error("named-memory recording event evidence is invalid");
        }
        if (["Internalized", "Forgotten", "MemoryConsulted"].includes(event.etype)) {
          memoryEventTicks.add(event.tick);
        }
        claimedTicks.add(event.tick);
        sliceTicks.add(event.tick);
        priorTick = event.tick;
      }
      const crashedEvents = invocation.events.filter((event) => event.etype === "AgentCrashed");
      if (invocation.ok) {
        if (invocation.fault !== undefined || crashedEvents.length !== 0) {
          throw new Error("named-memory recording invocation status evidence is invalid");
        }
      } else {
        const fault = invocation.fault;
        const crash = crashedEvents[0];
        const faultIsValid = !!fault && typeof fault === "object" && !Array.isArray(fault)
          && typeof fault.code === "string"
          && (fault.scope === undefined || fault.scope === "project" || fault.scope === "user")
          && (fault.message === undefined || typeof fault.message === "string")
          && Object.keys(fault).every((key) => ["code", "scope", "message"].includes(key));
        const crashPayload = crash?.payload;
        const crashPayloadIsPlain = !!crashPayload && typeof crashPayload === "object"
          && !Array.isArray(crashPayload)
          && (Object.getPrototypeOf(crashPayload) === Object.prototype
            || Object.getPrototypeOf(crashPayload) === null);
        const crashRecord = crashPayloadIsPlain
          ? crashPayload as Record<string, unknown>
          : undefined;
        const expectedCrashKeys = fault?.scope === undefined ? ["code"] : ["code", "scope"];
        const crashKeys = crashRecord ? Object.keys(crashRecord).sort(bytewise) : [];
        if (!faultIsValid || crashedEvents.length !== 1
          || invocation.events.at(-1)?.etype !== "AgentCrashed"
          || !crashRecord
          || crashRecord.code !== fault!.code
          || crashRecord.scope !== fault!.scope
          || crashKeys.length !== expectedCrashKeys.length
          || crashKeys.some((key, index) => key !== expectedCrashKeys[index])) {
          throw new Error("named-memory recording invocation status evidence is invalid");
        }
      }
      const operationIds = new Set<string>();
      for (const operation of invocation.operations) {
        if (!operation || typeof operation !== "object" || typeof operation.id !== "string"
          || operationIds.has(operation.id)
          || operation.ok !== true
          || !["store", "forget", "recall"].includes(operation.operation)) {
          throw new Error("named-memory recording operation evidence is invalid");
        }
        operationIds.add(operation.id);
        const isMutation = operation.operation === "store" || operation.operation === "forget";
        let receiptPayload: Record<string, unknown> | undefined;
        const expectedEtype = operation.operation === "store" ? "Internalized"
          : operation.operation === "forget" ? "Forgotten" : "MemoryConsulted";
        if (operation.receipt) {
          const canonical = eventByTick.get(operation.receipt.tick);
          if (!canonical || canonicalJson(canonical) !== canonicalJson(operation.receipt)
            || operation.receipt.etype !== expectedEtype
            || operation.receipt.agent !== invocation.agentInstanceId
            || !sliceTicks.has(operation.receipt.tick)
            || receiptTicks.has(operation.receipt.tick)) {
            throw new Error("named-memory recording receipt evidence is invalid");
          }
          receiptTicks.add(operation.receipt.tick);
          invocationReceiptTicks.add(operation.receipt.tick);
          if (operation.receipt.payload && typeof operation.receipt.payload === "object"
            && !Array.isArray(operation.receipt.payload)) {
            receiptPayload = operation.receipt.payload as Record<string, unknown>;
          }
          if (isMutation && (!receiptPayload || typeof operation.operationId !== "string"
            || receiptPayload.operation_id !== operation.operationId
            || receiptPayload.operation !== operation.operation)) {
            throw new Error("named-memory recording receipt operation binding is invalid");
          }
        } else {
          throw new Error("named-memory recording operation is missing its receipt");
        }
        if (isMutation && !operation.mutationAck) {
          throw new Error("named-memory recording mutation is missing its operation ack");
        }
        if (!isMutation && operation.mutationAck) {
          throw new Error("named-memory recording recall has unexpected mutation ack evidence");
        }
        if (operation.mutationAck && receiptPayload) {
          const receiptEffects = receiptPayload.effects;
          const expectedEffects = receiptEffects && typeof receiptEffects === "object" && !Array.isArray(receiptEffects)
            ? {
                ...(receiptEffects as Record<string, unknown>),
                ...(typeof receiptPayload.already_forgotten === "boolean"
                  ? { already_forgotten: receiptPayload.already_forgotten }
                  : {}),
              }
            : undefined;
          if (operation.mutationAck.operation !== operation.operation
            || operation.mutationAck.operationId !== operation.operationId
            || operation.mutationAck.generation !== receiptPayload.generation
            || expectedEffects === undefined
            || canonicalJson(operation.mutationAck.effects) !== canonicalJson(expectedEffects)
            || canonicalJson(operation.mutationAck.refs) !== canonicalJson(receiptPayload.refs)) {
            throw new Error("named-memory recording operation ack evidence is invalid");
          }
          const key = canonicalJson(operation.mutationAck);
          expectedAcks.set(key, (expectedAcks.get(key) ?? 0) + 1);
        }
      }
      if (memoryEventTicks.size !== invocationReceiptTicks.size
        || [...memoryEventTicks].some((tick) => !invocationReceiptTicks.has(tick))) {
        throw new Error("named-memory recording has unclaimed memory event evidence");
      }
    }
    let invocationEvidenceStarted = false;
    for (const event of events) {
      if (claimedTicks.has(event.tick)) {
        invocationEvidenceStarted = true;
      } else if (invocationEvidenceStarted || event.etype !== "Spawned") {
        throw new Error("named-memory recording invocation slices are not contiguous");
      }
    }
    const actualAcks = new Map<string, number>();
    for (const ack of mutationAcks) {
      const key = canonicalJson(ack);
      actualAcks.set(key, (actualAcks.get(key) ?? 0) + 1);
    }
    if (expectedAcks.size !== actualAcks.size
      || [...expectedAcks].some(([key, count]) => count !== 1 || actualAcks.get(key) !== 1)) {
      throw new Error("named-memory recording mutation ack evidence is invalid");
    }
  }

  private enqueue<T>(state: SessionState, work: () => Promise<T>): Promise<T> {
    const run = state.operationTail.then(work, work);
    state.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private session(handle: string): SessionState {
    const value = this.#sessions.get(handle);
    if (!value) throw new Error("unknown or destroyed named-memory session");
    return value;
  }
}
