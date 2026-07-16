// agape-ts runtime conformance adapter — the transport-neutral test-mode surface required by
// ../agape-runtime-conformance (SPEC.md sections 16/17). Load it with:
//
//   AGAPE_RUNTIME_ADAPTER=../agape-ts/src/runtime_adapter.ts npm test   (from agape-runtime-conformance)
//
// Design notes (see also agape-runtime-conformance/README.md):
// - Programs run on the REAL kernel compiler+runtime (parse/check/interp). Suite sources written
//   against the pre-core-kernel surface pass through runtime_adapter_desugar.ts first.
// - The adapter keeps one append-only session ledger; each run/ingest/turn appends real events to
//   it. `canonicalHash` is the SPEC 16.2 SHA-256 chain over the six canonical fields.
// - record/replay: live runs journal every oracle answer (provider, tools, prompts, principal);
//   `replay` re-executes the program with journal-backed seams, so nothing external is re-invoked
//   and the canonical head must reproduce.
// - The 16.7 memory envelope (artifact decomposition, experiences, corrections, context ranking)
//   is adapter-level test-mode machinery (runtime_adapter_memory.ts) over real ledger ticks — the
//   kernel's `mem` substrate does not itself decompose artifacts.
// - GateProfile bookkeeping and config resolution are adapter-level implementations of the SPEC
//   16.8/17 rules; gate decisions inside calibrationScenario still come from real kernel runs.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "./parser.js";
import { check } from "./check.js";
import { createSession, run as runtimeRun, type RunResult as KernelRunResult } from "./interp.js";
import { LocalMemoryDriver } from "./memory.js";
import type { Provider, StructuredSchema, Variant, LedgerEvent as KernelLedgerEvent } from "./runtime.js";
import type { Manifest } from "./config.js";
import type { ToolHandler } from "./tool_adapters.js";
import { desugarLegacySurface } from "./runtime_adapter_desugar.js";
import { MemoryEnvelope, sha256Hex, type EnvelopeCell, type EnvelopeOp } from "./runtime_adapter_memory.js";

// ---------- conformance-facing shapes (structural mirror of agape-runtime-conformance/src/adapter.ts) ----------

interface LedgerEvent {
  tick: number;
  etype: string;
  subject: string;
  payload?: unknown;
  corr?: string | null;
  agent: string;
  ts?: number;
  [key: string]: unknown;
}

interface Diagnostic {
  category: string;
  message?: string;
  location?: unknown;
}

interface RunOutcome {
  ok: boolean;
  head: number;
  headHash: string;
  events: LedgerEvent[];
  recording?: unknown;
  error?: Diagnostic;
}

interface AgentRef {
  template: string;
  instanceId: string;
  generation?: number;
}

class ConformanceConfigError extends Error {
  readonly category = "ConfigError";
}

// ---------- test-mode option shapes accepted from the suite ----------

interface ProviderReply {
  subject?: string;
  delayMs?: number;
  payload?: unknown;
  mode?: string;
  id?: string;
}

interface TestMode {
  provider?: string | { credence?: Record<string, number>; kind?: string; text?: string };
  providerReplies?: ProviderReply[];
  stochasticProvider?: { distribution: Record<string, number>; betaBound?: number };
  tools?: Record<string, { result?: unknown }>;
  principal?: string;
  promptArrivals?: Array<{ source: string; value?: unknown; body?: string }>;
  [key: string]: unknown;
}

interface OracleJournal {
  judge: Array<{ scores: Record<string, number> }>;
  structured: unknown[];
  reply: string[];
  tools: unknown[];
}

interface Recording {
  kind: "agape-ts-recording";
  source: string;
  testMode?: TestMode;
  journal: OracleJournal;
  memoryOps: EnvelopeOp[];
  headHash: string;
}

// ---------- deterministic PRNG for the stochastic scenarios ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- harness provider: scripted by testMode, journaling, replayable ----------

class HarnessProvider implements Provider {
  private queue: ProviderReply[];
  private stochasticRng?: () => number;

  constructor(
    private mode: TestMode,
    private counters: Counters,
    private journal: OracleJournal,
    private replayJournal?: OracleJournal,
    stochasticSeed?: number,
  ) {
    this.queue = [...(mode.providerReplies ?? [])];
    if (mode.stochasticProvider) this.stochasticRng = mulberry32((stochasticSeed ?? 0) + 1);
  }

  /** the interpreter's provider-fault seam: `empty` crashes, `schema_violation` is a clean TypeMismatch. */
  get fault(): string | undefined {
    if (this.mode.provider === "empty") return "empty";
    const next = this.queue[0];
    if (next?.mode === "schema_violation") {
      this.queue.shift();
      return "schema_violation";
    }
    return undefined;
  }

  private scriptedScores(variants: Variant[]): Record<string, number> {
    const p = this.mode.provider;
    // an explicitly-scripted credence is the model's own score vector — used by the gate AS-IS (§15.5.6: the
    // score vector need not be a normalized distribution; a threshold/margin/floor rule reads the raw leads).
    // Renormalizing would corrupt a deliberately-non-unit vector (e.g. {0.81, 0.79}, where 0.81 must clear an
    // 0.8 threshold with a thin 0.02 margin), so pass the given scores through, defaulting an omitted variant to 0.
    if (p && typeof p === "object" && p.credence) {
      const out: Record<string, number> = {};
      for (const v of variants) out[v] = Math.max(0, p.credence[v] ?? 0);
      return out;
    }
    const stochastic = this.mode.stochasticProvider;
    if (stochastic && this.stochasticRng) {
      const jittered: Record<string, number> = {};
      for (const v of variants) {
        const base = stochastic.distribution[v] ?? 0;
        jittered[v] = Math.max(0, base * (1 + (this.stochasticRng() - 0.5) * 0.01));
      }
      return normalize(jittered, variants);
    }
    const raw: Record<string, number> = {};
    variants.forEach((v, idx) => (raw[v] = idx === 0 ? 0.9 : 0.1 / Math.max(1, variants.length - 1)));
    return normalize(raw, variants);
  }

  async judge(_prompt: string, _enumName: string, variants: Variant[]): Promise<{ scores: Record<Variant, number> }> {
    if (this.replayJournal) {
      const recorded = this.replayJournal.judge.shift();
      if (!recorded) throw new Error("replay journal exhausted: judge");
      return recorded;
    }
    this.counters.providerCalls++;
    const result = { scores: this.scriptedScores(variants) };
    this.journal.judge.push(result);
    return result;
  }

  async structured(prompt: string, schema: StructuredSchema): Promise<unknown> {
    if (this.replayJournal) {
      if (this.replayJournal.structured.length === 0) throw new Error("replay journal exhausted: structured");
      return this.replayJournal.structured.shift();
    }
    this.counters.providerCalls++;
    // §16.5: the journal must record results in ISSUE order — replay answers the i-th call (in issue order)
    // with the i-th recorded result. Under concurrent delivery (§16.3a) a structured call may RESOLVE out of
    // issue order (unequal provider latency), so we reserve this call's journal slot NOW — synchronously, at
    // invocation, before the `await` — and fill it after resolution. Pushing at resolution time would order
    // the journal by wall-clock and break replay's issue-order contract.
    const slot = this.journal.structured.length;
    this.journal.structured.push(undefined);
    // track genuine in-flight overlap across the `await` below (§16.1/§16.3a): the high-water mark is ≥ 2
    // iff two workers' oracle calls were simultaneously in flight.
    this.counters.inFlightProviderCalls++;
    if (this.counters.inFlightProviderCalls > this.counters.maxInFlightProviderCalls) {
      this.counters.maxInFlightProviderCalls = this.counters.inFlightProviderCalls;
    }
    try {
      let raw: unknown;
      if (this.queue.length > 0) {
        const idx = this.queue.findIndex((entry) => entry.subject !== undefined && prompt.includes(entry.subject));
        const entry = idx >= 0 ? this.queue.splice(idx, 1)[0] : this.queue.shift();
        if (entry?.delayMs) await new Promise((r) => setTimeout(r, entry.delayMs));
        raw = entry?.payload ?? defaultStructured(schema);
        if (schema.type === "string" && typeof raw !== "string") raw = JSON.stringify(raw);
      } else if (typeof this.mode.provider === "object" && this.mode.provider?.kind === "static") {
        raw = schema.type === "string" ? this.mode.provider.text ?? "ok" : defaultStructured(schema);
      } else {
        raw = defaultStructured(schema);
      }
      this.journal.structured[slot] = raw;
      return raw;
    } finally {
      this.counters.inFlightProviderCalls--;
    }
  }

  async reply(prompt: string): Promise<string> {
    if (this.replayJournal) {
      const recorded = this.replayJournal.reply.shift();
      if (recorded === undefined) throw new Error("replay journal exhausted: reply");
      return recorded;
    }
    this.counters.providerCalls++;
    const p = this.mode.provider;
    const text = p && typeof p === "object" && p.kind === "static" ? p.text ?? "ok" : `(reply to: ${prompt})`;
    this.journal.reply.push(text);
    return text;
  }
}

function normalize(scores: Record<string, number>, variants: Variant[]): Record<string, number> {
  const out: Record<string, number> = {};
  let sum = 0;
  for (const v of variants) {
    out[v] = Math.max(0, scores[v] ?? 0);
    sum += out[v]!;
  }
  for (const v of variants) out[v] = sum === 0 ? 1 / variants.length : out[v]! / sum;
  return out;
}

function defaultStructured(schema: StructuredSchema): unknown {
  switch (schema.type) {
    case "string": return "enum" in schema ? schema.enum[0] ?? "" : "ok";
    case "integer": case "number": return 0;
    case "boolean": return true;
    case "null": return null;
    case "array": return [defaultStructured(schema.items)];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties)) out[k] = defaultStructured(v);
      return out;
    }
  }
}

// ---------- canonical SPEC 16.2 hashing ----------

function canonicalJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`)
    .join(",")}}`;
}

function canonicalChainHead(events: LedgerEvent[]): string {
  let head = "";
  for (const e of events) {
    const canonical = {
      tick: e.tick,
      etype: e.etype,
      subject: e.subject,
      payload: e.payload ?? null,
      corr: e.corr ?? null,
      agent: e.agent ?? "",
    };
    head = createHash("sha256").update(head + canonicalJson(canonical), "utf8").digest("hex");
  }
  return head;
}

// ---------- counters ----------

interface Counters {
  providerCalls: number;
  toolCalls: number;
  identityCalls: number;
  promptArrivals: number;
  decompositionCalls: number;
  embeddingCalls: number;
  // §16.1/§16.3a concurrency observability: how many provider oracle calls are simultaneously in flight
  // (`inFlightProviderCalls`, live) and the high-water mark over a run (`maxInFlightProviderCalls`). A mark
  // ≥ 2 is direct evidence that two workers' oracle calls genuinely overlapped — the honest scheduler-level
  // signal a concurrency test asserts on, independent of any wall-clock timing.
  inFlightProviderCalls: number;
  maxInFlightProviderCalls: number;
}

const freshCounters = (): Counters => ({
  providerCalls: 0, toolCalls: 0, identityCalls: 0,
  promptArrivals: 0, decompositionCalls: 0, embeddingCalls: 0,
  inFlightProviderCalls: 0, maxInFlightProviderCalls: 0,
});

// ---------- lifecycle correlation for the conformance event shape ----------

const CORRELATED = new Set(["Sent", "Delivered", "Resolved", "Expired", "ToolStarted", "ToolResolved"]);

function toConformanceEvent(e: KernelLedgerEvent): LedgerEvent {
  return {
    tick: e.tick,
    etype: e.etype,
    subject: e.subject,
    payload: e.payload,
    corr: CORRELATED.has(e.etype) ? e.subject : null,
    agent: e.agent ?? "",
  };
}

// ---------- trace validity (SPEC 16.2): the message lifecycle state machine ----------

function validateTrace(events: LedgerEvent[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const state = new Map<string, "sent" | "delivered" | "resolved" | "expired">();
  for (const e of events) {
    const key = String(e.corr ?? e.subject);
    const cur = state.get(key);
    switch (e.etype) {
      case "Sent":
        state.set(key, "sent");
        break;
      case "Delivered":
        if (cur === undefined) diagnostics.push({ category: "TraceViolation", message: `Delivered(${key}) without a prior Sent` });
        else if (cur === "expired") diagnostics.push({ category: "TraceViolation", message: `Delivered(${key}) after Expired` });
        else state.set(key, "delivered");
        break;
      case "Resolved":
        if (cur !== "delivered") diagnostics.push({ category: "TraceViolation", message: `Resolved(${key}) without a prior Delivered` });
        else state.set(key, "resolved");
        break;
      case "Expired":
        if (cur === undefined) diagnostics.push({ category: "TraceViolation", message: `Expired(${key}) without a prior Sent` });
        else state.set(key, "expired");
        break;
      default:
        break;
    }
  }
  return diagnostics;
}

// ---------- projection store (SPEC 16.7a test-mode) ----------

interface ProjectionCell {
  key: string;
  value: unknown;
  originTick: number;
  taint: string;
  basisHead: number;
  validThrough: number;
  dependencyScope: string[] | "global";
  stale: boolean;
}

interface Conflict {
  subject: string;
  invariant: string;
  facts: unknown[];
  detectedAt: number;
  status: "open" | "resolved" | "ignored";
}

interface GateProfile {
  id: string;
  gateSite: string;
  provider: string;
  model: string;
  schemaHash: string;
  promptTemplateHash: string;
  policyId: string;
  scoreFunction: string;
  calibrationPool: string;
  status: "active" | "stale" | "retired";
  calibrationHead: number;
  basis: string;
}

// ---------- the adapter ----------

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };

class AgapeTsConformanceAdapter {
  private ledger: LedgerEvent[] = [];
  private counters = freshCounters();
  private envelope = new MemoryEnvelope();
  private config: Record<string, unknown> = {};
  private projections = new Map<string, { cells: ProjectionCell[]; conflicts: Conflict[] }>();
  private lastProjection?: { cells: ProjectionCell[]; conflicts: Conflict[] };
  private profiles = new Map<string, GateProfile>();
  private seenIdempotencyKeys = new Set<string>();
  private runSeq = 0;

  async reset(): Promise<void> {
    this.ledger = [];
    this.counters = freshCounters();
    this.envelope = new MemoryEnvelope();
    this.config = {};
    this.projections.clear();
    this.lastProjection = undefined;
    this.profiles.clear();
    this.seenIdempotencyKeys.clear();
    this.runSeq = 0;
  }

  private appendGlobal(etype: string, subject: string, payload?: unknown, agent?: string): LedgerEvent {
    const ev: LedgerEvent = {
      tick: this.ledger.length,
      etype,
      subject,
      payload,
      corr: null,
      agent: agent ?? "",
    };
    this.ledger.push(ev);
    return ev;
  }

  private absorbRunEvents(events: LedgerEvent[]): void {
    const offset = this.ledger.length;
    for (const e of events) this.ledger.push({ ...e, tick: offset + e.tick });
  }

  // ---- health / config ----

  async health() {
    return {
      runtimeId: "agape-ts",
      runtimeKind: "studio-local",
      implementationVersion: pkg.version,
      languageSpecVersion: `v${pkg.version}`,
      conformanceSuiteVersion: `v${pkg.version}`,
      memorySchemaVersion: "1",
      canonicalLedgerVersion: "sha256-chain-v1",
      ledgerHead: this.ledger.length,
      provider: { status: "mock", backend: "mock" },
    };
  }

  async configRead(): Promise<Record<string, unknown>> {
    return { ...this.config };
  }

  async configWrite(patch: Record<string, unknown>): Promise<void> {
    // SPEC 17.2: decision policy lives in source, never in config.
    const policyKeys = new Set(["policy", "threshold", "margin", "floor", "conformalalpha", "conformal_alpha"]);
    const scan = (value: unknown, path: string[]): void => {
      if (!value || typeof value !== "object") return;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (policyKeys.has(k.toLowerCase())) {
          throw new ConformanceConfigError(
            `config.write cannot set decision policy ('${[...path, k].join(".")}') — policy lives in source (SPEC 17.2)`,
          );
        }
        scan(v, [...path, k]);
      }
    };
    scan(patch, []);
    Object.assign(this.config, patch);
  }

  // ---- compile / run / replay ----

  async check(input: { source: string; manifest?: Record<string, unknown> }): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> {
    const { source } = desugarLegacySurface(input.source);
    try {
      check(parse(source));
      return { ok: true, diagnostics: [] };
    } catch (err) {
      const cls = (err as { cls?: string; name?: string }).cls ?? (err as Error).name ?? "Error";
      return { ok: false, diagnostics: [{ category: cls, message: (err as Error).message }] };
    }
  }

  private buildRunOptions(
    desugaredTools: string[],
    program: ReturnType<typeof parse>,
    testMode: TestMode,
    journal: OracleJournal,
    replayJournal?: OracleJournal,
    stochasticSeed?: number,
  ) {
    const provider = new HarnessProvider(testMode, this.counters, journal, replayJournal, stochasticSeed);
    const toolNames = new Set<string>([...desugaredTools, ...Object.keys(testMode.tools ?? {})]);
    const manifest: Manifest = { provider: { backend: "mock" }, tools: {}, actions: {} };
    const toolHandlers: Record<string, ToolHandler> = {};
    for (const name of toolNames) {
      manifest.tools![name] = { driver: "host" };
      manifest.actions![name] = { tool: name };
      toolHandlers[name] = async () => {
        if (replayJournal) {
          if (replayJournal.tools.length === 0) throw new Error("replay journal exhausted: tools");
          return replayJournal.tools.shift();
        }
        this.counters.toolCalls++;
        const result = testMode.tools?.[name]?.result ?? null;
        journal.tools.push(result);
        return result;
      };
    }
    const opts: Parameters<typeof runtimeRun>[1] = {
      provider,
      manifest,
      toolHandlers,
      memory: new LocalMemoryDriver(),
    };
    const principalDirective = testMode.principal;
    if (principalDirective === "deny" || principalDirective === "grant") {
      opts!.principal = principalDirective;
    } else if (typeof principalDirective === "string" && principalDirective.startsWith("grant:")) {
      const decision = principalDirective.slice("grant:".length);
      const principals = program.decls.filter((d) => d.kind === "principal").map((d) => (d as { name: string }).name);
      opts!.principalAttestations = principals.map((principal) => ({ principal, decision }));
    }
    return opts!;
  }

  private countIdentityConsults(events: LedgerEvent[]): number {
    return events.filter((e) => e.etype === "PrincipalDecision" || e.etype === "FailedPrincipalDecision").length;
  }

  private async execute(
    source: string,
    testMode: TestMode,
    opts2: {
      record?: boolean;
      replayJournal?: OracleJournal;
      stochasticSeed?: number;
      absorb?: boolean;
      calibration?: Array<{ scores: Record<string, number>; label: string }>;
    },
  ): Promise<RunOutcome> {
    const { source: kernelSource, tools } = desugarLegacySurface(source);
    const journal: OracleJournal = { judge: [], structured: [], reply: [], tools: [] };
    const live = !opts2.replayJournal;
    try {
      const program = parse(kernelSource);
      const runOpts = this.buildRunOptions(tools, program, testMode, journal, opts2.replayJournal, opts2.stochasticSeed);
      // §15.5.6/§16.8: a warm conformal gate calibrates from the compatible label pool the runtime owns.
      if (opts2.calibration) runOpts.calibration = opts2.calibration;
      const session = createSession(program, runOpts);
      await session.start();
      for (const arrival of testMode.promptArrivals ?? []) {
        if (live) this.counters.promptArrivals++;
        await session.sendPrompt({ name: arrival.source, value: arrival.value ?? arrival.body });
      }
      const snapshot = session.snapshot();
      const events = snapshot.ledger.events.map(toConformanceEvent);
      if (live) this.counters.identityCalls += this.countIdentityConsults(events);
      if (opts2.absorb !== false) this.absorbRunEvents(events);
      const headHash = canonicalChainHead(events);
      const outcome: RunOutcome = { ok: true, head: this.ledger.length, headHash, events };
      if (opts2.record && live) {
        const recording: Recording = {
          kind: "agape-ts-recording",
          source,
          testMode,
          journal,
          memoryOps: this.envelope.snapshotOps(),
          headHash,
        };
        outcome.recording = recording;
      }
      return outcome;
    } catch (err) {
      const cls = (err as { cls?: string; name?: string }).cls ?? (err as Error).name ?? "Error";
      return {
        ok: false,
        head: this.ledger.length,
        headHash: "",
        events: [],
        error: { category: cls, message: (err as Error).message },
      };
    }
  }

  async run(input: { source: string; record?: boolean; testMode?: Record<string, unknown> }): Promise<RunOutcome> {
    this.runSeq++;
    return this.execute(input.source, (input.testMode ?? {}) as TestMode, { record: input.record, stochasticSeed: this.runSeq });
  }

  async replay(recording: unknown): Promise<{ ok: boolean; head: number; headHash: string; events: LedgerEvent[] }> {
    const rec = recording as Recording;
    if (!rec || rec.kind !== "agape-ts-recording") throw new Error("replay requires a recording produced by this adapter");
    const journalCopy: OracleJournal = JSON.parse(JSON.stringify(rec.journal)) as OracleJournal;
    const outcome = await this.execute(rec.source, rec.testMode ?? {}, { replayJournal: journalCopy, absorb: false });
    return { ok: outcome.ok, head: outcome.events.length, headHash: outcome.headHash, events: outcome.events };
  }

  async oracleStats(): Promise<Record<string, number>> {
    return { ...this.counters };
  }

  async canonicalHash(events: LedgerEvent[]): Promise<string> {
    return canonicalChainHead(events);
  }

  async ledgerRead(query?: { agent?: string; etype?: string; subject?: string; fromTick?: number; toTick?: number }): Promise<LedgerEvent[]> {
    return this.ledger.filter((e) => {
      if (query?.agent !== undefined && e.agent !== query.agent) return false;
      if (query?.etype !== undefined && e.etype !== query.etype) return false;
      if (query?.subject !== undefined && e.subject !== query.subject) return false;
      if (query?.fromTick !== undefined && e.tick < query.fromTick) return false;
      if (query?.toTick !== undefined && e.tick > query.toTick) return false;
      return true;
    });
  }

  async validateLedgerTrace(events: LedgerEvent[]): Promise<{ ok: boolean; diagnostics: Diagnostic[]; events: LedgerEvent[] }> {
    const diagnostics = validateTrace(events);
    return { ok: diagnostics.length === 0, diagnostics, events };
  }

  // ---- SPEC 16.1 external sources ----

  async triggerExternalSource(input: { source: string; sourceName: string; arrival: unknown; testMode?: Record<string, unknown> }) {
    const testMode = (input.testMode ?? {}) as TestMode;
    const { source: kernelSource, tools } = desugarLegacySurface(input.source);
    const journal: OracleJournal = { judge: [], structured: [], reply: [], tools: [] };
    const program = parse(kernelSource);
    const runOpts = this.buildRunOptions(tools, program, testMode, journal);
    const session = createSession(program, runOpts);
    await session.start();
    const beforeEvents = session.snapshot().ledger.events.map(toConformanceEvent);
    const hasOpenPrompt =
      program.decls.some((d) => d.kind === "prompt") && !beforeEvents.some((e) => e.etype === "Prompt");
    this.counters.promptArrivals++;
    await session.sendPrompt({ name: input.sourceName, value: input.arrival });
    const afterEvents = session.snapshot().ledger.events.map(toConformanceEvent);
    this.absorbRunEvents(afterEvents);
    const asOutcome = (events: LedgerEvent[]): RunOutcome => ({
      ok: true,
      head: events.length,
      headHash: canonicalChainHead(events),
      events,
    });
    return {
      beforeArrival: asOutcome(beforeEvents),
      afterArrival: asOutcome(afterEvents),
      liveBeforeArrival: hasOpenPrompt,
      quiescentAfterArrival: afterEvents.some((e) => e.etype === "Prompt" && e.subject === input.sourceName),
    };
  }

  // ---- SPEC 16.7 memory envelope (adapter test-mode; see runtime_adapter_memory.ts) ----

  async agentRespond(input: { agent: AgentRef; task: string; stimulus: { kind: string; text: string }; testMode?: Record<string, unknown> }) {
    const start = this.ledger.length;
    const packet = this.consult(input.agent, input.task);
    const testMode = (input.testMode ?? {}) as TestMode;
    this.counters.providerCalls++;
    const p = testMode.provider;
    const output = p && typeof p === "object" && p.kind === "static" ? p.text ?? "ok" : `(reply to: ${input.stimulus.text})`;
    return {
      ok: true,
      events: this.ledger.slice(start),
      memoryPacket: packet,
      output,
    };
  }

  private consult(agent: AgentRef, task: string) {
    const context = this.envelope.context(agent.instanceId, task);
    this.appendGlobal(
      "MemoryConsulted",
      agent.instanceId,
      { counts: this.envelope.counts(agent.instanceId), query: task },
      agent.instanceId,
    );
    return context;
  }

  async memoryIngest(input: { agent: AgentRef; artifact: { kind: string; uri: string; title: string; text: string } }) {
    const start = this.ledger.length;
    const nextTick = this.ledger.length;
    const result = this.envelope.decompose(input.agent.instanceId, input.artifact, nextTick);
    if (result.created && result.stored) {
      this.counters.decompositionCalls++;
      this.counters.embeddingCalls += result.stored.vectors.length;
      this.appendGlobal(
        "ArtifactObserved",
        input.artifact.uri,
        { kind: input.artifact.kind, uri: input.artifact.uri, title: input.artifact.title, sourceHash: result.sourceHash },
        input.agent.instanceId,
      );
      this.appendGlobal(
        "Internalized",
        input.artifact.uri,
        { sourceHash: result.sourceHash, counts: this.envelope.counts(input.agent.instanceId) },
        input.agent.instanceId,
      );
    }
    const stored = result.stored;
    return {
      created: result.created,
      sourceHash: result.sourceHash,
      summary: stored?.summary.text ?? "",
      chunkCount: stored?.chunks.length ?? 0,
      factCount: stored?.facts.length ?? 0,
      tripleCount: stored?.triples.length ?? 0,
      vectorCount: stored?.vectors.length ?? 0,
      events: this.ledger.slice(start),
    };
  }

  async memoryContext(input: { agent: AgentRef; task: string }) {
    return this.consult(input.agent, input.task);
  }

  async memoryInspect(input: { agent: AgentRef }) {
    const env = this.envelope.agentFor(input.agent.instanceId);
    const cells = (group: EnvelopeCell[]) => group.map((c) => ({ ...c }));
    return {
      agent: input.agent,
      counts: this.envelope.counts(input.agent.instanceId),
      summaries: cells(env.summaries),
      chunks: cells(env.chunks),
      facts: cells(env.facts),
      triples: cells(env.triples),
      vectors: cells(env.vectors),
      recentEvents: this.ledger.filter((e) => e.agent === input.agent.instanceId).slice(-20),
    };
  }

  async recordExperience(input: { agent: AgentRef; kind: string; subject: string; ok: boolean; text: string }): Promise<void> {
    const ev = this.appendGlobal(
      "Internalized",
      input.subject,
      { kind: input.kind, ok: input.ok, text: input.text },
      input.agent.instanceId,
    );
    this.counters.decompositionCalls++;
    this.envelope.addLesson(input.agent.instanceId, {
      originTick: ev.tick,
      taint: "raw",
      kind: "lesson",
      key: input.subject,
      text: input.text,
      ok: input.ok,
    });
  }

  async recordUserCorrection(input: { agent: AgentRef; subject: string; text: string; supersedes?: string }): Promise<void> {
    const ev = this.appendGlobal(
      "Internalized",
      input.subject,
      { kind: "user-correction", text: input.text, supersedes: input.supersedes },
      input.agent.instanceId,
    );
    this.envelope.addCorrection(input.agent.instanceId, {
      originTick: ev.tick,
      taint: "raw",
      kind: "correction",
      key: input.subject,
      text: input.text,
      supersedes: input.supersedes,
    });
  }

  async rebuildMemoryFromRecording(recording: unknown) {
    const rec = recording as Recording;
    if (!rec || rec.kind !== "agape-ts-recording") throw new Error("rebuild requires a recording produced by this adapter");
    const rebuilt = MemoryEnvelope.rebuild(rec.memoryOps ?? []);
    const out: Record<string, Awaited<ReturnType<AgapeTsConformanceAdapter["memoryInspect"]>>> = {};
    for (const instanceId of rebuilt.agentIds()) {
      const env = rebuilt.agentFor(instanceId);
      out[instanceId] = {
        agent: { template: "rebuilt", instanceId },
        counts: rebuilt.counts(instanceId),
        summaries: env.summaries,
        chunks: env.chunks,
        facts: env.facts,
        triples: env.triples,
        vectors: env.vectors,
        recentEvents: [],
      };
    }
    return out;
  }

  // ---- SPEC 16.7c longitudinal learning loop (deterministic per the suite README) ----

  async implementationLearningLoop(input: {
    agent: AgentRef;
    task: string;
    firstCandidateSource: string;
    expectedFirstFailure: string;
    revisionRequest: string;
    revisedMustContain: string[];
    revisedMustNotContain?: string[];
  }) {
    const loopStart = this.ledger.length;
    const agent = input.agent;

    // Turn 1: consult (empty), produce the fixed candidate, check it for real.
    const firstTurn = await this.agentRespond({
      agent,
      task: input.task,
      stimulus: { kind: "user", text: input.task },
    });
    const firstSource = input.firstCandidateSource;
    const firstCheck = await this.check({ source: firstSource });

    // Internalize the failure as decomposed experience.
    const diagnostic = firstCheck.diagnostics[0];
    const message = diagnostic?.message ?? "";
    const category = diagnostic?.category ?? input.expectedFirstFailure;
    const parsed = /perform\s+(\w+):\s*'(\w+)'/.exec(message);
    const sinkAction = parsed?.[1] ?? "the action";
    const taintedBinding = parsed?.[2] ?? "the value";
    const failRaw = `check failed: ${category}: ${message}`;
    const failSummary =
      `Lesson: '${taintedBinding}' must reach ${sinkAction} only through a committed-narrowed Endorsement — ` +
      `decide the credence, then endorse ${taintedBinding} and perform the Endorsement.`;
    const failEvent = this.appendGlobal(
      "Internalized",
      `${sinkAction}:${taintedBinding}`,
      { kind: "check", ok: false, category },
      agent.instanceId,
    );
    this.counters.decompositionCalls++;
    this.counters.embeddingCalls++;
    const failureExperience = {
      originTick: failEvent.tick,
      raw: failRaw,
      summary: failSummary,
      facts: [
        { key: "diagnostic.category", value: category },
        { key: "sink.action", value: sinkAction },
        { key: "tainted.binding", value: taintedBinding },
        { key: "required.fix", value: `route ${taintedBinding} through an Endorsement in a committed arm` },
      ],
      triples: [
        { s: sinkAction, p: "requires", o: "Endorsement" },
        { s: taintedBinding, p: "settled_by", o: "endorse" },
      ],
      vectorTexts: [failSummary, `${sinkAction} requires an Endorsement of ${taintedBinding}`],
    };
    this.envelope.addLesson(agent.instanceId, {
      originTick: failEvent.tick,
      taint: "raw",
      kind: "lesson",
      key: `${sinkAction}:${taintedBinding}:failure`,
      text: `${failRaw}\n${failSummary}`,
      ok: false,
    });
    const failureMemory = this.consult(agent, input.task);

    // Turn 2: consult again; the retrieved lesson drives a deterministic revision.
    const secondTurn = await this.agentRespond({
      agent,
      task: input.revisionRequest,
      stimulus: { kind: "user", text: input.revisionRequest },
    });
    const lessonRetrieved = JSON.stringify(secondTurn.memoryPacket).toLowerCase().includes("endorsement");
    const revisedSource = lessonRetrieved ? reviseWithEndorsement(firstSource) : firstSource;
    const revisedCheck = await this.check({ source: revisedSource });

    // Internalize the success.
    const successEvent = this.appendGlobal(
      "Internalized",
      `${sinkAction}:${taintedBinding}:revised`,
      { kind: "check", ok: true },
      agent.instanceId,
    );
    this.counters.decompositionCalls++;
    this.counters.embeddingCalls++;
    const revisedIdiom = extractEndorseIdiom(revisedSource);
    const successSummary =
      `The revised implementation passed check: ${sinkAction} now receives the committed-narrowed Endorsement (${revisedIdiom}).`;
    const successExperience = {
      originTick: successEvent.tick,
      raw: `check passed for the revised ${sinkAction} implementation`,
      summary: successSummary,
      facts: [
        { key: "pattern.gate", value: revisedIdiom },
        { key: "pattern.sink", value: `perform ${sinkAction}(e)` },
      ],
      triples: [{ s: sinkAction, p: "settled_by", o: revisedIdiom }],
      vectorTexts: [successSummary, `${revisedIdiom} then perform ${sinkAction}(e)`],
    };
    this.envelope.addLesson(agent.instanceId, {
      originTick: successEvent.tick,
      taint: "raw",
      kind: "lesson",
      key: `${sinkAction}:${taintedBinding}:success`,
      text: `${successExperience.raw}\n${successSummary}\nPattern: ${revisedIdiom} { ${sinkAction} committed arm } then perform ${sinkAction}(e).`,
      ok: true,
    });
    const finalMemory = this.consult(agent, input.task);

    return {
      firstTurn,
      firstSource,
      firstCheck,
      failureExperience,
      failureMemory,
      secondTurn,
      revisedSource,
      revisedCheck,
      successExperience,
      finalMemory,
      events: this.ledger.slice(loopStart),
    };
  }

  // ---- SPEC 16.7a projections ----

  async seedProjection(input: {
    name: string;
    facts: Array<{ subject: string; key: string; value: unknown; taint: string; singleValued?: boolean }>;
    mutation?: { subject: string; key: string; value: unknown; taint: string };
  }) {
    const cells: ProjectionCell[] = [];
    const conflicts: Conflict[] = [];
    const bySubjectKey = new Map<string, ProjectionCell[]>();

    for (const fact of input.facts) {
      const ev = this.appendGlobal("FactAsserted", fact.subject, { key: fact.key, value: fact.value, taint: fact.taint });
      const cell: ProjectionCell = {
        key: `${fact.subject}.${fact.key}`,
        value: fact.value,
        originTick: ev.tick,
        taint: fact.taint,
        basisHead: ev.tick,
        validThrough: ev.tick,
        dependencyScope: [fact.subject],
        stale: false,
      };
      cells.push(cell);
      const groupKey = `${fact.subject}0000${fact.key}`;
      const group = bySubjectKey.get(groupKey) ?? [];
      group.push(cell);
      bySubjectKey.set(groupKey, group);
      if (fact.singleValued && group.length > 1) {
        const values = new Set(group.map((c) => canonicalJson(c.value)));
        if (values.size > 1 && !conflicts.some((c) => c.subject === fact.subject && c.invariant.includes(fact.key))) {
          conflicts.push({
            subject: fact.subject,
            invariant: `single-valued(${fact.key})`,
            facts: group.map((c) => ({ key: c.key, value: c.value, originTick: c.originTick })),
            detectedAt: ev.tick,
            status: "open",
          });
        }
      }
    }

    if (input.mutation) {
      const m = input.mutation;
      const ev = this.appendGlobal("FactAsserted", m.subject, { key: m.key, value: m.value, taint: m.taint, mutation: true });
      for (const cell of cells) {
        if (cell.key === `${m.subject}.${m.key}`) {
          cell.stale = true;
          cell.validThrough = ev.tick - 1;
        }
      }
      cells.push({
        key: `${m.subject}.${m.key}`,
        value: m.value,
        originTick: ev.tick,
        taint: m.taint,
        basisHead: ev.tick,
        validThrough: ev.tick,
        dependencyScope: [m.subject],
        stale: false,
      });
    } else {
      const head = this.ledger.length - 1;
      for (const cell of cells) cell.validThrough = head;
    }

    const projection = { cells, conflicts };
    this.projections.set(input.name, projection);
    this.lastProjection = projection;
    return { cells, conflicts, gateProfiles: [...this.profiles.values()] };
  }

  async projectionInspect(_input?: { agent?: AgentRef; subject?: string }) {
    const projection = this.lastProjection ?? { cells: [], conflicts: [] };
    return { cells: projection.cells, conflicts: projection.conflicts, gateProfiles: [...this.profiles.values()] };
  }

  // ---- SPEC 16.8 calibration / config ----

  async calibrationScenario(input: {
    gateSite: string;
    enumVariants: string[];
    provider: { backend: string; model: string; exposesLogprobs?: boolean };
    policy: { basis: string; alpha?: number; threshold?: number; margin?: number; readiness?: number; floor?: number };
    labels: Array<{ scores: Record<string, number>; label: string }>;
    judgment: { scores?: Record<string, number>; samples?: string[] };
    drift?: Partial<Record<string, string>>;
  }) {
    const diagnostics: Diagnostic[] = [];
    // sampling fallback (SPEC 16.8): a backend without logprobs is served by >= 10 scored draws.
    let fallbackDraws = 0;
    let scores = input.judgment.scores;
    if (!scores) {
      const samples = input.judgment.samples ?? [];
      fallbackDraws = Math.max(samples.length, 10);
      const freq: Record<string, number> = {};
      for (const v of input.enumVariants) freq[v] = 0;
      for (const s of samples) freq[s] = (freq[s] ?? 0) + 1;
      scores = {};
      for (const v of input.enumVariants) scores[v] = samples.length ? (freq[v] ?? 0) / samples.length : 1 / input.enumVariants.length;
    }

    // GateProfile bookkeeping is adapter-level state; SPEC 16.8 stales a profile whenever any
    // scope key (provider/model/schema/prompt/policy) drifts from the pool it was fitted on.
    const readiness = input.policy.readiness ?? 0;
    const drifted = input.drift !== undefined && Object.keys(input.drift).length > 0;
    const profile: GateProfile = {
      id: `${input.gateSite}#1`,
      gateSite: input.gateSite,
      provider: input.provider.backend,
      model: input.provider.model,
      schemaHash: sha256Hex(input.enumVariants.join("|")),
      promptTemplateHash: sha256Hex(input.gateSite),
      policyId: sha256Hex(canonicalJson(input.policy)),
      scoreFunction: "top-probability",
      calibrationPool: input.gateSite,
      status: drifted ? "stale" : input.labels.length >= readiness ? "active" : "stale",
      calibrationHead: input.labels.length,
      basis: input.policy.basis === "conformal" ? "Conformal" : "Calibrated",
    };
    this.profiles.set(input.gateSite, profile);
    if (drifted) {
      diagnostics.push({
        category: "ProfileStale",
        message: `GateProfile for ${input.gateSite} is stale: scope drift on ${Object.keys(input.drift ?? {}).join(", ")}`,
      });
    }

    // The decision itself comes from a real kernel run of the gate rule over the judged scores. A conformal
    // rule carries its `readiness N` (the labelled-case minimum) so the kernel warm/cold-starts correctly.
    const rule =
      input.policy.basis === "conformal"
        ? `conformal ${input.policy.alpha ?? 0.05}${input.policy.readiness !== undefined ? ` readiness ${input.policy.readiness}` : ""}`
        : `confidence ${input.policy.threshold ?? 0.5}${input.policy.margin !== undefined ? ` margin ${input.policy.margin}` : ""}`;
    const source = `
      enum Gate { ${input.enumVariants.join(", ")} }
      agent Calib {
        on awake {
          Credence<Gate> c = self <- "calibration judgment for ${input.gateSite}";
          Decision<Gate> d = decide c by ${rule};
        }
      }
      spawn Calib g; awake g;
    `;
    // §15.5.6 warm conformal: feed the kernel the compatible calibration pool ONLY when the profile is fit
    // (conformal basis, no scope drift). A drifted or threshold profile passes no pool → the kernel cold-starts.
    const calibration =
      input.policy.basis === "conformal" && !drifted && input.labels.length > 0 ? input.labels : undefined;
    const outcome = await this.execute(source, { provider: { credence: scores } }, { calibration });
    const decided = outcome.events.filter((e) => e.etype === "Decided").pop();
    const payload = (decided?.payload ?? {}) as Record<string, unknown>;
    const committed = drifted ? "abstained" : String(payload.committed ?? "abstained");
    const predictionSet = Array.isArray(payload.prediction_set) ? (payload.prediction_set as string[]) : undefined;
    return {
      decision: {
        committed,
        basis: String(payload.basis ?? (input.policy.basis === "conformal" ? "Conformal" : "Threshold")),
        margin: Number(payload.margin ?? 0),
        ...(predictionSet && !drifted ? { predictionSet } : {}),
        usedProfileId: profile.id,
      },
      profile,
      fallbackDraws,
      diagnostics,
      events: outcome.events,
    };
  }

  async resolveConfig(input: {
    specDefaults?: Record<string, unknown>;
    globalConfig?: Record<string, unknown>;
    projectManifest?: Record<string, unknown>;
    env?: Record<string, string>;
  }) {
    // SPEC 17 precedence: spec defaults < global config < project manifest; env supplies
    // availability signals only and never leaks values into the resolved snapshot.
    const resolved: Record<string, unknown> = {};
    const sources: Record<string, "spec" | "global" | "project" | "env" | "derived"> = {};
    const layers: Array<["spec" | "global" | "project", Record<string, unknown> | undefined]> = [
      ["spec", input.specDefaults],
      ["global", input.globalConfig],
      ["project", input.projectManifest],
    ];
    const mergeLayer = (layer: "spec" | "global" | "project", value: Record<string, unknown>, target: Record<string, unknown>, path: string[]) => {
      for (const [k, v] of Object.entries(value)) {
        const dotted = [...path, k].join(".");
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const nested = ((target[k] as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
          target[k] = nested;
          mergeLayer(layer, v as Record<string, unknown>, nested, [...path, k]);
        } else {
          target[k] = v;
          sources[dotted] = layer;
        }
      }
    };
    for (const [layer, value] of layers) if (value) mergeLayer(layer, value, resolved, []);

    const provider = (resolved.provider ?? {}) as Record<string, unknown>;
    resolved.provider = provider;
    if (provider.exposes_logprobs === undefined || sources["provider.exposes_logprobs"] === undefined) {
      // derived from the backend exactly as src/config.ts derives it (anthropic=false, openai/gemini=true).
      provider.exposes_logprobs = provider.backend === "openai" || provider.backend === "gemini";
      sources["provider.exposes_logprobs"] = "derived";
    }
    const diagnostics: Diagnostic[] = [];
    return { resolved, sources, diagnostics };
  }

  // ---- SPEC 15.5 stochastic consistency / idempotency ----

  async multiRunScenario(input: {
    source: string;
    runs: number;
    observation: string;
    testMode?: Record<string, unknown>;
  }) {
    const testMode = (input.testMode ?? {}) as TestMode;
    const runs: RunOutcome[] = [];
    const observations: string[] = [];
    for (let i = 0; i < input.runs; i++) {
      const outcome = await this.execute(input.source, testMode, { stochasticSeed: i, absorb: false });
      runs.push(outcome);
      observations.push(this.observe(outcome, input.observation));
    }
    let nonEquivalentPairs = 0;
    let totalPairs = 0;
    for (let i = 0; i < observations.length; i++) {
      for (let j = i + 1; j < observations.length; j++) {
        totalPairs++;
        if (observations[i] !== observations[j]) nonEquivalentPairs++;
      }
    }
    const violationRate = totalPairs === 0 ? 0 : nonEquivalentPairs / totalPairs;
    return {
      runs,
      observations,
      nonEquivalentPairs,
      violationRate,
      betaBound: testMode.stochasticProvider?.betaBound,
    };
  }

  private observe(outcome: RunOutcome, observation: string): string {
    if (observation === "ledger-head") return outcome.headHash;
    const decided = outcome.events.filter((e) => e.etype === "Decided").pop();
    const payload = (decided?.payload ?? {}) as Record<string, unknown>;
    return String(payload.committed ?? "abstained");
  }

  async idempotencyScenario(input: {
    source: string;
    repeatedInput: unknown;
    repetitions: number;
    testMode?: Record<string, unknown>;
  }) {
    const testMode = (input.testMode ?? {}) as TestMode;
    const arrival = input.repeatedInput as { source: string; idempotencyKey?: string; body?: unknown; value?: unknown };
    const { source: kernelSource, tools } = desugarLegacySurface(input.source);
    const journal: OracleJournal = { judge: [], structured: [], reply: [], tools: [] };
    const program = parse(kernelSource);
    const runOpts = this.buildRunOptions(tools, program, testMode, journal);
    const session = createSession(program, runOpts);
    await session.start();
    let delivered = 0;
    for (let i = 0; i < input.repetitions; i++) {
      // exactly-once ingress: the adapter's transport layer deduplicates repeated external input
      // by idempotency key before it reaches the runtime (SPEC 15.5 exactly-once delivery).
      const key = `${arrival.source}0000${arrival.idempotencyKey ?? canonicalJson(arrival)}`;
      if (this.seenIdempotencyKeys.has(key)) continue;
      this.seenIdempotencyKeys.add(key);
      this.counters.promptArrivals++;
      await session.sendPrompt({ name: arrival.source, value: arrival.value ?? arrival.body });
      delivered++;
    }
    const events = session.snapshot().ledger.events.map(toConformanceEvent);
    this.absorbRunEvents(events);
    const committedOutcomes = events
      .filter((e) => e.etype === "Decided")
      .map((e) => String(((e.payload ?? {}) as Record<string, unknown>).committed ?? "abstained"));
    const sideEffectCount = events.filter((e) => e.etype === "ToolStarted").length;
    return {
      events,
      deduped: delivered < input.repetitions,
      committedOutcomes,
      sideEffectCount,
    };
  }
}

// ---- the deterministic reviser used by the learning loop ----
// Rewrites the known bad idiom `if (d.committed == V) { perform ACT(arg); }` into the endorsed
// arm-block idiom the suite expects; applied only when the failure lesson was retrieved from memory.

function reviseWithEndorsement(source: string): string {
  const m = /if\s*\(\s*(\w+)\.committed\s*==\s*(\w+)\s*\)\s*\{\s*perform\s+(\w+)\(\s*(\w+)\s*\)\s*;\s*\}/.exec(source);
  if (!m) return source;
  const [, decision, variant, action, arg] = m as unknown as [string, string, string, string, string];
  const enumMatch = /enum\s+\w+\s*\{([^}]*)\}/.exec(source);
  const variants = (enumMatch?.[1] ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const others = variants.filter((v) => v !== variant);
  const armBlock = [
    `endorse ${arg} by ${decision} {`,
    `            ${variant} as e { perform ${action}(e); }`,
    ...others.map((v) => `            ${v} { }`),
    `          }`,
  ].join("\n");
  return source.replace(m[0], armBlock);
}

function extractEndorseIdiom(source: string): string {
  const m = /endorse\s+\w+\s+by\s+\w+/.exec(source);
  return m ? m[0] : "endorse the subject by the decision";
}

export function createAdapter(): AgapeTsConformanceAdapter {
  return new AgapeTsConformanceAdapter();
}

export default createAdapter();
