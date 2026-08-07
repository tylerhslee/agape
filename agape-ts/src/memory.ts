// Memory substrate drivers for Agape private memory.
//
// The interpreter owns Agape semantics: per-agent isolation, ledger receipts,
// taint, and authority. A driver only stores, indexes, retrieves, and forgets
// memory cells behind that semantic boundary.

import { render, type Value } from "./runtime.js";

export interface MemoryScope {
  agentInstanceId: string;
  agentAlias: string;
  mem: string;
  project?: string;
  user?: string;
}

export interface MemoryStoredCell {
  id?: string;
  memory: string;
  score?: number;
  value?: Value;
  typed?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  generation?: number;
}

/**
 * Structured context for the episode behind a write: what act produced the
 * value. Runtime writes are explicit source operations; cognition replies do
 * not silently become memory.
 */
export interface MemoryEpisode {
  act: "store";
}

/**
 * WHO the originating episode came from: the attestation identity of the
 * prompt delivery whose reaction produced this write. Carried additively as
 * metadata.provenance on the stored cell; reactions with no originating
 * prompt delivery (heartbeat ticks, spawn hooks) omit it rather than invent
 * an attester.
 */
export interface MemoryProvenance {
  attester: string;
  prompt_name: string;
}

export interface MemoryWriteRequest {
  scope: MemoryScope;
  value: Value;
  memory: string;
  episode?: MemoryEpisode;
  summary: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface MemoryConsultRequest {
  scope: MemoryScope;
  query: string;
  topK?: number;
}

export interface MemoryForgetRequest {
  scope: MemoryScope;
}

export interface MemoryReceipt {
  status?: string;
  eventId?: string;
  ids?: string[];
  /** The recollection text the runtime stored (or considered, for skipped/deduped writes). */
  memory?: string;
  effects?: Record<string, unknown>;
  refs?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  generation?: number;
  alreadyForgotten?: boolean;
}

export interface MemoryConsultResult {
  hits: MemoryStoredCell[];
  recalled: string;
  candidates: Record<string, unknown>[];
}

export interface MemoryDriver {
  readonly capabilities?: { retentions: readonly ("session" | "durable")[] };
  declare?(scope: MemoryScope): void | Promise<void>;
  internalize(req: MemoryWriteRequest): Promise<MemoryReceipt>;
  consult(req: MemoryConsultRequest): Promise<MemoryConsultResult>;
  forget(req: MemoryForgetRequest): Promise<MemoryReceipt>;
}

export function memoryScopeKey(scope: MemoryScope): string {
  return `${scope.project ?? ""}\u0000${scope.user ?? ""}\u0000${scope.agentInstanceId}\u0000${scope.mem}`;
}

export class LocalMemoryDriver implements MemoryDriver {
  readonly capabilities = { retentions: ["session"] as const };
  private regions = new Map<string, { writes: MemoryStoredCell[]; generation: number; closed: boolean; sequence: number }>();

  async declare(scope: MemoryScope): Promise<void> {
    const key = memoryScopeKey(scope);
    if (!this.regions.has(key)) this.regions.set(key, { writes: [], generation: 0, closed: false, sequence: 0 });
  }

  async internalize(req: MemoryWriteRequest): Promise<MemoryReceipt> {
    const region = this.region(req.scope, true);
    if (region.closed) {
      region.generation += 1;
      region.closed = false;
      region.writes = [];
    }
    region.sequence += 1;
    const id = `local:g${region.generation}:c${String(region.sequence).padStart(8, "0")}`;
    region.writes.push({
      id,
      memory: req.memory,
      value: req.value,
      metadata: req.metadata,
      typed: req.summary,
      generation: region.generation,
    });
    return {
      status: "APPENDED",
      ids: [id],
      generation: region.generation,
      effects: {
        cells: { upserted: 1, tombstoned: 0, deleted: 0 },
        facts: { upserted: 0, tombstoned: 0, deleted: 0 },
        graph: {
          nodes_upserted: 0,
          edges_upserted: 0,
          nodes_tombstoned: 0,
          edges_tombstoned: 0,
          nodes_deleted: 0,
          edges_deleted: 0,
        },
        vectors: { chunks_upserted: 0, chunks_deleted: 0, embeddings_deleted: 0 },
        blobs: { archived: 0, redacted: 0, deleted: 0 },
      },
    };
  }

  async consult(req: MemoryConsultRequest): Promise<MemoryConsultResult> {
    const region = this.region(req.scope);
    const hits = region.closed ? [] : [...region.writes]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || String(a.id).localeCompare(String(b.id)))
      .slice(0, req.topK ?? region.writes.length);
    const recalled = hits.map(renderStoredCell).join("\n");
    return {
      hits,
      recalled,
      candidates: hits.map(memoryCandidate),
    };
  }

  async forget(req: MemoryForgetRequest): Promise<MemoryReceipt> {
    const region = this.region(req.scope);
    const alreadyForgotten = region.closed;
    const count = region.writes.length;
    if (!alreadyForgotten) {
      region.writes = [];
      region.closed = true;
    }
    return {
      status: alreadyForgotten ? "ALREADY_FORGOTTEN" : "TOMBSTONED",
      generation: region.generation,
      alreadyForgotten,
      effects: {
        cells: { upserted: 0, tombstoned: alreadyForgotten ? 0 : count, deleted: 0 },
        facts: { upserted: 0, tombstoned: 0, deleted: 0 },
        graph: {
          nodes_upserted: 0,
          edges_upserted: 0,
          nodes_tombstoned: 0,
          edges_tombstoned: 0,
          nodes_deleted: 0,
          edges_deleted: 0,
        },
        vectors: { chunks_upserted: 0, chunks_deleted: 0, embeddings_deleted: 0 },
        blobs: { archived: 0, redacted: 0, deleted: 0 },
      },
    };
  }

  private region(scope: MemoryScope, create = false): { writes: MemoryStoredCell[]; generation: number; closed: boolean; sequence: number } {
    const key = memoryScopeKey(scope);
    let region = this.regions.get(key);
    if (!region && create) {
      region = { writes: [], generation: 0, closed: false, sequence: 0 };
      this.regions.set(key, region);
    }
    if (!region) throw new Error(`memory '${scope.mem}' is not declared for agent '${scope.agentAlias}'`);
    return region;
  }
}

export function memoryCandidate(hit: MemoryStoredCell): Record<string, unknown> {
  return {
    id: hit.id,
    memory: hit.memory,
    score: hit.score,
    metadata: hit.metadata,
  };
}

function renderStoredCell(hit: MemoryStoredCell): string {
  if (hit.value) return render(hit.value);
  return hit.memory;
}
