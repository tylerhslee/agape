// The SPEC 16.7 memory-envelope TEST-MODE surface for the runtime conformance adapter.
//
// The kernel runtime's memory substrate (src/memory.ts) stores/consults whole cells behind the
// `mem` handle semantics; the artifact-decomposition envelope the runtime contract describes
// (whole-artifact summary + chunks + typed facts + graph triples + vectors, each with ledger
// provenance) is implemented HERE, in the conformance adapter, as deterministic test-mode
// machinery. It fabricates no ledger facts — every cell records the real adapter-session ledger
// tick that produced it — but the decomposition itself is adapter code, not kernel code.

import { createHash } from "node:crypto";

export interface EnvelopeCell {
  originTick: number;
  taint: "settled" | "graded" | "raw";
  sourceHash?: string;
  text: string;
  key?: string;
  kind: string;
  basisHead?: number;
  validThrough?: number;
  dependencyScope?: string[] | "global";
  [key: string]: unknown;
}

export interface AgentEnvelope {
  summaries: EnvelopeCell[];
  chunks: EnvelopeCell[];
  facts: EnvelopeCell[];
  triples: EnvelopeCell[];
  vectors: EnvelopeCell[];
  lessons: EnvelopeCell[];
  corrections: EnvelopeCell[];
  ingestedHashes: Map<string, string>; // uri -> sourceHash
}

export type EnvelopeOp =
  | { op: "ingest"; agent: string; uri: string; sourceHash: string; cells: StoredDecomposition }
  | { op: "lesson"; agent: string; cell: EnvelopeCell }
  | { op: "correction"; agent: string; cell: EnvelopeCell };

export interface StoredDecomposition {
  summary: EnvelopeCell;
  chunks: EnvelopeCell[];
  facts: EnvelopeCell[];
  triples: EnvelopeCell[];
  vectors: EnvelopeCell[];
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export class MemoryEnvelope {
  private agents = new Map<string, AgentEnvelope>();
  /** append-only op journal, snapshotted into recordings for rebuildMemoryFromRecording. */
  readonly ops: EnvelopeOp[] = [];

  agentFor(instanceId: string): AgentEnvelope {
    let env = this.agents.get(instanceId);
    if (!env) {
      env = {
        summaries: [], chunks: [], facts: [], triples: [], vectors: [],
        lessons: [], corrections: [], ingestedHashes: new Map(),
      };
      this.agents.set(instanceId, env);
    }
    return env;
  }

  agentIds(): string[] {
    return [...this.agents.keys()];
  }

  /** Deterministic artifact decomposition. Returns null when the artifact is unchanged (idempotent). */
  decompose(
    instanceId: string,
    artifact: { kind: string; uri: string; title: string; text: string },
    originTick: number,
  ): { created: boolean; sourceHash: string; stored?: StoredDecomposition } {
    const env = this.agentFor(instanceId);
    const sourceHash = sha256Hex(artifact.text);
    if (env.ingestedHashes.get(artifact.uri) === sourceHash) {
      return { created: false, sourceHash };
    }
    const base = { originTick, taint: "raw" as const, sourceHash };
    const lines = artifact.text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const bodyLines = lines.filter((l) => !l.startsWith("#"));
    const headings = lines.filter((l) => l.startsWith("#")).map((l) => l.replace(/^#+\s*/, ""));

    // chunks: split on markdown headings; a heading-less artifact is one chunk.
    const chunks: EnvelopeCell[] = [];
    let current: string[] = [];
    let currentTitle = artifact.title;
    const flush = () => {
      if (current.length || chunks.length === 0) {
        chunks.push({ ...base, kind: "chunk", key: `${artifact.uri}#${chunks.length}`, text: `${currentTitle}\n${current.join("\n")}` });
      }
      current = [];
    };
    for (const line of lines) {
      if (line.startsWith("#")) {
        if (current.length || chunks.length > 0) flush();
        currentTitle = line.replace(/^#+\s*/, "");
      } else {
        current.push(line);
      }
    }
    flush();

    const summary: EnvelopeCell = {
      ...base,
      kind: "summary",
      key: artifact.uri,
      text: `${artifact.title}: ${bodyLines[0] ?? artifact.title} (${chunks.length} sections)`,
    };
    const facts: EnvelopeCell[] = bodyLines.map((line, i) => ({
      ...base, kind: "fact", key: `${artifact.uri}#fact${i}`, text: line,
    }));
    const triples: EnvelopeCell[] = (headings.length ? headings : [artifact.title]).map((h) => ({
      ...base, kind: "triple", key: `${artifact.title}|has_section|${h}`,
      text: `${artifact.title} has_section ${h}`, s: artifact.title, p: "has_section", o: h,
    }));
    const vectors: EnvelopeCell[] = chunks.map((c, i) => ({
      ...base, kind: "vector", key: `${artifact.uri}#vec${i}`, text: c.text,
    }));

    const stored: StoredDecomposition = { summary, chunks, facts, triples, vectors };
    this.applyIngest(instanceId, artifact.uri, sourceHash, stored);
    this.ops.push({ op: "ingest", agent: instanceId, uri: artifact.uri, sourceHash, cells: stored });
    return { created: true, sourceHash, stored };
  }

  applyIngest(instanceId: string, uri: string, sourceHash: string, stored: StoredDecomposition): void {
    const env = this.agentFor(instanceId);
    env.ingestedHashes.set(uri, sourceHash);
    env.summaries.push(stored.summary);
    env.chunks.push(...stored.chunks);
    env.facts.push(...stored.facts);
    env.triples.push(...stored.triples);
    env.vectors.push(...stored.vectors);
  }

  addLesson(instanceId: string, cell: EnvelopeCell): void {
    this.agentFor(instanceId).lessons.push(cell);
    this.ops.push({ op: "lesson", agent: instanceId, cell });
  }

  addCorrection(instanceId: string, cell: EnvelopeCell): void {
    this.agentFor(instanceId).corrections.push(cell);
    this.ops.push({ op: "correction", agent: instanceId, cell });
  }

  counts(instanceId: string): Record<string, number> & { summaries: number; chunks: number; facts: number; triples: number; vectors: number } {
    const env = this.agentFor(instanceId);
    return {
      summaries: env.summaries.length,
      chunks: env.chunks.length,
      facts: env.facts.length,
      triples: env.triples.length,
      vectors: env.vectors.length,
      lessons: env.lessons.length,
      corrections: env.corrections.length,
    };
  }

  /**
   * Rank an agent's cells against a task. User corrections always outrank inferred lessons
   * (SPEC 16.7 precedence); within a band, plain token overlap orders the rest.
   */
  // NOTE: `corrections` is placed before `lessons` both in the returned object and in `text` —
  // user corrections outrank inferred lessons (SPEC 16.7 precedence), and the suite asserts the
  // serialized packet preserves that order.
  context(instanceId: string, task: string): {
    consulted: boolean; empty: boolean;
    corrections: string[]; lessons: string[];
    summaries: string[]; chunks: string[]; facts: string[];
    text: string;
  } {
    const env = this.agentFor(instanceId);
    const score = (text: string): number => {
      const taskTokens = new Set(tokenize(task));
      let hits = 0;
      for (const tok of tokenize(text)) if (taskTokens.has(tok)) hits++;
      return hits;
    };
    const pick = (cells: EnvelopeCell[], topK: number): string[] =>
      cells
        .map((c) => ({ c, s: score(c.text) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, topK)
        .map((x) => x.c.text);
    const corrections = pick(env.corrections, 4);
    const lessons = pick(env.lessons, 6);
    const summaries = pick(env.summaries, 3);
    const chunks = pick(env.chunks, 4);
    const facts = pick(env.facts, 6);
    const empty =
      env.summaries.length + env.chunks.length + env.facts.length + env.triples.length +
      env.vectors.length + env.lessons.length + env.corrections.length === 0;
    const text = [...corrections, ...lessons, ...summaries, ...chunks, ...facts].join("\n");
    return { consulted: true, empty, corrections, lessons, summaries, chunks, facts, text };
  }

  totalCells(instanceId: string): number {
    const c = this.counts(instanceId);
    return c.summaries + c.chunks + c.facts + c.triples + c.vectors;
  }

  snapshotOps(): EnvelopeOp[] {
    return JSON.parse(JSON.stringify(this.ops)) as EnvelopeOp[];
  }

  /** Rebuild a fresh envelope from a recorded op journal — no decomposition/embedding re-runs. */
  static rebuild(ops: EnvelopeOp[]): MemoryEnvelope {
    const env = new MemoryEnvelope();
    for (const op of ops) {
      if (op.op === "ingest") env.applyIngest(op.agent, op.uri, op.sourceHash, op.cells);
      else if (op.op === "lesson") env.agentFor(op.agent).lessons.push(op.cell);
      else env.agentFor(op.agent).corrections.push(op.cell);
    }
    return env;
  }
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
}
