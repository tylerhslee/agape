import { createHash } from "node:crypto";
import {
  Ledger,
  type LedgerEvent,
  type Value,
} from "./runtime.js";
import { snapshotCanonicalPayload } from "./ledger_hash.js";
import {
  type LedgerCommitBinding,
  type NamedMemoryCell,
  type NamedMemoryMutationContext,
  type NamedMemoryMutationReceipt,
  type NamedMemoryOperationStatus,
  type NamedMemoryRecall,
  type PreparedNamedMemoryMutation,
  type TransactionalNamedMemorySnapshot,
} from "./named_memory_local.js";
import {
  deriveMemoryRegionKey,
  hashMemoryDescriptor,
  hashPersistedSchema,
  hashResolvedMemoryScope,
  type MemoryRegionKeyInput,
  type ResolvedMemoryDescriptor,
} from "./named_memory.js";

export type NamedMemoryDriverCallKind = "read" | "mutation";

export interface NamedMemoryTraceEntry {
  sequence: number;
  phase: "prepare" | "ledger-commit" | "finalize" | "reconcile" | "recall" | "close" | "resume";
  operationId?: string;
  operationResultId?: string;
  etype?: string;
}

export interface NamedMemoryMutationAck {
  operationId: string;
  operation: "store" | "forget";
  generation: number;
  effects: Readonly<Record<string, number | boolean | string>>;
  refs: readonly string[];
}

export interface NamedMemoryRankCandidate {
  operationId: string;
  cellId: string;
  score: number;
}

export interface NamedMemoryRetrievalIndex {
  readonly algorithm: string;
  readonly version: number;
  rank(input: {
    cells: readonly NamedMemoryCell[];
    query: string;
    operationResultId: string;
  }): readonly NamedMemoryRankCandidate[] | Promise<readonly NamedMemoryRankCandidate[]>;
}

const EXACT_RETRIEVAL_INDEX: NamedMemoryRetrievalIndex = Object.freeze({
  algorithm: "exact-current-generation",
  version: 1,
  rank(input: { cells: readonly NamedMemoryCell[] }) {
    return input.cells.map((cell) => ({
      operationId: cell.operationId,
      cellId: cell.cellId,
      score: 1,
    }));
  },
});

export interface NamedMemoryRecallHit {
  cell: NamedMemoryCell;
  cellId: string;
  score: number;
  generation: number;
}

export interface NamedMemoryMutationResult {
  stage: PreparedNamedMemoryMutation;
  receipt?: NamedMemoryMutationReceipt;
  event?: LedgerEvent;
  ack?: NamedMemoryMutationAck;
  pending: boolean;
  reused: boolean;
}

export interface NamedMemoryRecallResult {
  generation: number;
  hits: readonly NamedMemoryRecallHit[];
  event: LedgerEvent;
}

type Awaitable<T> = T | Promise<T>;

export interface TransactionalNamedMemoryDriver {
  readonly capabilities: {
    readonly modalities: readonly ("opaque" | "episodic" | "semantic")[];
    readonly retentions: readonly ("session" | "durable")[];
    readonly scopes: readonly ("project" | "user")[];
    readonly exactEncoding: boolean;
    readonly idempotentReconciliation: boolean;
  };
  prepareStore(request: NamedMemoryMutationContext & {
    value: Value;
    operationId?: string;
  }): Awaitable<PreparedNamedMemoryMutation>;
  prepareForget(request: NamedMemoryMutationContext & {
    operationId?: string;
  }): Awaitable<PreparedNamedMemoryMutation>;
  finalize(
    operationId: string,
    binding: LedgerCommitBinding,
  ): Awaitable<NamedMemoryMutationReceipt>;
  abort(operationId: string): Awaitable<NamedMemoryOperationStatus>;
  status(operationId: string): Awaitable<NamedMemoryOperationStatus>;
  reconcile(
    operationId: string,
    binding?: LedgerCommitBinding,
  ): Awaitable<NamedMemoryOperationStatus>;
  recall(input: {
    descriptor: ResolvedMemoryDescriptor;
    region: Omit<MemoryRegionKeyInput, "descriptor">;
  }): Awaitable<NamedMemoryRecall>;
  snapshot(): Awaitable<TransactionalNamedMemorySnapshot>;
}

export class NamedMemorySessionBarrier {
  readonly #members = new Set<() => Promise<void>>();

  register(reconcile: () => Promise<void>): void {
    this.#members.add(reconcile);
  }

  async reconcileAll(): Promise<void> {
    for (const reconcile of this.#members) await reconcile();
  }
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function opaqueCorrelation(correlation: string): string {
  return `memory-correlation-v1:${createHash("sha256")
    .update("agape.named-memory-correlation.v1", "utf8")
    .update("\0", "utf8")
    .update(correlation, "utf8")
    .digest("hex")}`;
}

function publicMutationPayload(
  descriptorName: string,
  stage: PreparedNamedMemoryMutation,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    operation_id: stage.operationId,
    operation: stage.kind,
    ...(stage.kind === "store" ? { write_source: "explicit_store" } : {}),
    region: descriptorName,
    descriptor_hash: stage.descriptorHash,
    schema_hash: stage.schemaHash,
    scope_hash: stage.scopeHash,
    generation: stage.generation,
    origin_ref: stage.originId,
    ...(stage.valueHash === undefined ? {} : { value_hash: stage.valueHash }),
    effects: Object.freeze({
      upserted: stage.effects.cells.upserted,
      tombstoned: stage.effects.cells.tombstoned,
    }),
    refs: Object.freeze(Object.values(stage.refs)),
    ...(stage.alreadyForgotten === undefined
      ? {}
      : { already_forgotten: stage.alreadyForgotten }),
  });
}

function mutationAck(receipt: NamedMemoryMutationReceipt): NamedMemoryMutationAck {
  return Object.freeze({
    operationId: receipt.operationId,
    operation: receipt.kind,
    generation: receipt.generation,
    effects: Object.freeze({
      upserted: receipt.effects.cells.upserted,
      tombstoned: receipt.effects.cells.tombstoned,
      ...(receipt.alreadyForgotten === undefined
        ? {}
        : { already_forgotten: receipt.alreadyForgotten }),
    }),
    refs: Object.freeze(Object.values(receipt.refs)),
  });
}

export class NamedMemoryCoordinator {
  readonly descriptor: ResolvedMemoryDescriptor;
  readonly descriptorHash: string;
  readonly schemaHash: string;

  readonly #driver: TransactionalNamedMemoryDriver;
  readonly #region: Omit<MemoryRegionKeyInput, "descriptor">;
  readonly #agentInstanceId: string;
  readonly #ledger: Ledger;
  readonly #onDriverCall?: (kind: NamedMemoryDriverCallKind) => void;
  readonly #maxRecallCap: number;
  readonly #retrievalIndex: NamedMemoryRetrievalIndex;
  readonly #barrier: NamedMemorySessionBarrier;
  readonly #trace: NamedMemoryTraceEntry[] = [];
  readonly #pending = new Map<string, LedgerCommitBinding>();
  #sequence = 0;
  #closed = false;

  constructor(input: {
    descriptor: ResolvedMemoryDescriptor;
    driver: TransactionalNamedMemoryDriver;
    region: Omit<MemoryRegionKeyInput, "descriptor">;
    agentInstanceId: string;
    identityCapabilities: readonly ("project" | "user")[];
    ledger: Ledger;
    onDriverCall?: (kind: NamedMemoryDriverCallKind) => void;
    maxRecallCap?: number;
    retrievalIndex?: NamedMemoryRetrievalIndex;
    barrier?: NamedMemorySessionBarrier;
  }) {
    this.assertPreflight(input.descriptor, input.driver, input.identityCapabilities);
    for (const [label, value] of [
      ["project subject", input.region.projectSubject],
      ["session lineage", input.region.sessionLineageId],
      ["session id", input.region.sessionId],
      ["stable agent instance", input.region.stableAgentInstanceId],
    ] as const) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`named-memory ${label} must be nonblank`);
      }
    }
    if (input.region.user !== undefined && (
      input.region.user.verified !== true
      || input.region.user.issuer.trim().length === 0
      || input.region.user.subject.trim().length === 0
    )) {
      throw new Error("supplied named-memory user identity must be verified and nonblank");
    }
    if (input.agentInstanceId !== input.region.stableAgentInstanceId) {
      throw new Error("named-memory coordinator agent instance does not match its resolved region");
    }
    if (
      input.maxRecallCap !== undefined
      && (!Number.isSafeInteger(input.maxRecallCap) || input.maxRecallCap < 0)
    ) {
      throw new Error("named-memory maximum recall cap must be a nonnegative safe integer");
    }
    this.descriptor = snapshotCanonicalPayload(input.descriptor) as ResolvedMemoryDescriptor;
    this.#driver = input.driver;
    this.#region = snapshotCanonicalPayload(input.region) as Omit<MemoryRegionKeyInput, "descriptor">;
    this.#agentInstanceId = input.agentInstanceId;
    this.#ledger = input.ledger;
    this.#onDriverCall = input.onDriverCall;
    this.#maxRecallCap = input.maxRecallCap ?? 10;
    this.#retrievalIndex = input.retrievalIndex ?? EXACT_RETRIEVAL_INDEX;
    if (
      typeof this.#retrievalIndex.algorithm !== "string"
      || this.#retrievalIndex.algorithm.trim().length === 0
      || !Number.isSafeInteger(this.#retrievalIndex.version)
      || this.#retrievalIndex.version < 1
    ) {
      throw new Error("named-memory retrieval index metadata is invalid");
    }
    this.#barrier = input.barrier ?? new NamedMemorySessionBarrier();
    this.#barrier.register(() => this.reconcileOwnPending());
    this.descriptorHash = hashMemoryDescriptor(this.descriptor);
    this.schemaHash = hashPersistedSchema(this.descriptor.schema);
  }

  get traceLength(): number {
    return this.#trace.length;
  }

  traceSince(index: number): readonly NamedMemoryTraceEntry[] {
    return Object.freeze(this.#trace.slice(index));
  }

  async snapshot(): Promise<TransactionalNamedMemorySnapshot> {
    await this.#barrier.reconcileAll();
    return await this.#driver.snapshot();
  }

  async store(input: {
    invocationCorrelation: string;
    evaluationOrdinal: number;
    operationResultId: string;
    site: string;
    value: Value;
    loseFinalizeAck?: boolean;
  }): Promise<NamedMemoryMutationResult> {
    this.assertOpenAndScoped();
    await this.#barrier.reconcileAll();
    this.count("mutation");
    const stage = await this.#driver.prepareStore({
      descriptor: this.descriptor,
      region: this.#region,
      site: input.site,
      origin: {
        invocationCorrelation: input.invocationCorrelation,
        evaluationOrdinal: input.evaluationOrdinal,
      },
      value: input.value,
    });
    this.pushTrace("prepare", stage.operationId, input.operationResultId);
    const replayed = await this.preparedReplay(stage);
    if (replayed) return replayed;
    return await this.commitMutation(stage, input.operationResultId, input.invocationCorrelation, input.loseFinalizeAck);
  }

  async forget(input: {
    invocationCorrelation: string;
    evaluationOrdinal: number;
    operationResultId: string;
    site: string;
    loseFinalizeAck?: boolean;
  }): Promise<NamedMemoryMutationResult> {
    this.assertOpenAndScoped();
    await this.#barrier.reconcileAll();
    this.count("mutation");
    const stage = await this.#driver.prepareForget({
      descriptor: this.descriptor,
      region: this.#region,
      site: input.site,
      origin: {
        invocationCorrelation: input.invocationCorrelation,
        evaluationOrdinal: input.evaluationOrdinal,
      },
    });
    this.pushTrace("prepare", stage.operationId, input.operationResultId);
    const replayed = await this.preparedReplay(stage);
    if (replayed) return replayed;
    return await this.commitMutation(stage, input.operationResultId, input.invocationCorrelation, input.loseFinalizeAck);
  }

  async recall(input: {
    invocationCorrelation: string;
    operationResultId: string;
    query: string;
    cap?: number;
  }): Promise<NamedMemoryRecallResult> {
    this.assertOpenAndScoped();
    const requestedCap = input.cap ?? this.#maxRecallCap;
    if (!Number.isSafeInteger(requestedCap) || requestedCap < 0) {
      throw new Error("named-memory recall cap must be a nonnegative safe integer");
    }
    const cap = Math.min(requestedCap, this.#maxRecallCap);
    await this.#barrier.reconcileAll();
    this.count("read");
    const recalled = await this.#driver.recall({
      descriptor: this.descriptor,
      region: this.#region,
    });
    const byOperation = new Map(recalled.cells.map((cell) => [cell.operationId, cell]));
    const candidates = await this.#retrievalIndex.rank({
      cells: recalled.cells,
      query: input.query,
      operationResultId: input.operationResultId,
    });
    const seenOperations = new Set<string>();
    const seenCells = new Set<string>();
    const ranked = candidates.map((candidate) => {
      if (!Number.isFinite(candidate.score)) throw new Error("named-memory recall score must be finite");
      if (seenOperations.has(candidate.operationId) || seenCells.has(candidate.cellId)) {
        throw new Error("named-memory recall candidates must be unique");
      }
      seenOperations.add(candidate.operationId);
      seenCells.add(candidate.cellId);
      const cell = byOperation.get(candidate.operationId);
      if (!cell) {
        throw new Error(`named-memory recall candidate is not finalized in the current region: ${candidate.operationId}`);
      }
      if (candidate.cellId !== cell.cellId) {
        throw new Error("named-memory retrieval index cannot replace a canonical cell id");
      }
      return { cell, cellId: candidate.cellId, score: candidate.score, generation: recalled.generation };
    }).sort((left, right) =>
      right.score - left.score || bytewiseCompare(left.cellId, right.cellId));
    const hits = Object.freeze(ranked.slice(0, cap));
    const event = this.#ledger.append(
      "MemoryConsulted",
      this.descriptor.name,
      Object.freeze({
        descriptor_hash: this.descriptorHash,
        schema_hash: this.schemaHash,
        query_hash: createHash("sha256")
          .update("agape.named-memory-query.v1", "utf8")
          .update("\0", "utf8")
          .update(input.query, "utf8")
          .digest("hex"),
        generation: recalled.generation,
        region: this.descriptor.name,
        scope_hash: hashResolvedMemoryScope({
          descriptor: this.descriptor,
          projectSubject: this.#region.projectSubject,
          user: this.#region.user,
        }),
        cap,
        retrieval: Object.freeze({
          algorithm: this.#retrievalIndex.algorithm,
          version: this.#retrievalIndex.version,
        }),
        hit_ids: Object.freeze(hits.map((hit) => hit.cellId)),
        hit_hashes: Object.freeze(hits.map((hit) => hit.cell.value.valueHash)),
        scores: Object.freeze(hits.map((hit) => hit.score)),
        origins: Object.freeze(hits.map((hit) => hit.cell.originId)),
      }),
      this.#agentInstanceId,
      opaqueCorrelation(input.invocationCorrelation),
    );
    this.pushTrace("recall", undefined, input.operationResultId, "MemoryConsulted");
    return Object.freeze({ generation: recalled.generation, hits, event });
  }

  async reconcilePending(): Promise<void> {
    await this.#barrier.reconcileAll();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#barrier.reconcileAll();
    this.pushTrace("close");
    this.#closed = true;
  }

  async markResumed(): Promise<void> {
    await this.#barrier.reconcileAll();
    this.pushTrace("resume");
  }

  private async reconcileOwnPending(): Promise<void> {
    if (this.#pending.size === 0) return;
    this.assertOpenAndScoped();
    for (const [operationId, binding] of [...this.#pending]) {
      this.count("mutation");
      const status = await this.#driver.reconcile(operationId, binding);
      this.pushTrace("reconcile", operationId);
      if (status.status === "finalized") this.#pending.delete(operationId);
    }
    if (this.#pending.size !== 0) {
      throw new NamedMemoryReconciliationPendingError(this.#pending.keys().next().value!);
    }
  }

  private async preparedReplay(
    stage: PreparedNamedMemoryMutation,
  ): Promise<NamedMemoryMutationResult | undefined> {
    this.count("mutation");
    const status = await this.#driver.status(stage.operationId);
    if (status.status !== "finalized") return undefined;
    return Object.freeze({
      stage,
      receipt: status.receipt,
      ack: mutationAck(status.receipt),
      pending: false,
      reused: true,
    });
  }

  private async commitMutation(
    stage: PreparedNamedMemoryMutation,
    operationResultId: string,
    invocationCorrelation: string,
    loseFinalizeAck = false,
  ): Promise<NamedMemoryMutationResult> {
    const etype = stage.kind === "store" ? "Internalized" : "Forgotten";
    let event: LedgerEvent;
    try {
      event = this.#ledger.append(
        etype,
        this.descriptor.name,
        publicMutationPayload(this.descriptor.name, stage),
        this.#agentInstanceId,
        opaqueCorrelation(invocationCorrelation),
      );
    } catch (error) {
      this.count("mutation");
      await this.#driver.abort(stage.operationId);
      throw error;
    }
    const binding = Object.freeze({ tick: event.tick, head: this.#ledger.head() });
    this.#pending.set(stage.operationId, binding);
    this.pushTrace("ledger-commit", stage.operationId, operationResultId, etype);
    this.pushTrace("finalize", stage.operationId, operationResultId);
    this.count("mutation");
    let receipt: NamedMemoryMutationReceipt;
    try {
      receipt = await this.#driver.finalize(stage.operationId, binding);
    } catch {
      this.count("mutation");
      const status = await this.#driver.status(stage.operationId);
      if (status.status === "finalized") {
        receipt = status.receipt;
        loseFinalizeAck = true;
      } else {
        this.count("mutation");
        const reconciled = await this.#driver.reconcile(stage.operationId, binding);
        this.pushTrace("reconcile", stage.operationId, operationResultId);
        if (reconciled.status !== "finalized") {
          throw new NamedMemoryReconciliationPendingError(stage.operationId);
        }
        receipt = reconciled.receipt;
        this.#pending.delete(stage.operationId);
      }
    }
    if (loseFinalizeAck) {
      this.count("mutation");
      const observed = await this.#driver.status(stage.operationId);
      if (observed.status !== "finalized") {
        this.#pending.set(stage.operationId, binding);
        return Object.freeze({ stage, event, pending: true, reused: false });
      }
      receipt = observed.receipt;
    } else {
      this.#pending.delete(stage.operationId);
    }
    return Object.freeze({
      stage,
      receipt,
      event,
      ack: mutationAck(receipt),
      pending: loseFinalizeAck,
      reused: false,
    });
  }

  private assertOpenAndScoped(): void {
    if (this.#closed) throw new Error("named-memory coordinator is closed");
    if (
      this.descriptor.scopes.includes("project")
      && (
        typeof this.#region.projectSubject !== "string"
        || this.#region.projectSubject.trim().length === 0
      )
    ) {
      throw new NamedMemoryScopeError("project");
    }
    if (this.descriptor.scopes.includes("user")) {
      const user = this.#region.user;
      if (
        user === undefined
        || user.verified !== true
        || typeof user.issuer !== "string"
        || user.issuer.trim().length === 0
        || typeof user.subject !== "string"
        || user.subject.trim().length === 0
      ) {
        throw new NamedMemoryScopeError("user");
      }
    }
  }

  private assertPreflight(
    descriptor: ResolvedMemoryDescriptor,
    driver: TransactionalNamedMemoryDriver,
    identityCapabilities: readonly ("project" | "user")[],
  ): void {
    if (!driver.capabilities.modalities.includes(descriptor.modality)) {
      throw new Error(`memory driver does not advertise modality ${descriptor.modality}`);
    }
    if (!driver.capabilities.retentions.includes(descriptor.retention)) {
      throw new Error(`memory driver does not advertise retention ${descriptor.retention}`);
    }
    for (const scope of descriptor.scopes) {
      if (!driver.capabilities.scopes.includes(scope) || !identityCapabilities.includes(scope)) {
        throw new Error(`memory driver or runtime identity does not advertise scope ${scope}`);
      }
    }
    if (!driver.capabilities.exactEncoding || !driver.capabilities.idempotentReconciliation) {
      throw new Error("memory driver lacks exact transactional capabilities");
    }
  }

  private count(kind: NamedMemoryDriverCallKind): void {
    try {
      this.#onDriverCall?.(kind);
    } catch {
      // Observability is contained and cannot participate in the commit protocol.
    }
  }

  private pushTrace(
    phase: NamedMemoryTraceEntry["phase"],
    operationId?: string,
    operationResultId?: string,
    etype?: string,
  ): void {
    this.#trace.push(Object.freeze({
      sequence: this.#sequence++,
      phase,
      ...(operationId === undefined ? {} : { operationId }),
      ...(operationResultId === undefined ? {} : { operationResultId }),
      ...(etype === undefined ? {} : { etype }),
    }));
  }
}

export class NamedMemoryReconciliationPendingError extends Error {
  readonly code = "MemoryReconciliationPending";

  constructor(readonly operationId: string) {
    super(`named-memory operation ${operationId} has a ledger decision that is not reconciled`);
  }
}

export class NamedMemoryScopeError extends Error {
  readonly code = "MissingScopeSubject";

  constructor(readonly scope: "project" | "user") {
    super(`named memory requires a resolved ${scope} scope subject`);
  }
}
