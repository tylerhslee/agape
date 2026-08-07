// Runtime core — values, judgment trust + ingress provenance (§13/§15.3.1), the provider seam (§8),
// and the ledger (§7).

// ---- Trust lattice: settled ⊑ graded ⊑ raw ----
export type Trust = "settled" | "graded" | "raw";
export type IngressProvenance = "internal" | "external_unscreened" | "external_screened";

export type Variant = string;
export type Committed = Variant | "abstained";

type ValueIngress = { ingress?: IngressProvenance; privateMemory?: true };

export type Value =
  | ({ kind: "text"; v: string; trust: Trust } & ValueIngress)
  | ({ kind: "int"; v: number; trust: Trust } & ValueIngress)
  | ({ kind: "float"; v: number; trust: Trust } & ValueIngress)
  | ({ kind: "bool"; v: boolean; trust: Trust } & ValueIngress)
  | ({ kind: "null"; trust: Trust } & ValueIngress)
  | ({ kind: "enumval"; enumName: string; variant: Variant; trust: Trust } & ValueIngress)
  | ({
      kind: "credence";
      enumName: string;
      scores: Record<Variant, number>;
      trust: "graded";
      // the values that fed this credence's prompt (§13 dependency scope). A later `endorse subject by d`
      // where `d = decide c` is ABOUT `subject` when `subject` is `c` itself OR fed `c`'s prompt — the
      // endorse runtime backstop accepts exactly those, and fails closed on any other raw/graded subject.
      derivedFrom?: Value[];
    } & ValueIngress)
  | ({
      kind: "decision";
      enumName: string;
      committed: Committed;
      basis: string;
      margin: number;
      trust: "settled";
      decisionId: number;
      rule?: Record<string, unknown>;
      binding?: string;
      principalEvent?: number;
      // the rule's consequential margin `floor m` (§13), threaded so the endorse it authorizes carries it
      // to the sink, where a committed decision whose margin is below `m` faults (MarginFloorViolation, §16.6).
      floor?: number;
      // under `by conformal α`, the split-conformal prediction set { v : nc(v) ≤ q̂ } (§15.5.6); a singleton
      // is the commit, any other cardinality abstains. Absent for the threshold basis.
      predictionSet?: string[];
      // the exact Credence<E> this decision was collapsed from (§13). The endorse runtime backstop uses
      // it to confirm a raw/graded subject is the very judgment the decision settled — "a decision about
      // other_response cannot endorse response" — and to fail closed otherwise (§14).
      source?: Value;
    } & ValueIngress)
  | ({
      kind: "endorsement";
      subject: Value;
      enumName: string;
      committed: Committed;
      basis: string;
      margin: number;
      committedNarrowed: boolean;
      trust: "settled";
      binding?: string;
      decisionId: number;
      // inherited from the authorizing decision's rule (§13): the consequential margin floor checked when
      // this endorsed value reaches a `perform` sink (MarginFloorViolation, §16.6).
      floor?: number;
    } & ValueIngress)
  | ({ kind: "agentref"; name: string; agentType: string; trust: "settled" } & ValueIngress)
  | ({ kind: "memref"; name: string; trust: "settled" } & ValueIngress) // a handle into private memory (§10)
  | ({ kind: "taskref"; corr: string; trust: "settled" } & ValueIngress) // a background-task handle Task<T> (§6c)
  // a record value (§3). `taskScope` is set only on a TaskSpec built by a task literal carrying a
  // `scope { perform … }` clause (§6c) — the action names the endorsed task enables on the worker.
  | ({ kind: "struct"; typeName?: string; fields: Map<string, Value>; trust: Trust; taskScope?: string[] } & ValueIngress)
  | ({ kind: "array"; items: Value[]; trust: Trust } & ValueIngress); // a query result set (§10/§12)

export type StructuredSchema =
  | { type: "string" }
  | { type: "integer" }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "string"; enum: string[] }
  | { type: "array"; items: StructuredSchema }
  | { type: "object"; properties: Record<string, StructuredSchema>; required: string[]; additionalProperties: false };

// Provider-neutral semantic context. Connectors may choose their own wire shape, but they must preserve
// the single ordered instruction list and keep every other input in typed data (sections 5 and 16.7).
export interface CognitionMemoryHit {
  cell_id: string;
  content: string;
  content_hash: string;
  score?: number;
  origin_ref: string;
  value?: Record<string, unknown>;
  provenance?: { attester: string; prompt_name: string };
}

export type CognitionDataSegment =
  | { kind: "stimulus"; content: string }
  | { kind: "task"; objective: string; acceptance: string }
  | { kind: "recalled_memory"; query: string; hits: CognitionMemoryHit[] };

export interface CognitionContext {
  instructions: readonly string[];
  data: readonly CognitionDataSegment[];
}

export const settledText = (v: string): Value => ({ kind: "text", v, trust: "settled" });

export function ingressOf(v: { ingress?: IngressProvenance }): IngressProvenance {
  return v.ingress ?? "internal";
}

export function ingressJoin(vs: { ingress?: IngressProvenance }[]): IngressProvenance {
  let sawScreened = false;
  for (const v of vs) {
    const ingress = ingressOf(v);
    if (ingress === "external_unscreened") return "external_unscreened";
    if (ingress === "external_screened") sawScreened = true;
  }
  return sawScreened ? "external_screened" : "internal";
}

export function show(v: Value): string {
  switch (v.kind) {
    case "text": return JSON.stringify(v.v);
    case "int": case "float": return String(v.v);
    case "bool": return String(v.v);
    case "null": return "null";
    case "enumval": return `${v.enumName}.${v.variant}`;
    case "credence": return `Credence<${v.enumName}>{${Object.entries(v.scores).map(([k, s]) => `${k}:${s.toFixed(2)}`).join(", ")}}`;
    case "decision": return `Decision<${v.enumName}>#${v.decisionId}{committed:${v.committed}, basis:${v.basis}, margin:${v.margin.toFixed(2)}}`;
    case "endorsement": return `Endorsement{subject:${show(v.subject)}, committed:${v.committed}, margin:${v.margin.toFixed(2)}}`;
    case "agentref": return `&${v.name}:${v.agentType}`;
    case "memref": return `mem ${v.name}`;
    case "taskref": return `Task#${v.corr}`;
    case "struct": return `${v.typeName ?? ""}{${[...v.fields].map(([k, val]) => `${k}: ${show(val)}`).join(", ")}}`;
    case "array": return `[${v.items.map(show).join(", ")}]`;
  }
}

// stringify a value for f-string / say rendering
export function render(v: Value): string {
  switch (v.kind) {
    case "text": return v.v;
    case "int": case "float": return String(v.v);
    case "bool": return String(v.v);
    case "null": return "null";
    case "enumval": return v.variant;
    case "endorsement": return render(v.subject);
    case "taskref": return v.corr; // the correlation subject — what `when (… about h)` filters on (§6c)
    // arrays render one item per line: interpolated collections (a rolling window, query results)
    // read as prose in a prompt block, not as debug syntax.
    case "array": return v.items.map(render).join("\n");
    default: return show(v);
  }
}

// ---- The provider seam (cognition). The runtime never names a concrete model. ----
// Cognition is inherently asynchronous (a model call), so the seam is async even for the mock.
export interface Provider {
  // a typed judgment: forced categorical choice over the enum's variants -> a scored distribution.
  judge(prompt: string, enumName: string, variants: Variant[], context?: CognitionContext): Promise<{ scores: Record<Variant, number> }>;
  // a typed reply: constrained structured output for a declared scalar/array/struct schema.
  structured?(prompt: string, schema: StructuredSchema, name?: string, context?: CognitionContext): Promise<unknown>;
  // a bare reply (raw text).
  reply(prompt: string, context?: CognitionContext): Promise<string>;
}

// A deterministic mock provider. Scores are scripted by keyword so the demo is reproducible and
// replay-stable; a real provider plugs in here (Anthropic/OpenAI/Gemini) behind the same interface.
// It still resolves asynchronously, so the runtime exercises the same async path as a live model.
export class MockProvider implements Provider {
  constructor(private script?: (prompt: string, variants: Variant[]) => Record<Variant, number>) {}

  async judge(prompt: string, _enumName: string, variants: Variant[], _context?: CognitionContext): Promise<{ scores: Record<Variant, number> }> {
    await tick();
    if (this.script) return { scores: normalize(this.script(prompt, variants), variants) };
    // default heuristic: lean toward the FIRST variant (a confident "yes"), tiny mass elsewhere.
    const raw: Record<Variant, number> = {};
    variants.forEach((v, idx) => (raw[v] = idx === 0 ? 0.9 : 0.1 / Math.max(1, variants.length - 1)));
    return { scores: normalize(raw, variants) };
  }

  async reply(prompt: string, _context?: CognitionContext): Promise<string> {
    await tick();
    return `(reply to: ${prompt})`;
  }

  async structured(_prompt: string, schema: StructuredSchema, _name?: string, _context?: CognitionContext): Promise<unknown> {
    await tick();
    return mockStructured(schema);
  }
}

// simulate an async boundary (a microtask) so even the mock path is genuinely asynchronous.
export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function normalize(scores: Record<Variant, number>, variants: Variant[]): Record<Variant, number> {
  const out: Record<Variant, number> = {};
  let sum = 0;
  for (const v of variants) {
    out[v] = Math.max(0, scores[v] ?? 0);
    sum += out[v]!;
  }
  if (sum === 0) {
    for (const v of variants) out[v] = 1 / variants.length;
  } else {
    for (const v of variants) out[v]! /= sum;
  }
  return out;
}

function mockStructured(schema: StructuredSchema): unknown {
  switch (schema.type) {
    case "string": return "enum" in schema ? schema.enum[0] ?? "" : "ok";
    case "integer": return 0;
    case "number": return 0;
    case "boolean": return true;
    case "null": return null;
    case "array": return [mockStructured(schema.items)];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties)) out[k] = mockStructured(v);
      return out;
    }
  }
}

// ---- The ledger (append-only, totally ordered within the runtime) ----
export interface LedgerEvent {
  tick: number;
  // Runtime inspection metadata, deliberately excluded from head(): `tick` is the canonical ledger order.
  latency_ms: number;
  elapsed_ms: number;
  etype: string;
  subject: string;
  payload?: unknown;
  agent?: string;
}

export class Ledger {
  readonly events: LedgerEvent[] = [];
  private lastMs: number;

  // §17.7 host embedding: an optional live observer, invoked once per append in tick order, immediately
  // AFTER the event is committed to `events`. A read-only sink for embedding UIs (Studio timeline, a
  // streaming fact-checker); an exception it throws is swallowed so a faulty observer never corrupts the
  // run — the append has already committed.
  constructor(private originMs = Date.now(), private onEvent?: (event: LedgerEvent) => void) {
    this.lastMs = originMs;
  }

  append(etype: string, subject: string, payload?: unknown, agent?: string): LedgerEvent {
    const now = Date.now();
    const ev: LedgerEvent = {
      tick: this.events.length,
      latency_ms: Math.max(0, now - this.lastMs),
      elapsed_ms: Math.max(0, now - this.originMs),
      etype,
      subject,
      payload,
      agent,
    };
    this.lastMs = now;
    this.events.push(ev);
    if (this.onEvent) {
      try { this.onEvent(ev); } catch { /* observation is best-effort; a faulty observer never corrupts the run */ }
    }
    return ev;
  }
  // a simple content hash of the canonical fields (a stand-in for the §16.2 SHA-256 chain).
  head(): string {
    let h = 0;
    for (const e of this.events) {
      const s = `${e.tick}|${e.etype}|${e.subject}|${JSON.stringify(e.payload ?? null)}|${e.agent ?? ""}`;
      for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
}
