// Runtime core — values, judgment trust + ingress provenance (§13/§15.3.1), the provider seam (§8),
// and the ledger (§7).

import { types as utilTypes } from "node:util";

import {
  canonicalLedgerEventJson,
  canonicalLedgerHead,
  snapshotCanonicalPayload,
} from "./ledger_hash.js";
import type { JudgmentEvidence, JudgmentEvidenceLink } from "./protected_evidence.js";

// ---- Trust lattice: settled ⊑ graded ⊑ raw ----
export type Trust = "settled" | "graded" | "raw";
export type IngressProvenance = "internal" | "external_unscreened" | "external_screened";

export type Variant = string;
export type Committed = Variant | "abstained";

export interface EndorsementAuthorizationLineage {
  readonly subjectHash: string;
  readonly endorsementTick: number;
  readonly decisionId: number;
  readonly ruleHash: string;
  readonly evidenceRef: string | null;
  readonly margin: number;
  readonly floor?: number;
  readonly derivationPath: readonly string[];
}

type ValueIngress = {
  ingress?: IngressProvenance;
  privateMemory?: true;
  authorization?: EndorsementAuthorizationLineage;
};

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
      calibrationEvidence?: JudgmentEvidenceLink;
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
      ruleHash: string;
      evidenceRef: string | null;
      binding?: string;
      principalEvent?: number;
      principalRequest: string | null;
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
      subjectHash: string;
      endorsementTick: number;
      ruleHash: string;
      evidenceRef: string | null;
      principalEvent?: number;
      principalRequest: string | null;
    } & ValueIngress)
  | ({ kind: "agentref"; name: string; agentType: string; trust: "settled" } & ValueIngress)
  | ({ kind: "memref"; name: string; trust: "settled" } & ValueIngress) // a handle into private memory (§10)
  | ({ kind: "taskref"; subject: string; corr: number; trust: "settled" } & ValueIngress) // a background-task handle Task<T> (§6c)
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
    case "taskref": return v.subject; // source label for rendering; `about h` matches the handle corr (§6c)
    // arrays render one item per line: interpolated collections (a rolling window, query results)
    // read as prose in a prompt block, not as debug syntax.
    case "array": return v.items.map(render).join("\n");
    default: return show(v);
  }
}
export interface ProviderJudgment {
  scores: Record<Variant, number>;
  evidence?: JudgmentEvidence;
}


// ---- The provider seam (cognition). The runtime never names a concrete model. ----
// Cognition is inherently asynchronous (a model call), so the seam is async even for the mock.
export interface Provider {
  // a typed judgment: forced categorical choice over the enum's variants -> a scored distribution.
  judge(prompt: string, enumName: string, variants: Variant[], context?: CognitionContext): Promise<ProviderJudgment>;
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
  readonly tick: number;
  // Runtime inspection metadata, deliberately excluded from head(): `tick` is the canonical ledger order.
  readonly latency_ms: number;
  readonly elapsed_ms: number;
  readonly etype: string;
  readonly subject: string;
  readonly payload: unknown;
  readonly corr: string | number | null;
  readonly agent: string;
}

const LEDGER_EVENT_FIELDS = Object.freeze([
  "tick", "latency_ms", "elapsed_ms", "etype", "subject", "payload", "corr", "agent",
] as const);

function ledgerRestoreError(reason: string): Error {
  return new Error(`restored ledger ${reason}`);
}

function restoredEventArrayItems(events: unknown): unknown[] {
  if (utilTypes.isProxy(events)) {
    throw ledgerRestoreError("events must not be a Proxy");
  }
  if (!Array.isArray(events) || Object.getPrototypeOf(events) !== Array.prototype) {
    throw ledgerRestoreError("events must be an ordinary array");
  }
  if (Object.getOwnPropertySymbols(events).length !== 0) {
    throw ledgerRestoreError("events must not contain symbol properties");
  }
  const names = Object.getOwnPropertyNames(events);
  const expected = Array.from({ length: events.length }, (_, index) => String(index));
  if (names.length !== expected.length + 1 || !names.includes("length")
    || expected.some((name) => !names.includes(name))) {
    throw ledgerRestoreError("events must be dense and contain no extra properties");
  }
  return expected.map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(events, name);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw ledgerRestoreError(`events[${name}] must be an enumerable data property`);
    }
    return descriptor.value;
  });
}

function restoredEventFields(source: unknown, index: number): Record<typeof LEDGER_EVENT_FIELDS[number], unknown> {
  if (utilTypes.isProxy(source)) {
    throw ledgerRestoreError(`event ${index} must not be a Proxy`);
  }
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw ledgerRestoreError(`event ${index} must be a plain data record`);
  }
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) {
    throw ledgerRestoreError(`event ${index} must be a plain data record`);
  }
  if (Object.getOwnPropertySymbols(source).length !== 0) {
    throw ledgerRestoreError(`event ${index} must not contain symbol properties`);
  }
  const names = Object.getOwnPropertyNames(source);
  if (names.length !== LEDGER_EVENT_FIELDS.length
    || LEDGER_EVENT_FIELDS.some((name) => !names.includes(name))) {
    throw ledgerRestoreError(`event ${index} must contain exactly the eight ledger fields`);
  }
  const fields = Object.create(null) as Record<typeof LEDGER_EVENT_FIELDS[number], unknown>;
  for (const name of LEDGER_EVENT_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw ledgerRestoreError(`event ${index}.${name} must be an enumerable data property`);
    }
    fields[name] = descriptor.value;
  }
  return fields;
}

function assertExactLedgerPayload(value: unknown, path: string, ancestors: Set<object>): void {
  if (utilTypes.isProxy(value)) {
    throw ledgerRestoreError(`${path} must not contain Proxies`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw ledgerRestoreError(`${path} must contain only finite JSON numbers`);
    return;
  }
  if (typeof value !== "object") throw ledgerRestoreError(`${path} must be defined JSON data`);
  if (ancestors.has(value)) throw ledgerRestoreError(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw ledgerRestoreError(`${path} must contain only ordinary arrays`);
      }
      if (Object.getOwnPropertySymbols(value).length !== 0) {
        throw ledgerRestoreError(`${path} must not contain symbol properties`);
      }
      const names = Object.getOwnPropertyNames(value);
      const expected = Array.from({ length: value.length }, (_, index) => String(index));
      if (names.length !== expected.length + 1 || !names.includes("length")
        || expected.some((name) => !names.includes(name))) {
        throw ledgerRestoreError(`${path} arrays must be dense and contain no extra properties`);
      }
      for (const name of expected) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw ledgerRestoreError(`${path}[${name}] must be an enumerable data property`);
        }
        assertExactLedgerPayload(descriptor.value, `${path}[${name}]`, ancestors);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw ledgerRestoreError(`${path} must contain only plain JSON objects`);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw ledgerRestoreError(`${path} must not contain symbol properties`);
    }
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw ledgerRestoreError(`${path}.${name} must be an enumerable data property`);
      }
      assertExactLedgerPayload(descriptor.value, `${path}.${name}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export class Ledger {
  #committedEvents: LedgerEvent[] = [];
  #visibleEvents: LedgerEvent[] = Object.freeze([] as LedgerEvent[]) as LedgerEvent[];
  private lastMs: number;

  get events(): LedgerEvent[] {
    return this.#visibleEvents;
  }

  // The observer sees the already-committed immutable event; observer failure is contained.
  constructor(private originMs = Date.now(), private onEvent?: (event: LedgerEvent) => void) {
    this.lastMs = originMs;
  }

  static restore(events: readonly LedgerEvent[], onEvent?: (event: LedgerEvent) => void): Ledger {
    const sources = restoredEventArrayItems(events);
    const now = Date.now();
    const ledger = new Ledger(now, onEvent);
    let priorElapsed = 0;
    const restored = sources.map((source, index): LedgerEvent => {
      const fields = restoredEventFields(source, index);
      if (!Number.isSafeInteger(fields.tick) || (fields.tick as number) < 0 || fields.tick !== index) {
        throw ledgerRestoreError("ticks are not contiguous safe nonnegative integers");
      }
      if (!Number.isSafeInteger(fields.latency_ms) || (fields.latency_ms as number) < 0
        || !Number.isSafeInteger(fields.elapsed_ms) || (fields.elapsed_ms as number) < 0) {
        throw ledgerRestoreError("timing metadata is invalid");
      }
      const latency = fields.latency_ms as number;
      const elapsed = fields.elapsed_ms as number;
      if (elapsed < priorElapsed) throw ledgerRestoreError("elapsed timing is not nondecreasing");
      if (latency > elapsed) throw ledgerRestoreError("latency exceeds elapsed timing");
      if (latency !== elapsed - priorElapsed) {
        throw ledgerRestoreError("latency does not match elapsed timing delta");
      }
      if (typeof fields.etype !== "string" || typeof fields.subject !== "string"
        || typeof fields.agent !== "string"
        || !(fields.corr === null || typeof fields.corr === "string"
          || (typeof fields.corr === "number" && Number.isFinite(fields.corr)))) {
        throw ledgerRestoreError("event shape is invalid");
      }
      if (fields.payload === undefined) throw ledgerRestoreError("event payload must be present and defined");
      assertExactLedgerPayload(fields.payload, `event ${index}.payload`, new Set<object>());
      const payload = snapshotCanonicalPayload(fields.payload);
      const event: LedgerEvent = Object.freeze({
        tick: index,
        latency_ms: latency,
        elapsed_ms: elapsed,
        etype: fields.etype,
        subject: fields.subject,
        payload,
        corr: fields.corr,
        agent: fields.agent,
      });
      canonicalLedgerEventJson(event);
      priorElapsed = elapsed;
      return event;
    });
    ledger.#committedEvents = restored;
    ledger.#visibleEvents = Object.freeze(restored.slice()) as LedgerEvent[];
    const elapsed = restored.at(-1)?.elapsed_ms ?? 0;
    ledger.originMs = now - elapsed;
    ledger.lastMs = now;
    return ledger;
  }

  appendBatch(entries: readonly {
    etype: string;
    subject: string;
    payload?: unknown;
    agent?: string;
    corr?: string | number | null;
  }[]): LedgerEvent[] {
    if (entries.length === 0) return [];
    const now = Math.max(Date.now(), this.lastMs);
    const start = this.#committedEvents.length;
    const elapsed = Math.max(0, now - this.originMs);
    const events = entries.map((entry, index): LedgerEvent => {
      const event: LedgerEvent = Object.freeze({
        tick: start + index,
        latency_ms: index === 0 ? Math.max(0, now - this.lastMs) : 0,
        elapsed_ms: elapsed,
        etype: entry.etype,
        subject: entry.subject,
        payload: snapshotCanonicalPayload(entry.payload) ?? null,
        corr: entry.corr ?? null,
        agent: entry.agent ?? "",
      });
      canonicalLedgerEventJson(event);
      return event;
    });
    this.lastMs = now;
    this.#committedEvents.push(...events);
    this.#visibleEvents = Object.freeze(this.#committedEvents.slice()) as LedgerEvent[];
    if (this.onEvent) {
      for (const event of events) {
        try { this.onEvent(event); } catch { /* observation is best-effort */ }
      }
    }
    return events;
  }

  append(
    etype: string,
    subject: string,
    payload?: unknown,
    agent?: string,
    corr?: string | number | null,
  ): LedgerEvent {
    return this.appendBatch([{ etype, subject, payload, agent, corr }])[0]!;
  }

  head(): string {
    return canonicalLedgerHead(this.#committedEvents);
  }
}
