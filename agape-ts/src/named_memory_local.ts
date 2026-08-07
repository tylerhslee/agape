import { createHash } from "node:crypto";
import type { Value } from "./runtime.js";
import {
  deriveMemoryRegionKey,
  encodeExactValue,
  decodeExactValue,
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

export interface RegionDerivation {
  descriptor: ResolvedMemoryDescriptor;
  dimensions: Readonly<Record<string, string>>;
}

export interface OperationDerivation {
  siteHash: string;
  invocationHash: string;
  evaluationOrdinal: number;
  region: RegionDerivation;
}

interface RegionState {
  generation: number;
  state: "open" | "closed";
  cells: readonly NamedMemoryCell[];
  derivation?: RegionDerivation;
}

interface OperationRecord {
  fingerprint: string;
  derivation: OperationDerivation;
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

export interface TransactionalNamedMemorySnapshotOperation {
  operationId: string;
  fingerprint: string;
  status: "finalized";
  derivation: OperationDerivation;
  stage: PreparedNamedMemoryMutation;
  receipt: NamedMemoryMutationReceipt;
}

export interface TransactionalNamedMemorySnapshot {
  version: 1;
  regions: readonly {
    regionKey: string;
    generation: number;
    state: "open" | "closed";
    cells: readonly NamedMemoryCell[];
    descriptor: ResolvedMemoryDescriptor;
    dimensions: Readonly<Record<string, string>>;
  }[];
  operations: readonly TransactionalNamedMemorySnapshotOperation[];
  evaluations: readonly { evaluationKey: string; operationId: string }[];
}

const LOCAL_JOURNAL_STATES =
  new WeakMap<LocalTransactionalNamedMemoryJournal, LocalTransactionalNamedMemoryJournalState>();

/**
 * Opaque storage for one Local runtime session. Reuse this handle only when
 * reconstructing that same session; distinct sessions require distinct journals.
 */
export class LocalTransactionalNamedMemoryJournal {
  readonly #opaqueJournalHandle = true;

  constructor(snapshot?: TransactionalNamedMemorySnapshot) {
    const restored = snapshot === undefined ? emptyJournalState() : restoreJournalSnapshot(snapshot);
    LOCAL_JOURNAL_STATES.set(this, {
      regions: restored.regions,
      operations: restored.operations,
      activeByRegion: new Map(),
      operationByEvaluation: restored.operationByEvaluation,
    });
    Object.freeze(this);
  }
}


export interface LocalTransactionalNamedMemoryDriverOptions {
  afterFinalize?: (receipt: NamedMemoryMutationReceipt) => void;
  journal?: LocalTransactionalNamedMemoryJournal;
}

export interface DurableTransactionalNamedMemoryDriverOptions
  extends LocalTransactionalNamedMemoryDriverOptions {}

const EMPTY_OPEN_REGION: RegionState = Object.freeze({
  generation: 0,
  state: "open",
  cells: Object.freeze([]),
});

class TransactionalNamedMemoryDriver {
  readonly capabilities;
  readonly #retention: "session" | "durable";
  readonly #regions: Map<string, RegionState>;
  readonly #operations: Map<string, OperationRecord>;
  readonly #activeByRegion: Map<string, string>;
  readonly #operationByEvaluation: Map<string, string>;

  constructor(
    retention: "session" | "durable",
    private readonly options: LocalTransactionalNamedMemoryDriverOptions = {},
  ) {
    this.#retention = retention;
    this.capabilities = freezeDeep({
      modalities: ["opaque", "episodic", "semantic"] as const,
      retentions: [retention] as readonly ("session" | "durable")[],
      version: 1 as const,
      scopes: ["project", "user"] as const,
      exactEncoding: true as const,
      idempotentReconciliation: true as const,
    });
    const journal = options.journal ?? new LocalTransactionalNamedMemoryJournal();
    const state = LOCAL_JOURNAL_STATES.get(journal);
    if (!state) throw new Error("invalid transactional named-memory journal");
    this.#regions = state.regions;
    this.#operations = state.operations;
    this.#activeByRegion = state.activeByRegion;
    this.#operationByEvaluation = state.operationByEvaluation;
  }

  snapshot(): TransactionalNamedMemorySnapshot {
    if (this.#activeByRegion.size !== 0
      || [...this.#operations.values()].some((record) => record.status === "prepared")) {
      throw new Error("cannot snapshot transactional named memory with a prepared or active mutation");
    }
    const finalizedIds = new Set(
      [...this.#operations.entries()]
        .filter(([, record]) => record.status === "finalized")
        .map(([operationId]) => operationId),
    );
    return freezeDeep({
      version: 1 as const,
      regions: [...this.#regions.entries()]
        .sort(([left], [right]) => bytewiseCompare(left, right))
        .map(([regionKey, region]) => {
          if (!region.derivation) throw new Error("finalized memory region is missing derivation metadata");
          return {
            regionKey,
            generation: region.generation,
            state: region.state,
            cells: [...region.cells],
            descriptor: region.derivation.descriptor,
            dimensions: region.derivation.dimensions,
          };
        }),
      operations: [...this.#operations.entries()]
        .filter(([, record]) => record.status === "finalized")
        .sort(([left], [right]) => bytewiseCompare(left, right))
        .map(([operationId, record]): TransactionalNamedMemorySnapshotOperation => ({
          operationId,
          fingerprint: record.fingerprint,
          status: "finalized",
          derivation: record.derivation,
          stage: record.stage,
          receipt: record.receipt!,
        })),
      evaluations: [...this.#operationByEvaluation.entries()]
        .filter(([, operationId]) => finalizedIds.has(operationId))
        .sort(([left], [right]) => bytewiseCompare(left, right))
        .map(([evaluationKey, operationId]) => ({ evaluationKey, operationId })),
    });
  }

  prepareStore(request: StoreRequest): PreparedNamedMemoryMutation {
    const base = this.prepareBase(request);
    const envelope = freezeDeep(encodeExactValue(request.value, request.descriptor.schema));
    const evaluationKey = operationFingerprint([
      "evaluation",
      "store",
      base.siteHash,
      base.originId,
    ]);
    const priorOperationId = this.#operationByEvaluation.get(evaluationKey);
    if (priorOperationId !== undefined) {
      const prior = this.#operations.get(priorOperationId);
      if (!prior) throw new Error("named-memory journal has an invalid evaluation index");
      const fingerprint = operationFingerprint([
        "store",
        base.siteHash,
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
      base.siteHash,
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
      derivation: base.derivation,
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
      base.siteHash,
      base.originId,
    ]);
    const priorOperationId = this.#operationByEvaluation.get(evaluationKey);
    if (priorOperationId !== undefined) {
      const prior = this.#operations.get(priorOperationId);
      if (!prior) throw new Error("named-memory journal has an invalid evaluation index");
      const fingerprint = operationFingerprint([
        "forget",
        base.siteHash,
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
      base.siteHash,
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
      derivation: base.derivation,
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
        derivation: current.derivation ?? record.derivation.region,
      }));
    } else {
      if (record.stage.generation !== current.generation) {
        throw new Error("prepared forget generation conflicts with current region revision");
      }
      this.#regions.set(record.stage.regionKey, freezeDeep({
        generation: current.generation,
        state: "closed" as const,
        cells: [] as NamedMemoryCell[],
        derivation: current.derivation ?? record.derivation.region,
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
    siteHash: string;
    derivation: OperationDerivation;
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
    const siteHash = snapshotOpaqueField("operation-site", context.site);
    const invocationHash = snapshotOpaqueField(
      "invocation-correlation",
      context.origin.invocationCorrelation,
    );
    const regionDerivation = createRegionDerivation(context.descriptor, context.region);
    if (deriveSnapshotRegionKey(regionDerivation) !== regionKey) {
      throw new Error("named-memory region derivation is inconsistent");
    }
    const originId = `memory-origin-v1:${operationFingerprint([
      "origin",
      invocationHash,
      String(context.origin.evaluationOrdinal),
    ])}`;
    return {
      regionKey,
      descriptorHash: hashMemoryDescriptor(context.descriptor),
      originId,
      schemaHash: hashPersistedSchema(context.descriptor.schema),
      scopeHash: deriveSnapshotScopeHash(regionDerivation),
      siteHash,
      derivation: freezeDeep({
        siteHash,
        invocationHash,
        evaluationOrdinal: context.origin.evaluationOrdinal,
        region: regionDerivation,
      }),
    };
  }

  private assertLocalDescriptor(descriptor: ResolvedMemoryDescriptor): void {
    if (descriptor.retention !== this.#retention) {
      throw new Error(`transactional named memory supports ${this.#retention} retention only`);
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

/** Session-local backend. Its public capabilities remain unconditionally session-only. */
export class LocalTransactionalNamedMemoryDriver extends TransactionalNamedMemoryDriver {
  constructor(options: LocalTransactionalNamedMemoryDriverOptions = {}) {
    super("session", options);
  }
}

/**
 * Durable in-memory transactional backend. A host may persist and authenticate
 * its validated snapshots through a separate storage projection.
 */
export class DurableTransactionalNamedMemoryDriver extends TransactionalNamedMemoryDriver {
  constructor(options: DurableTransactionalNamedMemoryDriverOptions = {}) {
    super("durable", options);
  }
}


type RestoredJournalState = Pick<
  LocalTransactionalNamedMemoryJournalState,
  "regions" | "operations" | "operationByEvaluation"
>;

interface ReplayRegionState {
  generation: number;
  state: "open" | "closed";
  cells: PreparedNamedMemoryMutation[];
}

const SNAPSHOT_HASH = /^[0-9a-f]{64}$/;
const SNAPSHOT_OPERATION_ID = /^memory-operation-v1:[0-9a-f]{64}$/;
const SNAPSHOT_REGION_KEY = /^memory-region-v1:[0-9a-f]{64}$/;
const SNAPSHOT_ORIGIN_ID = /^memory-origin-v1:[0-9a-f]{64}$/;
const SNAPSHOT_CELL_ID = /^memory-cell-v1:[0-9a-f]{64}$/;

function emptyJournalState(): RestoredJournalState {
  return {
    regions: new Map(),
    operations: new Map(),
    operationByEvaluation: new Map(),
  };
}

function restoreJournalSnapshot(snapshot: TransactionalNamedMemorySnapshot): RestoredJournalState {
  assertCanonicalSnapshotData(snapshot, new Set<object>());
  const root = snapshotRecord(snapshot, "transactional named-memory snapshot");
  snapshotKeys(root, ["evaluations", "operations", "regions", "version"], "transactional named-memory snapshot");
  if (root.version !== 1) throw new Error("invalid transactional named-memory snapshot");
  const regionInputs = snapshotArray(root.regions, "snapshot memory regions");
  const operationInputs = snapshotArray(root.operations, "snapshot memory operations");
  const evaluationInputs = snapshotArray(root.evaluations, "snapshot memory evaluations");

  const regions = new Map<string, RegionState>();
  for (const input of regionInputs) {
    const entry = snapshotRecord(input, "snapshot memory region");
    snapshotKeys(
      entry,
      ["cells", "descriptor", "dimensions", "generation", "regionKey", "state"],
      "snapshot memory region",
    );
    snapshotPattern(entry.regionKey, SNAPSHOT_REGION_KEY, "snapshot memory region key");
    snapshotNonnegativeInteger(entry.generation, "snapshot memory generation");
    if (entry.state !== "open" && entry.state !== "closed") {
      throw new Error("snapshot memory region state is invalid");
    }
    const derivation = restoreRegionDerivation({
      descriptor: entry.descriptor,
      dimensions: entry.dimensions,
    });
    if (deriveSnapshotRegionKey(derivation) !== entry.regionKey) {
      throw new Error("snapshot memory region key conflicts with its derivation");
    }
    if (regions.has(entry.regionKey)) throw new Error("snapshot contains a duplicate memory region");
    const cells = snapshotArray(entry.cells, "snapshot memory cells")
      .map((cell) => restoreSnapshotCell(cell, derivation.descriptor));
    if (entry.state === "closed" && cells.length !== 0) {
      throw new Error("snapshot closed memory region must not contain live cells");
    }
    regions.set(entry.regionKey, freezeDeep({
      generation: entry.generation,
      state: entry.state,
      cells,
      derivation,
    }));
  }

  const operations = new Map<string, OperationRecord>();
  const expectedEvaluations = new Map<string, string>();
  const ticks = new Set<number>();
  const heads = new Set<string>();
  const origins = new Set<string>();
  const historicCellIds = new Set<string>();

  for (const input of operationInputs) {
    const entry = snapshotRecord(input, "snapshot memory operation");
    snapshotKeys(
      entry,
      ["derivation", "fingerprint", "operationId", "receipt", "stage", "status"],
      "snapshot finalized memory operation",
    );
    if (entry.status !== "finalized") {
      throw new Error("snapshot may persist finalized memory operations only");
    }
    snapshotPattern(entry.operationId, SNAPSHOT_OPERATION_ID, "snapshot memory operation id");
    snapshotPattern(entry.fingerprint, SNAPSHOT_HASH, "snapshot memory operation fingerprint");
    if (operations.has(entry.operationId)) {
      throw new Error("snapshot contains a duplicate memory operation");
    }

    const stage = restoreSnapshotStage(entry.stage);
    if (stage.operationId !== entry.operationId) {
      throw new Error("snapshot memory operation stage has a conflicting operation id");
    }
    const region = regions.get(stage.regionKey);
    if (!region?.derivation) {
      throw new Error("snapshot memory operation refers to an unknown region");
    }
    const derivation = restoreOperationDerivation(entry.derivation);
    if (snapshotCanonicalJson(derivation.region) !== snapshotCanonicalJson(region.derivation)) {
      throw new Error("snapshot memory operation has conflicting region derivation");
    }
    if (stage.descriptorHash !== hashMemoryDescriptor(region.derivation.descriptor)
      || stage.schemaHash !== hashPersistedSchema(region.derivation.descriptor.schema)
      || stage.scopeHash !== deriveSnapshotScopeHash(region.derivation)) {
      throw new Error("snapshot memory operation descriptor or scope hash is inconsistent");
    }

    const originId = `memory-origin-v1:${operationFingerprint([
      "origin",
      derivation.invocationHash,
      String(derivation.evaluationOrdinal),
    ])}`;
    if (stage.originId !== originId || origins.has(originId)) {
      throw new Error("snapshot memory operation origin is invalid or duplicated");
    }
    origins.add(originId);

    const fingerprint = operationFingerprint(stage.kind === "store"
      ? [
          "store", derivation.siteHash, stage.originId, stage.regionKey,
          String(stage.generation), stage.descriptorHash, stage.schemaHash, stage.valueHash!,
        ]
      : [
          "forget", derivation.siteHash, stage.originId, stage.regionKey,
          String(stage.generation), stage.descriptorHash, stage.schemaHash,
          stage.alreadyForgotten === true ? "closed" : "open",
        ]);
    if (entry.fingerprint !== fingerprint
      || entry.operationId !== `memory-operation-v1:${fingerprint}`) {
      throw new Error("snapshot memory operation id does not match its canonical derivation");
    }

    if (stage.kind === "store") {
      const cellId = `memory-cell-v1:${operationFingerprint([
        "cell", stage.regionKey, String(stage.generation), entry.operationId,
      ])}`;
      if (stage.cellId !== cellId || historicCellIds.has(cellId)) {
        throw new Error("snapshot memory cell id is invalid or duplicated");
      }
      historicCellIds.add(cellId);
    }

    const receipt = restoreSnapshotReceipt(entry.receipt, stage);
    if (ticks.has(receipt.ledger.tick) || heads.has(receipt.ledger.head)) {
      throw new Error("snapshot memory operations contain a duplicate ledger binding");
    }
    ticks.add(receipt.ledger.tick);
    heads.add(receipt.ledger.head);

    const evaluationKey = operationFingerprint([
      "evaluation",
      stage.kind,
      derivation.siteHash,
      stage.originId,
    ]);
    if (expectedEvaluations.has(evaluationKey)) {
      throw new Error("snapshot memory operation has a duplicate evaluation identity");
    }
    expectedEvaluations.set(evaluationKey, entry.operationId);
    operations.set(entry.operationId, {
      fingerprint,
      derivation,
      status: "finalized",
      stage,
      ledger: receipt.ledger,
      receipt,
    });
  }

  const replay = new Map<string, ReplayRegionState>();
  const ordered = [...operations.values()].sort((left, right) =>
    left.receipt!.ledger.tick - right.receipt!.ledger.tick);
  for (const operation of ordered) {
    const stage = operation.stage;
    const current = replay.get(stage.regionKey) ?? {
      generation: 0,
      state: "open" as const,
      cells: [],
    };
    if (stage.kind === "store") {
      const reopening = current.state === "closed";
      const generation = reopening ? current.generation + 1 : current.generation;
      if (stage.generation !== generation
        || stage.effects.cells.upserted !== 1
        || stage.effects.cells.tombstoned !== 0) {
        throw new Error("snapshot store receipt conflicts with replayed memory state");
      }
      replay.set(stage.regionKey, {
        generation,
        state: "open",
        cells: [...(reopening ? [] : current.cells), stage],
      });
    } else {
      const alreadyForgotten = current.state === "closed";
      const tombstoned = alreadyForgotten ? 0 : current.cells.length;
      if (stage.generation !== current.generation
        || stage.alreadyForgotten !== alreadyForgotten
        || stage.effects.cells.upserted !== 0
        || stage.effects.cells.tombstoned !== tombstoned) {
        throw new Error("snapshot forget receipt conflicts with replayed memory state");
      }
      replay.set(stage.regionKey, {
        generation: current.generation,
        state: "closed",
        cells: [],
      });
    }
  }

  const liveCellIds = new Set<string>();
  for (const [regionKey, region] of regions) {
    const expected = replay.get(regionKey);
    if (!expected
      || expected.generation !== region.generation
      || expected.state !== region.state
      || expected.cells.length !== region.cells.length) {
      throw new Error("snapshot memory region conflicts with replayed receipts");
    }
    for (let index = 0; index < region.cells.length; index += 1) {
      const cell = region.cells[index]!;
      const stage = expected.cells[index]!;
      if (liveCellIds.has(cell.cellId)
        || cell.cellId !== stage.cellId
        || cell.operationId !== stage.operationId
        || cell.originId !== stage.originId
        || cell.value.valueHash !== stage.valueHash
        || cell.value.schemaHash !== stage.schemaHash) {
        throw new Error("snapshot live memory cell conflicts with replayed receipts");
      }
      liveCellIds.add(cell.cellId);
    }
  }

  const operationByEvaluation = new Map<string, string>();
  const mappedOperations = new Set<string>();
  for (const input of evaluationInputs) {
    const entry = snapshotRecord(input, "snapshot memory evaluation");
    snapshotKeys(entry, ["evaluationKey", "operationId"], "snapshot memory evaluation");
    snapshotPattern(entry.evaluationKey, SNAPSHOT_HASH, "snapshot memory evaluation key");
    snapshotPattern(entry.operationId, SNAPSHOT_OPERATION_ID, "snapshot memory evaluation operation id");
    if (expectedEvaluations.get(entry.evaluationKey) !== entry.operationId
      || operationByEvaluation.has(entry.evaluationKey)
      || mappedOperations.has(entry.operationId)) {
      throw new Error("snapshot memory evaluation mapping is not canonical");
    }
    operationByEvaluation.set(entry.evaluationKey, entry.operationId);
    mappedOperations.add(entry.operationId);
  }
  if (operationByEvaluation.size !== expectedEvaluations.size) {
    throw new Error("snapshot memory operation is missing its evaluation mapping");
  }

  return { regions, operations, operationByEvaluation };
}
function restoreOperationDerivation(input: unknown): OperationDerivation {
  const record = snapshotRecord(input, "snapshot memory operation derivation");
  snapshotKeys(
    record,
    ["evaluationOrdinal", "invocationHash", "region", "siteHash"],
    "snapshot memory operation derivation",
  );
  snapshotPattern(record.siteHash, SNAPSHOT_HASH, "snapshot memory operation site hash");
  snapshotPattern(record.invocationHash, SNAPSHOT_HASH, "snapshot memory invocation hash");
  snapshotNonnegativeInteger(record.evaluationOrdinal, "snapshot memory evaluation ordinal");
  return freezeDeep({
    siteHash: record.siteHash,
    invocationHash: record.invocationHash,
    evaluationOrdinal: record.evaluationOrdinal,
    region: restoreRegionDerivation(record.region),
  });
}

function restoreRegionDerivation(input: unknown): RegionDerivation {
  const record = snapshotRecord(input, "snapshot memory region derivation");
  snapshotKeys(record, ["descriptor", "dimensions"], "snapshot memory region derivation");
  const descriptor = snapshotClone(record.descriptor) as ResolvedMemoryDescriptor;
  hashMemoryDescriptor(descriptor);
  const dimensionsRecord = snapshotRecord(record.dimensions, "snapshot memory region dimensions");
  const expected = ["agent", "lineage"];
  if (descriptor.retention === "session") expected.push("session");
  if (descriptor.scopes.includes("project")) expected.push("project");
  if (descriptor.scopes.includes("user")) expected.push("user");
  snapshotKeys(dimensionsRecord, expected, "snapshot memory region dimensions");
  const dimensions: Record<string, string> = {};
  for (const key of expected) {
    snapshotPattern(dimensionsRecord[key], SNAPSHOT_HASH, `snapshot memory ${key} dimension`);
    dimensions[key] = dimensionsRecord[key];
  }
  return freezeDeep({ descriptor: freezeDeep(descriptor), dimensions });
}

function createRegionDerivation(
  descriptorInput: ResolvedMemoryDescriptor,
  region: Omit<MemoryRegionKeyInput, "descriptor">,
): RegionDerivation {
  const descriptor = snapshotClone(descriptorInput) as ResolvedMemoryDescriptor;
  hashMemoryDescriptor(descriptor);
  const dimensions: Record<string, string> = {
    lineage: snapshotOpaqueIdentity("lineage", region.sessionLineageId),
    agent: snapshotOpaqueIdentity("agent-instance", region.stableAgentInstanceId),
  };
  if (descriptor.retention === "session") {
    dimensions.session = snapshotOpaqueIdentity("session", region.sessionId);
  }
  if (descriptor.scopes.includes("project")) {
    if (region.projectSubject === undefined) {
      throw new Error("project-scoped memory requires a project subject");
    }
    dimensions.project = snapshotOpaqueIdentity("project", region.projectSubject);
  }
  if (descriptor.scopes.includes("user")) {
    if (!region.user?.verified) throw new Error("user-scoped memory requires a verified user identity");
    dimensions.user = snapshotSha("agape.memory-region.user.v1", {
      issuer: snapshotOpaqueIdentity("user-issuer", region.user.issuer),
      subject: snapshotOpaqueIdentity("user-subject", region.user.subject),
    });
  }
  return freezeDeep({ descriptor: freezeDeep(descriptor), dimensions });
}

function deriveSnapshotRegionKey(derivation: RegionDerivation): string {
  return `memory-region-v1:${snapshotSha("agape.memory-region.key.v1", {
    descriptor: hashMemoryDescriptor(derivation.descriptor),
    ...derivation.dimensions,
  })}`;
}

function deriveSnapshotScopeHash(derivation: RegionDerivation): string {
  const scopes = [...derivation.descriptor.scopes].sort(bytewiseCompare);
  const dimensions: Record<string, string> = {};
  if (scopes.includes("project")) dimensions.project = derivation.dimensions.project!;
  if (scopes.includes("user")) dimensions.user = derivation.dimensions.user!;
  return snapshotSha("agape.memory.scope-tuple.v1", { scopes, dimensions });
}

function snapshotOpaqueIdentity(domain: string, value: string): string {
  assertNonblank(value, domain);
  return snapshotSha(`agape.memory-region.${domain}.v1`, value);
}

function snapshotOpaqueField(domain: string, value: string): string {
  assertNonblank(value, domain);
  return snapshotSha(`agape.named-memory-private.${domain}.v1`, value);
}

function restoreSnapshotStage(input: unknown): PreparedNamedMemoryMutation {
  const stage = snapshotRecord(input, "snapshot memory operation stage");
  const common = [
    "descriptorHash", "effects", "generation", "kind", "operationId",
    "originId", "refs", "regionKey", "schemaHash", "scopeHash",
  ];
  if (stage.kind === "store") {
    snapshotKeys(stage, [...common, "cellId", "valueHash"], "snapshot store stage");
  } else if (stage.kind === "forget") {
    snapshotKeys(stage, [...common, "alreadyForgotten"], "snapshot forget stage");
  } else {
    throw new Error("snapshot memory operation kind is invalid");
  }
  snapshotPattern(stage.operationId, SNAPSHOT_OPERATION_ID, "snapshot memory operation id");
  snapshotPattern(stage.regionKey, SNAPSHOT_REGION_KEY, "snapshot memory region key");
  snapshotPattern(stage.originId, SNAPSHOT_ORIGIN_ID, "snapshot memory origin id");
  snapshotPattern(stage.descriptorHash, SNAPSHOT_HASH, "snapshot memory descriptor hash");
  snapshotPattern(stage.schemaHash, SNAPSHOT_HASH, "snapshot memory schema hash");
  snapshotPattern(stage.scopeHash, SNAPSHOT_HASH, "snapshot memory scope hash");
  snapshotNonnegativeInteger(stage.generation, "snapshot memory generation");

  const effects = snapshotRecord(stage.effects, "snapshot memory effects");
  snapshotKeys(effects, ["cells"], "snapshot memory effects");
  const cellEffects = snapshotRecord(effects.cells, "snapshot memory cell effects");
  snapshotKeys(cellEffects, ["tombstoned", "upserted"], "snapshot memory cell effects");
  snapshotNonnegativeInteger(cellEffects.upserted, "snapshot memory upsert count");
  snapshotNonnegativeInteger(cellEffects.tombstoned, "snapshot memory tombstone count");
  const restoredEffects = freezeDeep({
    cells: { upserted: cellEffects.upserted, tombstoned: cellEffects.tombstoned },
  });
  const refs = snapshotRecord(stage.refs, "snapshot memory references");

  if (stage.kind === "store") {
    snapshotPattern(stage.cellId, SNAPSHOT_CELL_ID, "snapshot memory cell id");
    snapshotPattern(stage.valueHash, SNAPSHOT_HASH, "snapshot memory value hash");
    snapshotKeys(refs, ["cell", "origin", "region", "value"], "snapshot store references");
    if (refs.region !== stage.regionKey || refs.origin !== stage.originId
      || refs.cell !== stage.cellId || refs.value !== `memory-value-v1:${stage.valueHash}`) {
      throw new Error("snapshot store references conflict with its stage");
    }
    return freezeDeep({
      operationId: stage.operationId,
      kind: "store" as const,
      regionKey: stage.regionKey,
      originId: stage.originId,
      cellId: stage.cellId,
      generation: stage.generation,
      descriptorHash: stage.descriptorHash,
      schemaHash: stage.schemaHash,
      scopeHash: stage.scopeHash,
      valueHash: stage.valueHash,
      effects: restoredEffects,
      refs: { region: refs.region, value: refs.value, origin: refs.origin, cell: refs.cell },
    });
  }

  if (typeof stage.alreadyForgotten !== "boolean") {
    throw new Error("snapshot forget state is invalid");
  }
  snapshotKeys(refs, ["origin", "region"], "snapshot forget references");
  if (refs.region !== stage.regionKey || refs.origin !== stage.originId) {
    throw new Error("snapshot forget references conflict with its stage");
  }
  return freezeDeep({
    operationId: stage.operationId,
    kind: "forget" as const,
    regionKey: stage.regionKey,
    originId: stage.originId,
    generation: stage.generation,
    descriptorHash: stage.descriptorHash,
    schemaHash: stage.schemaHash,
    scopeHash: stage.scopeHash,
    effects: restoredEffects,
    refs: { region: refs.region, origin: refs.origin },
    alreadyForgotten: stage.alreadyForgotten,
  });
}
function restoreSnapshotReceipt(
  input: unknown,
  expectedStage: PreparedNamedMemoryMutation,
): NamedMemoryMutationReceipt {
  const receipt = snapshotRecord(input, "snapshot memory receipt");
  snapshotKeys(receipt, [...Object.keys(expectedStage), "ledger"], "snapshot memory receipt");
  const stageInput: Record<string, unknown> = {};
  for (const key of Object.keys(receipt)) {
    if (key !== "ledger") stageInput[key] = receipt[key];
  }
  const restoredStage = restoreSnapshotStage(stageInput);
  if (snapshotCanonicalJson(restoredStage) !== snapshotCanonicalJson(expectedStage)) {
    throw new Error("snapshot memory receipt conflicts with its operation stage");
  }
  const ledgerRecord = snapshotRecord(receipt.ledger, "snapshot ledger commit binding");
  snapshotKeys(ledgerRecord, ["head", "tick"], "snapshot ledger commit binding");
  const ledger = validateBinding({
    tick: ledgerRecord.tick as number,
    head: ledgerRecord.head as string,
  });
  return freezeDeep({ ...expectedStage, ledger });
}

function restoreSnapshotCell(
  input: unknown,
  descriptor: ResolvedMemoryDescriptor,
): NamedMemoryCell {
  const cell = snapshotRecord(input, "snapshot memory cell");
  snapshotKeys(cell, ["cellId", "operationId", "originId", "value"], "snapshot memory cell");
  snapshotPattern(cell.cellId, SNAPSHOT_CELL_ID, "snapshot memory cell id");
  snapshotPattern(cell.operationId, SNAPSHOT_OPERATION_ID, "snapshot memory cell operation id");
  snapshotPattern(cell.originId, SNAPSHOT_ORIGIN_ID, "snapshot memory cell origin id");
  const value = snapshotClone(cell.value) as ExactValueEnvelope;
  decodeExactValue(value, descriptor.schema);
  return freezeDeep({
    cellId: cell.cellId,
    operationId: cell.operationId,
    originId: cell.originId,
    value: freezeDeep(value),
  });
}

function assertCanonicalSnapshotData(value: unknown, active: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("snapshot data contains a non-finite number");
    return;
  }
  if (typeof value !== "object") throw new Error("snapshot data contains an unsupported value");
  if (active.has(value)) throw new Error("snapshot data must not contain cycles");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype
        || Object.getOwnPropertySymbols(value).length !== 0) {
        throw new Error("snapshot arrays must be canonical plain arrays");
      }
      const keys = Object.keys(value);
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1
        || ownKeys.some((key) => typeof key !== "string")
        || ownKeys.filter((key) => key !== "length")
          .some((key, index) => key !== String(index))
        || keys.length !== value.length
        || keys.some((key, index) => key !== String(index))) {
        throw new Error("snapshot arrays must be dense without custom fields");
      }
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("snapshot arrays must not contain accessors");
        }
        assertCanonicalSnapshotData(descriptor.value, active);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null)
      || Object.getOwnPropertySymbols(value).length !== 0) {
      throw new Error("snapshot records must be plain objects without symbols");
    }
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("snapshot records must not contain accessors");
      }
      assertCanonicalSnapshotData(descriptor.value, active);
    }
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
      throw new Error("snapshot records must not contain hidden fields");
    }
  } finally {
    active.delete(value);
  }
}

function snapshotClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => snapshotClone(item)) as T;
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: snapshotClone(child),
        writable: true,
      });
    }
    return clone as T;
  }
  return value;
}

function snapshotRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function snapshotArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function snapshotKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort(bytewiseCompare);
  const canonical = [...expected].sort(bytewiseCompare);
  if (actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function snapshotPattern(
  value: unknown,
  pattern: RegExp,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function snapshotNonnegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function snapshotCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("snapshot canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(snapshotCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(bytewiseCompare);
    return `{${keys.map((key) =>
      `${JSON.stringify(key)}:${snapshotCanonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`snapshot canonical JSON rejects ${typeof value}`);
}

function snapshotSha(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(snapshotCanonicalJson(value), "utf8")
    .digest("hex");
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
