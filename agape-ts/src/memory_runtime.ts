// Runtime memory intelligence layered over any Agape MemoryDriver substrate.
//
// Substrates persist and recall cells. This wrapper owns the default Agape
// memory behavior that should not be reimplemented per app: write judgment,
// classification, reflection, dedupe/consolidation, and recall re-ranking.

import { createHash } from "node:crypto";
import type { Provider } from "./runtime.js";
import {
  memoryCandidate,
  type MemoryConsultRequest,
  type MemoryConsultResult,
  type MemoryDriver,
  type MemoryForgetRequest,
  type MemoryReceipt,
  type MemoryScope,
  type MemoryStoredCell,
  type MemoryWriteRequest,
} from "./memory.js";

export type MemoryKind = "preference" | "fact" | "procedure" | "decision" | "interaction" | "note";

export interface MemoryRuntimeConfig {
  auto_memory?: boolean;
  classify?: boolean;
  dedupe?: boolean;
  dedupe_threshold?: number;
  recall_pool?: number;
  domain_terms?: string[] | string;
  /**
   * Provider-assisted reflection (the prose form of §16.7 decomposition):
   * before a cell is stored, the provider rewrites the raw episode as a short
   * first-person memory — concrete facts, preferences, and instructions kept;
   * greetings, filler, and formatting noise dropped. Opt-in (default false):
   * reflection costs one cognition call per store, and the mock provider's
   * deterministic reply makes it replay-stable but uninformative, so offline
   * runs should leave it off. Requires a provider handle; without one the
   * write path is unchanged. The receipt records the outcome (reflected /
   * raw fallback) and the cell keeps the raw episode's canonical hash for
   * provenance.
   */
  reflect?: boolean;
  [key: string]: unknown;
}

interface ClassifiedMemory {
  kind: MemoryKind;
  tags: string[];
  signal: number;
  reason: string;
}

const STOP_WORDS = new Set([
  "about", "after", "again", "agent", "also", "answer", "because", "before", "being",
  "could", "does", "from", "have", "into", "memory", "more", "need", "notes", "only", "private",
  "provider", "question", "received", "reply", "should", "stored", "than", "that", "their", "there",
  "thing", "this", "through", "value", "when", "where", "with", "would", "your",
]);

const PREFERENCE_TERMS = new Set([
  "avoid", "conservative", "favorite", "format", "likes", "prefer", "prefers", "preference",
  "risk", "style", "tone", "wants",
]);
const FACT_TERMS = new Set(["fact", "facts", "has", "is", "league", "roster", "scoring", "setting", "settings"]);
const PROCEDURE_TERMS = new Set(["build", "command", "debug", "npm", "pnpm", "process", "run", "step", "test", "workflow"]);
const DECISION_TERMS = new Set(["chose", "decision", "decided", "outcome", "picked", "recommend", "recommended", "selected"]);

export class MemoryRuntimeDriver implements MemoryDriver {
  constructor(
    public readonly substrate: MemoryDriver,
    private readonly cfg: MemoryRuntimeConfig = {},
    private readonly provider?: Provider,
  ) {}

  async declare(scope: MemoryScope): Promise<void> {
    await this.substrate.declare?.(scope);
  }

  async internalize(req: MemoryWriteRequest): Promise<MemoryReceipt> {
    const raw = compactText(req.memory);
    let classification = this.classify(raw, req);
    const source = stringMetadata(req.metadata, "source");
    const explicitStore = source !== "provider_reply";
    // episode_prompt is reflection input from the interpreter (the raw
    // exchange behind a provider reply). The runtime consumes it here — it
    // must not reach the substrate, so the reflect-off disk output stays
    // byte-identical to the pre-reflection runtime.
    const { episode_prompt: _consumed, ...passthroughMetadata } = req.metadata ?? {};

    // Judgment and dedupe run on the RAW episode, before any cognition is
    // spent on it: junk is skipped and repeats are suppressed for free.
    if (!explicitStore && this.autoMemoryEnabled() && !worthRemembering(raw, classification)) {
      return skippedReceipt("SKIPPED", "low_signal_auto_memory", classification, this.policy());
    }

    if (this.dedupeEnabled() && raw) {
      const duplicate = await this.findDuplicate(req.scope, raw);
      if (duplicate) {
        return dedupedReceipt(duplicate, classification, this.policy());
      }
    }

    // Reflection: rewrite the surviving episode as a first-person prose
    // memory, working from the raw episode (rendered value + exchange
    // context) rather than the interpreter's recollection template, so no
    // storage scaffolding leaks into the prose. Non-deterministic but
    // shape-fixed (plain text); the receipt carries the stored prose and the
    // cell keeps the raw hash, so the rewrite never hides what happened.
    let memory = raw;
    let reflection: "reflected" | "empty_fallback_raw" | "failed_fallback_raw" | undefined;
    if (this.reflectEnabled() && raw) {
      try {
        const prose = compactText(await this.provider!.reply(reflectionPrompt(episodeText(req) ?? raw)));
        if (prose) {
          memory = prose;
          reflection = "reflected";
          classification = this.classify(memory, req); // tags/kind must describe what recall will see
        } else {
          reflection = "empty_fallback_raw";
        }
      } catch {
        reflection = "failed_fallback_raw";
      }
    }

    const metadata = {
      ...passthroughMetadata,
      memory_kind: classification.kind,
      memory_tags: classification.tags,
      memory_signal: classification.signal,
      memory_reason: classification.reason,
      canonical_hash: canonicalHash(memory),
      ...(reflection ? { memory_reflection: reflection, reflected_from_hash: canonicalHash(raw) } : {}),
    };

    const receipt = await this.substrate.internalize({ ...req, memory, metadata });
    return enrichReceipt(
      reflection === "reflected"
        ? { ...receipt, refs: { ...(receipt.refs ?? {}), stored_memory: memory } }
        : receipt,
      classification,
      this.policy(reflection),
    );
  }

  async consult(req: MemoryConsultRequest): Promise<MemoryConsultResult> {
    const topK = clampInt(req.topK ?? undefined, 1, 1000, 10);
    const poolK = Math.max(topK, clampInt(this.cfg.recall_pool, topK, 5000, topK * 4));
    const domainTerms = this.domainTerms();
    const expandedQuery = expandQuery(req.query, domainTerms);
    const result = await this.substrate.consult({ ...req, query: expandedQuery, topK: poolK });
    const queryProfile = queryKindProfile(req.query);
    const queryTerms = contentTerms(req.query);
    const ranked = result.hits
      .map((hit, index) => rerankHit(hit, index, queryTerms, queryProfile, domainTerms))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const hits = ranked.slice(0, topK);
    return {
      hits,
      recalled: hits.map((h) => h.memory).join("\n\n"),
      candidates: hits.map(memoryCandidate),
    };
  }

  async forget(req: MemoryForgetRequest): Promise<MemoryReceipt> {
    return enrichPolicy(await this.substrate.forget(req), this.policy());
  }

  private async findDuplicate(scope: MemoryScope, memory: string): Promise<MemoryStoredCell | undefined> {
    const consulted = await this.substrate.consult({ scope, query: memory, topK: 24 });
    const threshold = clampNumber(this.cfg.dedupe_threshold, 0.5, 1, 0.9);
    let best: { hit: MemoryStoredCell; score: number } | undefined;
    for (const hit of consulted.hits) {
      const score = similarity(memory, hit.memory);
      if (score >= threshold && (!best || score > best.score)) best = { hit, score };
    }
    return best?.hit;
  }

  private classify(memory: string, req: MemoryWriteRequest): ClassifiedMemory {
    if (this.cfg.classify === false) {
      return { kind: "note", tags: [], signal: 1, reason: "classification_disabled" };
    }
    const source = stringMetadata(req.metadata, "source");
    const rendered = typeof req.summary.rendered === "string" ? req.summary.rendered : "";
    const terms = new Set([...contentTerms(memory), ...contentTerms(rendered)]);
    const score = (words: Set<string>) => [...terms].filter((t) => words.has(t)).length;
    const pref = score(PREFERENCE_TERMS);
    const proc = score(PROCEDURE_TERMS);
    const dec = score(DECISION_TERMS);
    const fact = score(FACT_TERMS);
    const signal = terms.size + pref * 3 + proc * 2 + dec * 2 + fact;
    const kind: MemoryKind = source === "provider_reply" && signal < 8 ? "interaction"
      : pref > 0 ? "preference"
      : proc > 0 ? "procedure"
      : dec > 0 ? "decision"
      : fact > 0 ? "fact"
      : source === "provider_reply" ? "interaction"
      : "note";
    const tags = [...terms]
      .filter((t) => !STOP_WORDS.has(t))
      .slice(0, 16);
    return { kind, tags, signal, reason: classificationReason(kind, source, signal) };
  }

  private autoMemoryEnabled(): boolean {
    return this.cfg.auto_memory !== false;
  }

  private dedupeEnabled(): boolean {
    return this.cfg.dedupe !== false;
  }

  private reflectEnabled(): boolean {
    return this.cfg.reflect === true && this.provider !== undefined;
  }

  private domainTerms(): string[] {
    const raw = this.cfg.domain_terms;
    const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
    return Array.from(new Set(parts.flatMap((p) => contentTerms(String(p)))));
  }

  private policy(reflection?: string): Record<string, unknown> {
    return {
      memory_runtime: "agape-default",
      auto_memory: this.autoMemoryEnabled(),
      classify: this.cfg.classify !== false,
      dedupe: this.dedupeEnabled(),
      dedupe_threshold: clampNumber(this.cfg.dedupe_threshold, 0.5, 1, 0.9),
      reflect: this.reflectEnabled(),
      ...(reflection ? { reflection } : {}),
      recall: "substrate_pool_then_runtime_rerank",
    };
  }
}

// The raw episode behind a write request, reconstructed from parts the
// request already carries: the rendered value (summary.rendered), the memory
// scope, and — for provider replies — the episode_prompt the interpreter
// forwards. This is what reflection should read, NOT req.memory: by the time
// the driver runs, req.memory is the interpreter's fixed recollection
// template ("I stored a text value in private memory …"), and reflecting
// that leaks storage scaffolding into the prose.
function episodeText(req: MemoryWriteRequest): string | undefined {
  const rendered = typeof req.summary?.rendered === "string" ? compactText(req.summary.rendered) : "";
  if (!rendered) return undefined;
  if (stringMetadata(req.metadata, "source") === "provider_reply") {
    const prompt = stringMetadata(req.metadata, "episode_prompt");
    return prompt
      ? `I asked: ${prompt}\nThe reply was: ${rendered}`
      : `A reply I received: ${rendered}`;
  }
  return `Something I chose to remember (memory '${req.scope.mem}'): ${rendered}`;
}

// The reflection instruction: the agent writes the episode down in its own
// words, as prose to its future self — the same move commercial assistant
// memories make. Kept substrate-agnostic and output-shape-fixed (plain text).
function reflectionPrompt(episode: string): string {
  return [
    "You are the private memory faculty of an agent, writing a note that your future self will recall verbatim.",
    "Rewrite the raw episode below as one short first-person memory in plain prose.",
    "Keep every concrete fact, name, number, date, preference, instruction, and commitment.",
    "Drop greetings, pleasantries, mention tokens, formatting artifacts, and repetition.",
    "Never mention the act of storing, remembering, or receiving values — write only about the content of the episode.",
    "If the episode contains a standing instruction or preference from the user, state it imperatively so your future self follows it.",
    "Output only the memory text, nothing else.",
    "",
    "Raw episode:",
    episode.slice(0, 6000),
  ].join("\n");
}

function rerankHit(
  hit: MemoryStoredCell,
  order: number,
  queryTerms: string[],
  queryProfile: MemoryKind | undefined,
  domainTerms: string[],
): MemoryStoredCell {
  const metadata = hit.metadata ?? {};
  const memoryTerms = new Set([
    ...contentTerms(hit.memory),
    ...arrayMetadata(metadata, "memory_tags").flatMap(contentTerms),
  ]);
  let score = hit.score ?? 0;
  let overlap = 0;
  for (const term of queryTerms) {
    if (memoryTerms.has(term)) {
      overlap += 1;
      score += 4;
    }
  }
  for (const term of domainTerms) {
    if (queryTerms.includes(term) && memoryTerms.has(term)) score += 3;
  }
  const kind = stringMetadata(metadata, "memory_kind") as MemoryKind | undefined;
  if (kind && queryProfile === kind) score += 6;
  if (kind === "preference" && queryProfile === "decision") score += 2;
  if (normalize(hit.memory).includes(normalize(queryTerms.join(" ")))) score += 5;
  score += Math.max(0, 3 - order * 0.1);
  return {
    ...hit,
    score,
    metadata: {
      ...metadata,
      runtime_rank: score,
      recall_overlap: overlap,
      recall_kind_match: kind && queryProfile ? kind === queryProfile : false,
    },
  };
}

function queryKindProfile(query: string): MemoryKind | undefined {
  const terms = new Set(contentTerms(query));
  const has = (words: Set<string>) => [...words].some((w) => terms.has(w));
  if (has(PREFERENCE_TERMS)) return "preference";
  if (has(PROCEDURE_TERMS) || /\bhow\b/i.test(query)) return "procedure";
  if (has(DECISION_TERMS) || /\bshould\b/i.test(query)) return "decision";
  if (has(FACT_TERMS) || /\bwhat\b/i.test(query)) return "fact";
  return undefined;
}

function worthRemembering(memory: string, classification: ClassifiedMemory): boolean {
  if (!memory || memory.length < 16) return false;
  if (classification.kind === "preference" || classification.kind === "procedure") return true;
  if (classification.kind === "fact" || classification.kind === "decision") return classification.signal >= 7;
  if (classification.kind === "interaction") return classification.signal >= 12;
  return classification.signal >= 8;
}

function classificationReason(kind: MemoryKind, source: string | undefined, signal: number): string {
  if (kind === "interaction" && source === "provider_reply") return `provider_reply_signal_${signal}`;
  return `${kind}_signal_${signal}`;
}

function enrichReceipt(
  receipt: MemoryReceipt,
  classification: ClassifiedMemory,
  policy: Record<string, unknown>,
): MemoryReceipt {
  return {
    ...enrichPolicy(receipt, policy),
    refs: receipt.refs,
    policy: {
      ...(receipt.policy ?? {}),
      ...policy,
      classification: {
        kind: classification.kind,
        tags: classification.tags,
        signal: classification.signal,
        reason: classification.reason,
      },
    },
  };
}

function enrichPolicy(receipt: MemoryReceipt, policy: Record<string, unknown>): MemoryReceipt {
  return {
    ...receipt,
    policy: {
      ...(receipt.policy ?? {}),
      ...policy,
    },
  };
}

function skippedReceipt(
  status: string,
  reason: string,
  classification: ClassifiedMemory,
  policy: Record<string, unknown>,
): MemoryReceipt {
  return {
    status,
    effects: zeroEffects(),
    refs: { skipped_reason: reason },
    policy: {
      ...policy,
      stored: false,
      classification,
    },
  };
}

function dedupedReceipt(
  duplicate: MemoryStoredCell,
  classification: ClassifiedMemory,
  policy: Record<string, unknown>,
): MemoryReceipt {
  return {
    status: "DEDUPED",
    effects: zeroEffects(),
    refs: {
      duplicate_of: duplicate.id,
      duplicate_score: duplicate.score,
      ...(duplicate.metadata?.markdown_file ? { markdown_file: duplicate.metadata.markdown_file } : {}),
    },
    policy: {
      ...policy,
      stored: false,
      consolidation: "duplicate_suppressed",
      classification,
    },
  };
}

function zeroEffects(): Record<string, unknown> {
  return {
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
  };
}

function expandQuery(query: string, domainTerms: string[]): string {
  return compactText([query, ...domainTerms.filter((t) => normalize(query).includes(t))].join(" "));
}

function similarity(a: string, b: string): number {
  const normalizedA = normalize(stripMetadataNoise(a));
  const normalizedB = normalize(stripMetadataNoise(b));
  if (!normalizedA || !normalizedB) return 0;
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) return 1;
  const aTerms = new Set(contentTerms(normalizedA));
  const bTerms = new Set(contentTerms(normalizedB));
  if (aTerms.size === 0 || bTerms.size === 0) return 0;
  let overlap = 0;
  for (const term of aTerms) if (bTerms.has(term)) overlap++;
  return overlap / Math.max(aTerms.size, bTerms.size);
}

function stripMetadataNoise(text: string): string {
  return text
    .replace(/```json[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+.*$/gm, " ")
    .replace(/agape-memory-id:\s*[A-Za-z0-9:._-]+/g, " ");
}

function contentTerms(text: string): string[] {
  return Array.from(new Set(normalize(text)
    .split(/\s+/)
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term))));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function canonicalHash(memory: string): string {
  return createHash("sha256").update(normalize(memory)).digest("hex").slice(0, 16);
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function arrayMetadata(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return [value];
  return [];
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}
