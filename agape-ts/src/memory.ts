// Memory substrate drivers for Agape private memory.
//
// The interpreter owns Agape semantics: per-agent isolation, ledger receipts,
// taint, and authority. A driver only stores, indexes, retrieves, and forgets
// memory cells behind that semantic boundary.

import { render, type Value } from "./runtime.js";

export interface MemoryScope {
  agent: string;
  mem: string;
  project?: string;
}

export interface MemoryStoredCell {
  id?: string;
  memory: string;
  score?: number;
  value?: Value;
  metadata?: Record<string, unknown>;
}

/**
 * Structured context for the episode behind a write: what act produced the
 * value (an explicit store into a mem region, or a provider reply being
 * auto-internalized) and, for replies, the asking prompt. The memory runtime
 * renders recollection text from this — callers pass the episode, not prose.
 */
export interface MemoryEpisode {
  act: "store" | "provider_reply";
  /** The asking prompt behind a provider reply (compacted). */
  prompt?: string;
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
}

export interface MemoryConsultResult {
  hits: MemoryStoredCell[];
  recalled: string;
  candidates: Record<string, unknown>[];
}

export interface MemoryDriver {
  declare?(scope: MemoryScope): void | Promise<void>;
  internalize(req: MemoryWriteRequest): Promise<MemoryReceipt>;
  consult(req: MemoryConsultRequest): Promise<MemoryConsultResult>;
  forget(req: MemoryForgetRequest): Promise<MemoryReceipt>;
}

export function memoryScopeKey(scope: MemoryScope): string {
  return `${scope.project ?? ""}\u0000${scope.agent}\u0000${scope.mem}`;
}

export class LocalMemoryDriver implements MemoryDriver {
  private regions = new Map<string, { writes: MemoryStoredCell[]; forgotten: boolean }>();

  async declare(scope: MemoryScope): Promise<void> {
    this.regions.set(memoryScopeKey(scope), { writes: [], forgotten: false });
  }

  async internalize(req: MemoryWriteRequest): Promise<MemoryReceipt> {
    const region = this.region(req.scope, true);
    if (region.forgotten) throw new Error(`memory '${req.scope.mem}' was forgotten`);
    region.writes.push({
      id: `local:${region.writes.length + 1}`,
      memory: req.memory,
      value: req.value,
      metadata: req.metadata,
    });
    return {};
  }

  async consult(req: MemoryConsultRequest): Promise<MemoryConsultResult> {
    const region = this.region(req.scope);
    if (region.forgotten) throw new Error(`memory '${req.scope.mem}' was forgotten`);
    const hits = region.writes.slice(-(req.topK ?? region.writes.length));
    const recalled = hits.length ? renderStoredCell(hits[hits.length - 1]!) : "";
    return {
      hits,
      recalled,
      candidates: hits.map(memoryCandidate),
    };
  }

  async forget(req: MemoryForgetRequest): Promise<MemoryReceipt> {
    const region = this.region(req.scope);
    const count = region.writes.length;
    region.writes = [];
    region.forgotten = true;
    return {
      effects: {
        facts: { upserted: 0, tombstoned: count, deleted: 0 },
        graph: {
          nodes_upserted: 0,
          edges_upserted: 0,
          nodes_tombstoned: count,
          edges_tombstoned: 0,
          nodes_deleted: 0,
          edges_deleted: 0,
        },
        vectors: { chunks_upserted: 0, chunks_deleted: count, embeddings_deleted: count },
        blobs: { archived: count, redacted: 0, deleted: 0 },
      },
    };
  }

  private region(scope: MemoryScope, create = false): { writes: MemoryStoredCell[]; forgotten: boolean } {
    const key = memoryScopeKey(scope);
    let region = this.regions.get(key);
    if (!region && create) {
      region = { writes: [], forgotten: false };
      this.regions.set(key, region);
    }
    if (!region) throw new Error(`memory '${scope.mem}' is not declared for agent '${scope.agent}'`);
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
