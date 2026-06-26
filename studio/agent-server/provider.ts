// The two provider seams the whole runtime hides behind, so "rewrite in Rust + swap
// to OpenAI" is an implementation change, not a redesign.
//
//   Cognition — the LLM (think/decompose). AnthropicCognition (haiku) today.
//   Embedder  — text → vector. HashingEmbedder (local, dependency-free) today.

import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage } from "./agent.ts";

export interface Triple {
  s: string;
  p: string;
  o: string;
}
export interface Fact {
  key: string;
  value: string;
}
export interface Decomposition {
  facts: Fact[];
  triples: Triple[];
}

export interface Cognition {
  readonly model: string;
  complete(system: string, messages: ChatMessage[], maxTokens?: number): Promise<string>;
  // §10 internalization: turn text into typed facts + SPO triples (fixed shape).
  decompose(text: string): Promise<Decomposition>;
}

export interface Embedder {
  readonly dim: number;
  readonly name: string;
  embed(text: string): number[];
}

// ── Anthropic cognition (haiku) ──────────────────────────────────────────────
export class AnthropicCognition implements Cognition {
  readonly model: string;
  private client: Anthropic;
  constructor(model = process.env.AGENT_MODEL || "claude-haiku-4-5") {
    this.model = model;
    this.client = new Anthropic();
  }

  async complete(system: string, messages: ChatMessage[], maxTokens = 1024): Promise<string> {
    const res = await this.client.messages.create({ model: this.model, max_tokens: maxTokens, system, messages });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }

  async decompose(text: string): Promise<Decomposition> {
    const system =
      "You internalize a chunk of the Agape language spec into structured memory. " +
      "Return ONLY JSON of the form " +
      '{"facts":[{"key":"...","value":"..."}],"triples":[{"s":"...","p":"...","o":"..."}]}. ' +
      "facts are atomic, checkable statements about Agape (key is a short slug). " +
      "triples are subject–predicate–object over Agape concepts (e.g. {\"s\":\"endorse\",\"p\":\"collapses\",\"o\":\"Credence\"}). " +
      "Use a small, consistent predicate set: is-a, has, collapses, requires, produces, gated-by, queried-with, taints. " +
      "5–12 of each at most. No prose, no code fences.";
    const raw = await this.complete(system, [{ role: "user", content: text }], 1500);
    return parseDecomposition(raw);
  }
}

// Tolerant JSON extraction — models occasionally wrap output in prose or fences.
export function parseDecomposition(raw: string): Decomposition {
  let body = raw.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1].trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) body = body.slice(start, end + 1);
  try {
    const obj = JSON.parse(body);
    const facts: Fact[] = Array.isArray(obj.facts)
      ? obj.facts.filter((f: any) => f && f.key && f.value).map((f: any) => ({ key: String(f.key), value: String(f.value) }))
      : [];
    const triples: Triple[] = Array.isArray(obj.triples)
      ? obj.triples.filter((t: any) => t && t.s && t.p && t.o).map((t: any) => ({ s: String(t.s), p: String(t.p), o: String(t.o) }))
      : [];
    return { facts, triples };
  } catch {
    return { facts: [], triples: [] };
  }
}

// ── Local hashing embedder (dependency-free default) ─────────────────────────
// Hashed token TF, L2-normalized so cosine similarity is a plain dot product.
// Crude vs a real model, but real enough for keyword-semantic recall over the spec,
// and it embodies the embed seam. Swap for OpenAI/Voyage/a local transformer.
export class HashingEmbedder implements Embedder {
  readonly dim: number;
  readonly name = "hashing-local";
  constructor(dim = 384) {
    this.dim = dim;
  }

  embed(text: string): number[] {
    const v = new Array(this.dim).fill(0);
    for (const tok of tokenize(text)) {
      v[hash(tok) % this.dim] += 1;
      // a cheap bigram channel sharpens phrase sensitivity
    }
    const toks = tokenize(text);
    for (let i = 1; i < toks.length; i++) {
      v[hash(toks[i - 1] + "_" + toks[i]) % this.dim] += 0.5;
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return v.map((x) => x / norm);
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // both L2-normalized → dot is cosine
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_<>-]+/g) || [];
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
