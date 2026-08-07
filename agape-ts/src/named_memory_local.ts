import { createHash } from "node:crypto";
import type { Value } from "./runtime.js";
import {
  deriveMemoryRegionKey,
  encodeExactValue,
  hashMemoryDescriptor,
  hashPersistedSchema,
  type ExactValueEnvelope,
  type MemoryRegionKeyInput,
  type ResolvedMemoryDescriptor,
} from "./named_memory.js";

export interface NamedMemoryMutationContext {
  descriptor: ResolvedMemoryDescriptor;
  region: Omit<MemoryRegionKeyInput, "descriptor">;
  site: string;
  origin: {
    invocationCorrelation: string;
    evaluationOrdinal: number;
  };
}

export interface LedgerCommitBinding {
  tick: number;
  head: string;
}

export interface NamedMemoryEffects {
  cells: {
    upserted: number;
    tombstoned: number;
  };
}

export interface PreparedNamedMemoryMutation {
  originId: string;
  cellId?: string;
  operationId: string;
  kind: "store" | "forget";
  regionKey: string;
  generation: number;
  descriptorHash: string;
  schemaHash: string;
  scopeHash: string;
  valueHash?: string;
  effects: NamedMemoryEffects;
  refs: Readonly<Record<string, string>>;
  alreadyForgotten?: boolean;
}

export interface NamedMemoryMutationReceipt extends PreparedNamedMemoryMutation {
  ledger: Readonly<LedgerCommitBinding>;
}
export interface NamedMemoryCell {
  cellId: string;
  originId: string;
  operationId: string;
  value: ExactValueEnvelope;
}


export type NamedMemoryOperationStatus =
  | { status: "unknown" }
  | { status: "prepared"; stage: PreparedNamedMemoryMutation }
  | { status: "finalized"; receipt: NamedMemoryMutationReceipt }
  | { status: "aborted" };

export interface NamedMemoryRecall {
  generation: number;
  state: "open" | "closed";
  cells: readonly NamedMemoryCell[];
  values: readonly ExactValueEnvelope[];
}

type StoreRequest = NamedMemoryMutationContext & {
  value: Value;
  operationId?: string;
};

type ForgetRequest = NamedMemoryMutationContext & {
  operationId?: string;
};

interface RegionState {
  generation: number;
  state: "open" | "closed";
  cells: readonly NamedMemoryCell[];
}

interface OperationRecord {
  fingerprint: string;
  status: "prepared" | "finalized" | "aborted";
  stage: PreparedNamedMemoryMutation;
  envelope?: ExactValueEnvelope;
  ledger?: Readonly<LedgerCommitBinding>;
  receipt?: NamedMemoryMutationReceipt;
}

interface LocalTransactionalNamedMemoryJournalState {
  regions: Map<string, RegionState>;
  operations: Map<string, OperationRecord>;
  activeByRegion: Map<string, string>;
  operationByEvaluation: Map<string, string>;
}

const LOCAL_JOURNAL_STATES =
  new WeakMap<LocalTransactionalNamedMemoryJournal, LocalTransactionalNamedMemoryJournalState>();

/**
 * Opaque storage for one Local runtime session. Reuse this handle only when
 * reconstructing that same session; distinct sessions require distinct journals.
 */
export class LocalTransactionalNamedMemoryJournal {
  readonly #opaqueJournalHandle = true;

  constructor() {
    LOCAL_JOURNAL_STATES.set(this, {
      regions: new Map(),
      operations: new Map(),
      activeByRegion: new Map(),
      operationByEvaluation: new Map(),
    });
    Object.freeze(this);
  }
}


export interface LocalTransactionalNamedMemoryDriverOptions {
  afterFinalize?: (receipt: NamedMemoryMutationReceipt) => void;
  journal?: LocalTransactionalNamedMemoryJournal;
}

const EMPTY_OPEN_REGION: RegionState = Object.freeze({
  generation: 0,
  state: "open",
  cells: Object.freeze([]),
});

export class LocalTransactionalNamedMemoryDriver {
  readonly capabilities = freezeDeep({
    modalities: ["opaque", "episodic", "semantic"] as const,
    retentions: ["session"] as const,
    version: 1,
    scopes: ["project", "user"] as const,
    exactEncoding: true,
    idempotentReconciliation: true,
  });
  readonly #regions: Map<string, RegionState>;
  readonly #operations: Map<string, OperationRecord>;
  readonly #activeByRegion: Map<string, string>;
  readonly #operationByEvaluation: Map<string, string>;

  constructor(private readonly options: LocalTransactionalNamedMemoryDriverOptions = {}) {
    const journal = options.journal ?? new LocalTransactionalNamedMemoryJournal();
    const state = LOCAL_JOURNAL_STATES.get(journal);
    if (!state) throw new Error("invalid Local transactional named-memory journal");
    this.#regions = state.regions;
    this.#operations = state.operations;
    this.#activeByRegion = state.activeByRegion;
    this.#operationByEvaluation = state.operationByEvaluation;
  }

  prepareStore(request: StoreRequest): PreparedNamedMemoryMutation {
    const base = this.prepareBase(request);
    const envelope = freezeDeep(encodeExactValue(request.value, request.descriptor.schema));
    const evaluationKey = operationFingerprint([
      "evaluation",
      "store",
      request.site,
      base.originId,
    ]);
    const priorOperationId = this.#operationByEvaluation.get(evaluationKey);
    if (priorOperationId !== undefined) {
      const prior = this.#operations.get(priorOperationId);
      if (!prior) throw new Error("named-memory journal has an invalid evaluation index");
      const fingerprint = operationFingerprint([
        "store",
        request.site,
        base.originId,
        base.regionKey,
        String(prior.stage.generation),
        base.descriptorHash,
        base.schemaHash,
        envelope.valueHash,
      ]);
      this.assertOperationId(request.operationId ?? priorOperationId, fingerprint);
      return this.existing(priorOperationId, fingerprint)!.stage;
    }

    const current = this.regionState(base.regionKey);
    const generation = current.state === "closed" ? current.generation + 1 : current.generation;
    const fingerprint = operationFingerprint([
      "store",
      request.site,
      base.originId,
      base.regionKey,
      String(generation),
      base.descriptorHash,
      base.schemaHash,
      envelope.valueHash,
    ]);
    const operationId = request.operationId ?? `memory-operation-v1:${fingerprint}`;
    this.assertOperationId(operationId, fingerprint);
    const cellId = `memory-cell-v1:${operationFingerprint(["cell", base.regionKey, String(generation), operationId])}`;
    const existing = this.existing(operationId, fingerprint);
    if (existing) return existing.stage;
    this.assertRegionAvailable(base.regionKey, operationId);

    const effects = freezeDeep({ cells: { upserted: 1, tombstoned: 0 } });
    const refs = freezeDeep({
      region: base.regionKey,
      value: `memory-value-v1:${envelope.valueHash}`,
      origin: base.originId,
      cell: cellId,
    });
    const stage = freezeDeep({
      operationId,
      kind: "store" as const,
      regionKey: base.regionKey,
      originId: base.originId,
      cellId,
      generation,
      descriptorHash: base.descriptorHash,
      schemaHash: base.schemaHash,
      scopeHash: base.scopeHash,
      valueHash: envelope.valueHash,
      effects,
      refs,
    });
    this.#operations.set(operationId, {
      fingerprint,
      status: "prepared",
      stage,
      envelope,
    });
    this.#operationByEvaluation.set(evaluationKey, operationId);
    this.#activeByRegion.set(base.regionKey, operationId);
    return stage;
  }

  prepareForget(request: ForgetRequest): PreparedNamedMemoryMutation {
    const base = this.prepareBase(request);
    const evaluationKey = operationFingerprint([
      "evaluation",
      "forget",
      request.site,
      base.originId,
    ]);
    const priorOperationId = this.#operationByEvaluation.get(evaluationKey);
    if (priorOperationId !== undefined) {
      const prior = this.#operations.get(priorOperationId);
      if (!prior) throw new Error("named-memory journal has an invalid evaluation index");
      const fingerprint = operationFingerprint([
        "forget",
        request.site,
        base.originId,
        base.regionKey,
        String(prior.stage.generation),
        base.descriptorHash,
        base.schemaHash,
        prior.stage.alreadyForgotten === true ? "closed" : "open",
      ]);
      this.assertOperationId(request.operationId ?? priorOperationId, fingerprint);
      return this.existing(priorOperationId, fingerprint)!.stage;
    }
    const current = this.regionState(base.regionKey);
    const alreadyForgotten = current.state === "closed";
    const tombstoned = alreadyForgotten ? 0 : current.cells.length;
    const fingerprint = operationFingerprint([
      "forget",
      request.site,
      base.originId,
      base.regionKey,
      String(current.generation),
      base.descriptorHash,
      base.schemaHash,
      alreadyForgotten ? "closed" : "open",
    ]);
    const operationId = request.operationId ?? `memory-operation-v1:${fingerprint}`;
    this.assertOperationId(operationId, fingerprint);
    const existing = this.existing(operationId, fingerprint);
    if (existing) return existing.stage;
    this.assertRegionAvailable(base.regionKey, operationId);

    const effects = freezeDeep({ cells: { upserted: 0, tombstoned } });
    const refs = freezeDeep({ region: base.regionKey, origin: base.originId });
    const stage = freezeDeep({
      operationId,
      kind: "forget" as const,
      regionKey: base.regionKey,
      originId: base.originId,
      generation: current.generation,
      descriptorHash: base.descriptorHash,
      schemaHash: base.schemaHash,
      scopeHash: base.scopeHash,
      effects,
      refs,
      alreadyForgotten,
    });
    this.#operations.set(operationId, {
      fingerprint,
      status: "prepared",
      stage,
    });
    this.#operationByEvaluation.set(evaluationKey, operationId);
    this.#activeByRegion.set(base.regionKey, operationId);
    return stage;
  }

  finalize(operationId: string, suppliedBinding: LedgerCommitBinding): NamedMemoryMutationReceipt {
    const record = this.#operations.get(operationId);
    if (!record) throw new Error(`unknown named-memory operation ${operationId}`);
    const binding = validateBinding(suppliedBinding);
    if (record.status === "aborted") {
      throw new Error(`named-memory operation ${operationId} was aborted`);
    }
    if (record.status === "finalized") {
      if (!sameBinding(record.ledger!, binding)) {
        throw new Error(`named-memory operation ${operationId} has a conflicting ledger commit binding`);
      }
      return record.receipt!;
    }

    const current = this.regionState(record.stage.regionKey);
    if (record.stage.kind === "store") {
      if (!record.envelope) throw new Error("prepared store is missing its exact value");
      const reopening = current.state === "closed";
      const expectedGeneration = reopening ? current.generation + 1 : current.generation;
      if (record.stage.generation !== expectedGeneration) {
        throw new Error("prepared store generation conflicts with current region revision");
      }
      const cell = freezeDeep({
        cellId: record.stage.cellId!,
        originId: record.stage.originId,
        operationId: record.stage.operationId,
        value: record.envelope,
      });
      const cells = reopening ? [cell] : [...current.cells, cell];
      this.#regions.set(record.stage.regionKey, freezeDeep({
        generation: record.stage.generation,
        state: "open" as const,
        cells,
      }));
    } else {
      if (record.stage.generation !== current.generation) {
        throw new Error("prepared forget generation conflicts with current region revision");
      }
      this.#regions.set(record.stage.regionKey, freezeDeep({
        generation: current.generation,
        state: "closed" as const,
        cells: [] as NamedMemoryCell[],
      }));
    }

    const receipt = freezeDeep({
      ...record.stage,
      ledger: binding,
    });
    record.status = "finalized";
    record.ledger = binding;
    record.receipt = receipt;
    this.#activeByRegion.delete(record.stage.regionKey);
    this.options.afterFinalize?.(receipt);
    return receipt;
  }

  abort(operationId: string): NamedMemoryOperationStatus {
    const record = this.#operations.get(operationId);
    if (!record) return freezeDeep({ status: "unknown" as const });
    if (record.status === "finalized") {
      throw new Error(`named-memory operation ${operationId} is already finalized and committed`);
    }
    if (record.status === "prepared") {
      record.status = "aborted";
      this.#activeByRegion.delete(record.stage.regionKey);
    }
    return freezeDeep({ status: "aborted" as const });
  }

  status(operationId: string): NamedMemoryOperationStatus {
    const record = this.#operations.get(operationId);
    if (!record) return freezeDeep({ status: "unknown" as const });
    if (record.status === "prepared") return freezeDeep({ status: "prepared" as const, stage: record.stage });
    if (record.status === "finalized") return freezeDeep({ status: "finalized" as const, receipt: record.receipt! });
    return freezeDeep({ status: "aborted" as const });
  }

  reconcile(operationId: string, binding?: LedgerCommitBinding): NamedMemoryOperationStatus {
    const current = this.status(operationId);
    if (current.status !== "prepared" || binding === undefined) return current;
    this.finalize(operationId, binding);
    return this.status(operationId);
  }

  recall(input: {
    descriptor: ResolvedMemoryDescriptor;
    region: Omit<MemoryRegionKeyInput, "descriptor">;
  }): NamedMemoryRecall {
    this.assertLocalDescriptor(input.descriptor);
    const regionKey = deriveMemoryRegionKey({ descriptor: input.descriptor, ...input.region });
    const current = this.regionState(regionKey);
    return freezeDeep({
      generation: current.generation,
      state: current.state,
      cells: current.state === "open" ? [...current.cells] : [],
      values: current.state === "open" ? current.cells.map((cell) => cell.value) : [],
    });
  }

  private prepareBase(context: NamedMemoryMutationContext): {
    regionKey: string;
    descriptorHash: string;
    schemaHash: string;
    originId: string;
    scopeHash: string;
  } {
    this.assertLocalDescriptor(context.descriptor);
    assertNonblank(context.site, "memory operation site");
    assertNonblank(context.origin.invocationCorrelation, "memory operation invocation correlation");
    if (!Number.isSafeInteger(context.origin.evaluationOrdinal) || context.origin.evaluationOrdinal < 0) {
      throw new Error("memory operation evaluation ordinal must be a nonnegative safe integer");
    }
    const regionKey = deriveMemoryRegionKey({
      descriptor: context.descriptor,
      ...context.region,
    });
    return {
      regionKey,
      descriptorHash: hashMemoryDescriptor(context.descriptor),
      originId: `memory-origin-v1:${operationFingerprint(["origin", context.origin.invocationCorrelation, String(context.origin.evaluationOrdinal)])}`,
      schemaHash: hashPersistedSchema(context.descriptor.schema),
      scopeHash: operationFingerprint(["scope", regionKey]),
    };
  }

  private assertLocalDescriptor(descriptor: ResolvedMemoryDescriptor): void {
    if (descriptor.retention !== "session") {
      throw new Error("Local transactional named memory supports session retention only");
    }
  }

  private regionState(regionKey: string): RegionState {
    return this.#regions.get(regionKey) ?? EMPTY_OPEN_REGION;
  }

  private assertRegionAvailable(regionKey: string, operationId: string): void {
    const active = this.#activeByRegion.get(regionKey);
    if (active !== undefined && active !== operationId) {
      throw new Error(`named-memory region has a prepared mutation conflict: ${active}`);
    }
  }

  private assertOperationId(operationId: string, fingerprint: string): void {
    if (operationId !== `memory-operation-v1:${fingerprint}`) {
      throw new Error("named-memory operation id does not match its canonical fingerprint");
    }
  }

  private existing(operationId: string, fingerprint: string): OperationRecord | undefined {
    const record = this.#operations.get(operationId);
    if (!record) return undefined;
    if (record.fingerprint !== fingerprint) {
      throw new Error("named-memory operation id was reused with a different fingerprint");
    }
    if (record.status === "aborted") {
      throw new Error("named-memory operation id refers to an aborted mutation");
    }
    return record;
  }
}

function validateBinding(binding: LedgerCommitBinding): Readonly<LedgerCommitBinding> {
  if (!Number.isSafeInteger(binding.tick) || binding.tick < 0) {
    throw new Error("ledger commit tick must be a nonnegative safe integer");
  }
  assertNonblank(binding.head, "ledger commit head");
  return freezeDeep({ tick: binding.tick, head: binding.head });
}

function sameBinding(left: LedgerCommitBinding, right: LedgerCommitBinding): boolean {
  return left.tick === right.tick && left.head === right.head;
}

function operationFingerprint(fields: readonly string[]): string {
  const hash = createHash("sha256").update("agape.named-memory-operation.v1", "utf8");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function assertNonblank(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a nonblank string`);
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
