// Interpreter — an async discrete-event runtime over the ledger (§16.1). Evaluates a parsed Program.
// Cognition is async (a model call through the provider seam), so evaluation is async throughout —
// the mock provider resolves on a microtask, so the same async path is exercised in tests and live.

import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import type * as A from "./ast.js";
import {
  Ledger, MockProvider, ingressJoin, ingressOf, render, settledText,
  type Provider, type StructuredSchema, type Value, type Committed, type Variant, type Trust, type IngressProvenance,
} from "./runtime.js";
import { check, linkModules, type ModuleInput, type Resolution } from "./check.js";
import { createMemoryDriver, type Manifest, type ToolBindingConfig } from "./config.js";
import type { MemoryDriver, MemoryProvenance, MemoryReceipt, MemoryScope } from "./memory.js";
import { compactMemoryText, renderReplyRecollection, renderStoreRecollection } from "./memory_runtime.js";
import { parse } from "./parser.js";
import { typeError, taintViolation, authorityViolation, configError } from "./errors.js";
import { createToolHandlers, type ToolHandler } from "./tool_adapters.js";

export class RuntimeError extends Error {}
// §5: an unrecoverable seam failure (the provider returns nothing) crashes the agent — CONTAINED, not a
// death: AgentCrashed is recorded, the on-crash hook runs, and the instance's state survives.
class CrashError extends Error {}
// §6c: `complete`/`fail` terminate the enclosing task handler (control flow, not a fault).
class TaskDoneSignal extends Error {}

// §6c task-send state, correlated by the delegator-side binding name (the corr subject).
interface TaskState {
  corr: string;
  dest: string;
  delegator?: string;
  scope: string[];      // the action names an ENDORSED task enables on the worker (§6c, §13)
  endorsed: boolean;    // the message was an Endorsement<TaskSpec>
  foreground: boolean;  // result-bound (waits) vs Task<T> handle-bound (reactive)
  status: "sent" | "delivered" | "completed" | "failed" | "cancelled" | "expired";
  delivered: boolean;   // it reached the worker at least once (drives the on-cancelled hook)
  result?: Value;
  // The delegating reaction's prompt provenance: a background delivery drains AFTER the
  // originating async context has ended, so the task carries it and restores it at delivery.
  provenance?: MemoryProvenance;
}
const taskTerminal = (t: TaskState): boolean =>
  t.status === "completed" || t.status === "failed" || t.status === "cancelled" || t.status === "expired";

// §6c subscription ALIASES: TaskSubmitted/TaskAssigned/TaskExpired are compile-time rewrites onto the
// transport chain (Sent/Delivered/Expired) filtered by correlation — they are never rows of their own.
const TASK_ALIASES: Record<string, string> = {
  TaskSubmitted: "Sent",
  TaskAssigned: "Delivered",
  TaskExpired: "Expired",
};

// A private-memory region: the values written through a `mem` handle, plus a `forgotten` flag — a
// `forget` tombstones the region (it stays in the map for audit, but is no longer recallable, §10).
interface MemRegion {
  writes: Value[];
  forgotten: boolean;
}

interface AgentInstance {
  name: string;
  agentType: string;
  decl: A.AgentDecl;
  awake: boolean;
  fields: Map<string, Value>;
  // each instance owns its own private memory, namespaced per-instance (§16.7).
  mems: Map<string, MemRegion>;
  // the home MODULE of the agent's declaration (§19.2). A companion agent (`m.Worker`) runs with its
  // bodies' bare event/action/struct names resolved within this module, and its own-module private
  // events land on the ledger under their qualified name (`m.Glitch`). undefined = the main program.
  module?: string;
}

class Scope {
  vars = new Map<string, Value>();
  // §5b the declared type of each `var`-bound name, kept so an assignment to a typed lvalue can thread the
  // target's declared type as the `expected` type into the RHS (a bare `xs = self <- prompt {…}` requests
  // the same structured schema a `text[] xs = self <- prompt {…}` declaration would). Recorded on the OWNING
  // scope alongside its value; an empty `text[]` loses its element type at the value level, so the declared
  // TypeRef — not the runtime value — is the reliable source.
  declaredTypes = new Map<string, A.TypeRef>();
  // §12 dependence declarations in scope, threaded to the fusion point so `all`/`any`/`quorum` compose
  // dependent clusters (Fréchet bound) vs independent units (log-odds) correctly at runtime. Each keeps
  // its relation so only `dependent` groups form clusters.
  depGroups: { relation: "independent" | "dependent"; names: string[] }[] = [];
  // §12/§15.4: the fan-out position of this execution — the chain of `|>` element indices leading here.
  // A `spawn` EXPRESSION derives a deterministic instance name from (call-site, this path) instead of
  // execution order, so a dynamic fan-out `xs |> f` that spawns inside `f` replays byte-identically.
  fanoutPath?: number[];
  constructor(public parent?: Scope, public agent?: AgentInstance) {}
  getFanoutPath(): number[] {
    if (this.fanoutPath) return this.fanoutPath;
    if (this.parent) return this.parent.getFanoutPath();
    return [];
  }
  get(name: string): Value | undefined {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    if (this.agent?.fields.has(name)) return this.agent.fields.get(name);
    return undefined;
  }
  set(name: string, v: Value) {
    this.vars.set(name, v);
  }
  setDeclaredType(name: string, t: A.TypeRef) {
    this.declaredTypes.set(name, t);
  }
  // The declared type of a name, resolved exactly as `get` resolves its value (own vars, then parent, then
  // agent field). Returns undefined for a name with no recorded type (a param, loop binding, or agent field
  // whose declaration is absent), so callers fall back to today's expected-less behavior.
  declaredType(name: string): A.TypeRef | undefined {
    if (this.vars.has(name)) return this.declaredTypes.get(name);
    if (this.parent) return this.parent.declaredType(name);
    if (this.agent?.fields.has(name)) return this.agent.decl.fields.find((f) => f.name === name)?.type;
    return undefined;
  }
  assign(name: string, v: Value) {
    if (this.vars.has(name)) {
      this.vars.set(name, v);
    } else if (this.parent && this.parent.get(name) !== undefined) {
      this.parent.assign(name, v);
    } else if (this.agent?.fields.has(name)) {
      this.agent.fields.set(name, v);
    } else {
      this.vars.set(name, v);
    }
  }
  addDepGroup(relation: "independent" | "dependent", names: string[]) { this.depGroups.push({ relation, names }); }
  allDepGroups(): { relation: "independent" | "dependent"; names: string[] }[] {
    return [...this.depGroups, ...(this.parent ? this.parent.allDepGroups() : [])];
  }
  currentAgent(): AgentInstance | undefined {
    return this.agent ?? this.parent?.currentAgent();
  }
}

function scoreSummary(scores: Record<Variant, number>) {
  const top = topVariant(scores);
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const runnerUp = sorted[1] ? { variant: sorted[1][0], score: sorted[1][1] } : undefined;
  return { scores, top, runnerUp, margin: top.score - (runnerUp?.score ?? 0) };
}

function valueSummary(v: Value): Record<string, unknown> {
  const base: Record<string, unknown> = { kind: v.kind, trust: v.trust, ingress: ingressOf(v), rendered: render(v) };
  if (v.kind === "text") return { ...base, value: v.v };
  if (v.kind === "int" || v.kind === "float" || v.kind === "bool") return { ...base, value: v.v };
  if (v.kind === "null") return { ...base, value: null };
  if (v.kind === "enumval") return { ...base, enum: v.enumName, variant: v.variant, value: v.variant };
  if (v.kind === "credence") return { ...base, enum: v.enumName, ...scoreSummary(v.scores) };
  if (v.kind === "decision") return {
    ...base,
    binding: v.binding,
    enum: v.enumName,
    committed: v.committed,
    basis: v.basis,
    margin: v.margin,
    decision_id: v.decisionId,
    principal_event: v.principalEvent,
    rule: v.rule,
  };
  if (v.kind === "endorsement") {
    return {
      ...base,
      binding: v.binding,
      enum: v.enumName,
      committed: v.committed,
      basis: v.basis,
      margin: v.margin,
      decision_id: v.decisionId,
      subject: valueSummary(v.subject),
      committedNarrowed: v.committedNarrowed,
    };
  }
  if (v.kind === "agentref") return { ...base, name: v.name, agentType: v.agentType };
  if (v.kind === "memref") return { ...base, name: v.name };
  if (v.kind === "struct") {
    return {
      ...base,
      type: v.typeName,
      fields: Object.fromEntries([...v.fields].map(([name, value]) => [name, valueSummary(value)])),
    };
  }
  if (v.kind === "array") return { ...base, items: v.items.map(valueSummary) };
  return base;
}

function isRuntimeValue(raw: unknown): raw is Value {
  return raw !== null && typeof raw === "object" && typeof (raw as { kind?: unknown }).kind === "string" && "trust" in raw;
}

function typeLabel(t: A.TypeRef): string {
  switch (t.kind) {
    case "scalar": return t.name;
    case "event": return `event<${typeLabel(t.inner)}>`;
    case "array": return `${typeLabel(t.inner)}[]`;
    case "credence": return `Credence<${t.enumName}>`;
    case "decision": return `Decision<${t.enumName}>`;
    case "endorsement": return `Endorsement<${typeLabel(t.inner)}>`;
    case "task": return `Task<${typeLabel(t.inner)}>`;
    case "named": return t.typeArgs?.length ? `${t.name}<${t.typeArgs.map(typeLabel).join(", ")}>` : t.name;
    case "mem": return "mem";
  }
}

function ruleSummary(rule: A.Rule): Record<string, unknown> {
  switch (rule.kind) {
    case "confidence": return { kind: "confidence", threshold: rule.theta, margin: rule.margin, floor: rule.floor };
    case "conformal": return { kind: "conformal", alpha: rule.alpha, readiness: rule.readiness, floor: rule.floor };
    case "policy": return { kind: "policy", name: rule.name };
    case "expr": return { kind: "expr" };
  }
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.entries(v as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, val]) => `${JSON.stringify(k)}:${stableJson(val)}`)
    .join(",")}}`;
}

function sha256(v: unknown): string {
  return createHash("sha256").update(stableJson(v)).digest("hex");
}

function localAttestation(kind: string, payload: Record<string, unknown>, supplied?: { attester?: string; signature?: string; [key: string]: unknown }) {
  const payloadHash = sha256(payload);
  const attester = supplied?.attester || "studio-user";
  const signature = supplied?.signature || `local:${sha256({ kind, attester, payload_hash: payloadHash })}`;
  return {
    kind,
    attester,
    payload_hash: payloadHash,
    signature,
    ...Object.fromEntries(Object.entries(supplied ?? {}).filter(([k]) => k !== "attester" && k !== "signature")),
  };
}

// The kernel clock, rendered for prompts: weekday, date, 12-hour time in the host's local zone.
// AGAPE_FIXED_NOW (any Date-parseable string) pins it for deterministic tests and replays.
function clockText(): string {
  const fixed = process.env.AGAPE_FIXED_NOW;
  const d = fixed ? new Date(fixed) : new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pad = (x: number) => String(x).padStart(2, "0");
  const h24 = d.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${days[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(h12)}:${pad(d.getMinutes())} ${h24 < 12 ? "AM" : "PM"}`;
}

export interface RunResult {
  ledger: Ledger;
  stdout: string[];
  warnings: RuntimeWarning[];
}

export interface RuntimeWarning {
  kind: "tainted_ingress_to_provider";
  message: string;
  prompt: string;
  ingress: "external_unscreened";
  agent?: string;
  subject?: string;
}

export interface PromptInput {
  name: string;
  value: unknown;
  attestation?: {
    attester?: string;
    signature?: string;
    [key: string]: unknown;
  };
}

export interface PrincipalAttestation {
  principal: string;
  approved?: boolean;
  decision?: string;
  attester?: string;
  signature?: string;
  [key: string]: unknown;
}

export interface RuntimeSession {
  start(): Promise<RunResult>;
  sendPrompt(input: PromptInput): Promise<RunResult>;
  snapshot(): RunResult;
}

// §13/§16.4 — the identity dependency's consult request. When a principal-prefixed `decide` escalates
// (the rule could not commit) and no pre-supplied attestation or harness directive covers it, the
// runtime PAUSES and presents `(p, c)` outward: the principal must rule with ONE OF E's VARIANTS
// ("the human's reply arrives as one of `E`'s variants", §13) or decline. Resolving with an
// attestation records PrincipalDecision (basis Principal); resolving undefined declines →
// FailedPrincipalDecision and the decision stays abstained (fail closed).
export interface ConsultRequest {
  principal: string;
  enumName: string;
  variants: string[];
  scores: Record<string, number>;
  margin: number;
  agent?: string;
}

// §15.5.6 split-conformal calibration input: a past decision scored over the enum's variants, tagged with
// the true label later recorded for it. When present (and at/above the rule's `readiness`), a `by conformal α`
// gate calibrates its prediction set from this pool instead of cold-starting. A vanilla runtime supplies none.
export interface ConformalLabel {
  scores: Record<string, number>;
  label: string;
}

type RunOptions = {
  provider?: Provider;
  modules?: ModuleInput[];
  manifest?: Manifest;
  principal?: string;
  promptInputs?: PromptInput[];
  principalAttestations?: PrincipalAttestation[];
  onConsult?: (req: ConsultRequest) => Promise<PrincipalAttestation | undefined>;
  toolHandlers?: Record<string, ToolHandler>;
  memory?: MemoryDriver;
  memoryRoot?: string;
  projectRoot?: string;
  strictConfig?: boolean;
  timingOriginMs?: number;
  // §15.5.6/§16.8: the compatible labelled cases a `by conformal α` gate calibrates from (the GateProfile's
  // calibration pool, supplied by the runtime that owns the ledger). Absent → conformal gates cold-start.
  calibration?: ConformalLabel[];
};

export async function run(
  program: A.Program,
  opts: RunOptions = {},
): Promise<RunResult> {
  const session = createSession(program, opts);
  await session.start();
  for (const input of opts.promptInputs ?? []) await session.sendPrompt(input);
  return session.snapshot();
}

export function createSession(program: A.Program, opts: RunOptions = {}): RuntimeSession {
  const manifest: Manifest = opts.manifest ?? { provider: { backend: "mock" } };
  check(program, opts.modules, manifest, opts.strictConfig); // static pass first (TypeError/ModuleError/ConfigError/…)
  const provider = opts.provider ?? new MockProvider();
  const projectRoot = resolvePath(opts.projectRoot ?? process.cwd());
  // The memory runtime shares the session's provider so reflection (when the
  // manifest opts in) runs behind the same seam as every other cognition call.
  const memory = opts.memory ?? createMemoryDriver(manifest, { cwd: opts.memoryRoot ?? projectRoot, provider });
  const toolHandlers = { ...createToolHandlers(manifest), ...(opts.toolHandlers ?? {}) };
  return new Interpreter(
    program,
    provider,
    opts.modules ?? [],
    opts.principal,
    opts.principalAttestations ?? [],
    opts.onConsult,
    manifest,
    toolHandlers,
    opts.timingOriginMs,
    memory,
    projectRoot,
    opts.calibration ?? [],
  );
}

class Interpreter {
  private ledger: Ledger;
  private stdout: string[] = [];
  private warnings: RuntimeWarning[] = [];
  private started = false;
  private enums = new Map<string, string[]>();
  private structs = new Map<string, A.Field[]>();
  private actions = new Map<string, A.ActionDecl>();
  private events = new Map<string, A.EventDecl>();
  private agents = new Map<string, A.AgentDecl>();
  private fns = new Map<string, A.FnDecl>();
  private instances = new Map<string, AgentInstance>();
  // §7/§16.3 event-driven `when` dispatch: an agent's `when` handlers become active SUBSCRIPTIONS when it
  // awakes (in lexical/registration order). Appending a matching event fires them — by subtype (§9), the
  // `about <subj>` filter, and the `if (guard)` predicate — in registration order, before the next statement.
  // `scope` present = a BLOCK-LOCAL `when` hoisted at its handler-scope entry (§16.3): the handler body
  // fires with that captured scope as parent, so a task handle bound in the hook is visible to `about h`.
  private subscriptions: { inst?: AgentInstance; when: A.WhenStmt; scope?: Scope }[] = []; // inst absent = a top-level `when`
  // §6c task runtime state: every delegation by correlation, the queued background deliveries, and the
  // ACTIVE task per worker instance (set for the duration of its task handler).
  private tasks = new Map<string, TaskState>();
  private pendingDeliveries: TaskState[] = [];
  // The active assigned task, scoped to the async EXECUTION rather than the agent name. A per-name
  // slot only supports NESTED delivery (save/restore); AsyncLocalStorage lets one agent run many
  // CONCURRENT task handlers (e.g. `claims |> delegate-to-worker`) without their active tasks
  // clobbering each other — `complete`/`fail`/scope-checks read the task of the current async path.
  private activeTaskALS = new AsyncLocalStorage<TaskState>();
  // WHO the running reaction's episode came from: the originating prompt delivery's attestation
  // identity, scoped to the async execution like activeTaskALS. Every memory internalize inside
  // the delivery's cascade records it (metadata.provenance, additive); reactions with no prompt
  // origin (heartbeat ticks, spawn/awake hooks) leave the store empty and the key absent.
  private promptProvenanceALS = new AsyncLocalStorage<MemoryProvenance>();
  private drainingTasks = false;
  private dispatchDepth = 0; // reentrancy guard: a handler's appends cascade, but bounded (events are finite).
  // §3: the set of declared `principal NAME;` names, so evalGate can recognize the suite's `decide c by p`
  // form — the parser records `by p` as a {policy} rule (it cannot tell principal from policy context-free),
  // and the interpreter reinterprets a policy-named rule whose name is a declared principal as the escalation.
  private principals = new Set<string>();
  // §13: declared `policy NAME { … }` rule bundles, applied when a `decide c by NAME` names one.
  private policies = new Map<string, A.PolicyDecl>();
  // §15.2/§20: the file-level `conformal α;` default a bare `by conformal` (no α) inherits (else 0.05, §15.5.6).
  private fileConformalAlpha?: number;
  private prompts = new Map<string, A.PromptDecl>();
  // §6: sends that EXPIRED before their destination was awake — refused (DeliveryRefused) if it later awakes.
  private pendingExpired: { dest: string; subj: string }[] = [];
  // §16.1: seam calls can be in flight concurrently, but their observable close events are applied in
  // issue order so replay is independent of wall-clock promise resolution order.
  private resolutionTail: Promise<void> = Promise.resolve();
  // §19.2 module resolution (erased from the linker): a bound bare name (selective import) → its
  // qualified name, and every companion module's simple decl names, so a bare name in a companion
  // agent's body resolves within that module (`emit Glitch` inside `m` → `m.Glitch`).
  private resolution: Resolution;
  private moduleDeclNames = new Map<string, Set<string>>(); // module name → its simple decl names
  // the home MODULE of a qualified agent type (`m.Worker` → `m`), so a spawned companion agent's body
  // resolves its bare names within that module.
  private agentModuleOf = new Map<string, string>();

  // §13/§17.5: the mock outcome of a principal-driven `decide c by <principal>`, supplied by the harness
  // `principal:` directive (e.g. "grant" / "deny"). Undefined = no principal decision configured. The
  // principal-decide implementation consumes this to commit (grant → PrincipalDecision) or decline
  // (deny → FailedPrincipalDecision).
  constructor(
    private program: A.Program,
    private provider: Provider,
    modules: ModuleInput[],
    private principalOutcome?: string,
    private principalAttestations: PrincipalAttestation[] = [],
    private onConsult?: (req: ConsultRequest) => Promise<PrincipalAttestation | undefined>,
    private manifest?: Manifest,
    private toolHandlers: Record<string, ToolHandler> = {},
    timingOriginMs: number | undefined = undefined,
    private memory: MemoryDriver = createMemoryDriver(manifest ?? { provider: { backend: "mock" } }),
    private projectRoot: string = process.cwd(),
    private calibrationPool: ConformalLabel[] = [],
  ) {
    this.ledger = new Ledger(timingOriginMs);
    // §3: register the declared principal names so a `decide c by p` (the parser's {policy} rule form)
    // can be reinterpreted as a principal escalation by evalGate.
    for (const d of program.decls) if (d.kind === "principal") this.principals.add(d.name);
    // Re-run the linker (it already passed in `check`, so it will not throw here) to recover the erased
    // resolution map, and register every companion module's declarations under their qualified names.
    this.resolution = (modules.length > 0 || (program.imports?.length ?? 0) > 0)
      ? linkModules(program, modules)
      : { qualifiedDecls: new Map(), bareBindings: new Map() };
    for (const m of modules) {
      const prog = parse(m.src);
      const modName = m.name ?? prog.module ?? "<root>";
      const simpleNames = new Set<string>();
      for (const d of prog.decls) {
        if (d.kind === "instruction") continue;
        const simple = (d as { name: string }).name;
        simpleNames.add(simple);
        const qname = `${modName}.${simple}`;
        this.registerDecl(qname, d);
        if (d.kind === "agent") this.agentModuleOf.set(qname, modName);
      }
      this.moduleDeclNames.set(modName, simpleNames);
    }
    // §19.2: register every resolved qualified name (including an import alias's `u.dbl` and re-exported
    // facade names) so a qualified call/reference in the main program resolves at runtime.
    for (const [qname, d] of this.resolution.qualifiedDecls) {
      this.registerDecl(qname, d);
      if (d.kind === "agent") {
        // the alias/prefix-qualified agent's home module is the module the linker resolved it to; recover it
        // from a companion whose simple decl set contains the agent's simple name (best-effort, for bare-name
        // resolution inside a spawned aliased agent — the common case is the canonical `<mod>.<simple>` above).
        const simple = d.name;
        for (const [mod, names] of this.moduleDeclNames) {
          if (names.has(simple) && this.agents.get(`${mod}.${simple}`) === d) { this.agentModuleOf.set(qname, mod); break; }
        }
      }
    }
  }

  // register one declaration under a (possibly qualified) name in the runtime decl tables.
  private registerDecl(name: string, d: A.Decl): void {
    switch (d.kind) {
      case "enum": this.enums.set(name, d.variants); break;
      case "struct": this.structs.set(name, d.fields); break;
      case "action": this.actions.set(name, d); break;
      case "event": this.events.set(name, d); break;
      case "agent": this.agents.set(name, d); break;
      case "fn": this.fns.set(name, d); break;
      default: break;
    }
  }

  async start(): Promise<RunResult> {
    if (this.started) return this.snapshot();
    this.started = true;
    for (const d of this.program.decls) {
      switch (d.kind) {
        case "enum": this.enums.set(d.name, d.variants); break;
        case "struct": this.structs.set(d.name, d.fields); break;
        case "action": this.actions.set(d.name, d); break;
        case "event": this.events.set(d.name, d); break;
        case "agent": this.agents.set(d.name, d); break;
        case "fn": this.fns.set(d.name, d); break; // callable by name (e.g. `coll |> fn`, §12)
        case "instruction": break;
        case "interface": break; // interfaces erase before the dynamic semantics (§19.5) — no runtime machinery
        // declared dependencies + the file-level conformal default are static config, not ledger writes:
        // `principal` is consumed at a `decide c by p` site (evalGate), `prompt` opens its sensor at awake
        // (execAwake), and `conformal α;` is a parse-only default (§20) — none run here.
        case "principal": break;
        case "prompt": this.prompts.set(d.name, d); break;
        case "conformal": this.fileConformalAlpha = d.alpha; break;
        case "policydecl": this.policies.set(d.name, d); break;
      }
    }
    // §19.2: bind selectively-imported bare names to their imported declaration (`import { dbl } from util`
    // makes bare `dbl` call `util.dbl`).
    for (const [bare, qname] of this.resolution.bareBindings) {
      const d = this.resolution.qualifiedDecls.get(qname);
      if (d) this.registerDecl(bare, d);
    }
    this.enums.set("Basis", ["Threshold", "Conformal", "Principal"]); // built-in gate-basis enum (§20.4)
    this.enums.set("Entailment", ["Entails", "Contradicts", "Neutral"]); // built-in semantic-judgment enum (§9)
    // §5b PROMPT SENSORS: a `prompt T NAME;` DECLARATION opens a standing external input sensor. The sensor
    // opens because the source is declared (not because an agent subscribes), and it opens exactly ONCE per
    // declared prompt, when the program's sensors come online. So `PromptOpened(NAME)` is appended once here,
    // for every declared prompt, independent of how many `when (Prompt … about NAME)` handlers subscribe
    // (zero, one, or many). The harness synthesizes no external `Prompt` arrivals, so the `when (Prompt …)`
    // bodies correctly never fire (an absent event never fires a subscription, §0.2/§7); only the standing
    // sensor's opening is recorded.
    for (const d of this.program.decls) {
      if (d.kind === "prompt") this.ledger.append("PromptOpened", d.name, undefined, undefined);
    }
    const top = new Scope();
    // §16.3: subscriptions are HOISTED per scope — the program top level registers its `when`s (in
    // lexical order) BEFORE its statements run, so a top-level `when (E e)` fires for events appended
    // by any later statement (an agent's emit included). Prospective only: nothing before this fires it.
    for (const s of this.program.stmts) if (s.kind === "when") this.subscriptions.push({ when: s });
    for (const s of this.program.stmts) {
      await this.execStmt(s, top);
      await this.drainTasks(); // §16.3a: queued background task deliveries run between invocations
    }
    // §6c quiescence: every still-open task is terminal by construction — its mandatory lifetime has
    // elapsed with no other terminal, so the Expired tombstone lands (first terminal wins).
    await this.sweepExpiredTasks();
    return this.snapshot();
  }

  async sendPrompt(input: PromptInput): Promise<RunResult> {
    await this.start();
    await this.deliverPrompt(input);
    await this.drainTasks();
    await this.sweepExpiredTasks();
    return this.snapshot();
  }

  snapshot(): RunResult {
    return { ledger: this.ledger, stdout: this.stdout, warnings: this.warnings };
  }

  // §19.2: qualify a bare event/action/struct/agent name against the CURRENT agent's home module — a bare
  // `Glitch` inside module `m` resolves to `m.Glitch` when `m` declares it. A name already dotted, or one
  // declared in the main program / not in the home module, is returned unchanged (resolves as-is).
  private qualifyInModule(name: string, scope: Scope): string {
    if (name.includes(".")) return name;
    const mod = scope.currentAgent()?.module;
    if (!mod) return name;
    const qname = `${mod}.${name}`;
    return this.moduleDeclNames.get(mod)?.has(name) ? qname : name;
  }

  // §19.2: flatten a QUALIFIED callee `util.dbl` / `facade.internal.f` (an ident/member chain over module
  // prefixes) into its dotted name, but ONLY when the head ident is NOT a local binding (a genuine module
  // prefix, not a struct-value field access). Returns undefined for an ordinary value member access.
  private qualifiedCallee(callee: A.Expr, scope: Scope): string | undefined {
    const segs: string[] = [];
    let cur: A.Expr = callee;
    while (cur.kind === "member") { segs.unshift(cur.field); cur = cur.obj; }
    if (cur.kind !== "ident") return undefined;
    if (scope.get(cur.name) !== undefined) return undefined; // the head is a value binding — a field access
    segs.unshift(cur.name);
    return segs.join(".");
  }

  // ---- statements ----
  private async execStmt(s: A.Stmt, scope: Scope): Promise<void> {
    switch (s.kind) {
      case "var": {
        const v = s.init ? await this.evalExpr(s.init, scope, s.type, s.name) : this.zeroOf(s.type);
        scope.set(s.name, v);
        scope.setDeclaredType(s.name, s.type);
        return;
      }
      case "assign": {
        if (s.target.kind !== "ident") throw new RuntimeError("v0 only supports simple identifier assignment targets");
        // §5b: thread the target's declared type as the expected type — so `xs = self <- prompt {…}` requests
        // the same structured schema a `text[] xs = self <- prompt {…}` declaration would, closing the hole
        // where a bare assignment skipped the structured path and returned a scalar into a typed slot. The
        // type binds the reply schema and (via bindName) its title; when no type is recorded, behave as before.
        const expected = scope.declaredType(s.target.name);
        const v = await this.evalExpr(s.value, scope, expected, s.target.name);
        scope.assign(s.target.name, v);
        return;
      }
      case "spawn": return this.execSpawn(s, scope);
      case "retry": {
        // §11: re-attempt the block up to N times; an attempt that appends a FAULT event (an `Error` subtype,
        // e.g. a `TypeMismatch` from a malformed reply) is retried. On exhaustion, emit `RetryExhausted`. The
        // block shares the enclosing scope, so assignments an attempt makes persist (§11).
        for (let attempt = 0; attempt < s.n; attempt++) {
          const before = this.ledger.events.length;
          for (const st of s.body) await this.execStmt(st, scope);
          const faulted = this.ledger.events.slice(before).some((ev) => this.isErrorSubtype(ev.etype));
          if (!faulted) return; // the attempt succeeded
        }
        this.ledger.append("RetryExhausted", this.agentSubject(scope), undefined, scope.currentAgent()?.name);
        return;
      }
      case "awake": return this.execAwake(this.instanceNameOf(s.name, scope));
      case "sleep": {
        const iname = this.instanceNameOf(s.name, scope);
        const inst = this.requireInstance(iname);
        inst.awake = false;
        this.ledger.append("AgentAsleep", iname, undefined, iname);
        await this.runHook(inst, "sleep");
        return;
      }
      case "complete": {
        // §6c: resolve the active assigned task programmatically — the transport Resolved plus a
        // TaskCompleted record carrying the result. Legal only inside a task handler.
        const inst = scope.currentAgent();
        const t = this.activeTaskALS.getStore();
        if (!t || !inst) throw typeError("`complete` is legal only inside a task handler (§6c)");
        const v = await this.evalExpr(s.value, scope);
        if (taskTerminal(t)) {
          // §6c/§15.4.2: after a tombstone (cancel/expiry) the first terminal won — refuse and discard.
          this.ledger.append("CompletionRefused", t.corr, undefined, inst.name);
          throw new TaskDoneSignal();
        }
        t.status = "completed";
        t.result = v;
        this.ledger.append("Resolved", t.corr, { task: true, result: valueSummary(v) }, inst.name);
        this.ledger.append("TaskCompleted", t.corr, { result: valueSummary(v) }, inst.name);
        await this.fireSubscriptions("TaskCompleted", t.corr, new Map([["result", v]]));
        throw new TaskDoneSignal();
      }
      case "fail": {
        // §6c: terminal failure — TaskFailed(reason); the transport chain rests at its Delivered prefix.
        const inst = scope.currentAgent();
        const t = this.activeTaskALS.getStore();
        if (!t || !inst) throw typeError("`fail` is legal only inside a task handler (§6c)");
        const v = await this.evalExpr(s.reason, scope);
        if (v.kind !== "text") throw typeError("`fail` requires a text reason (§6c)");
        if (taskTerminal(t)) {
          this.ledger.append("CompletionRefused", t.corr, undefined, inst.name);
          throw new TaskDoneSignal();
        }
        t.status = "failed";
        this.ledger.append("TaskFailed", t.corr, { reason: v.v }, inst.name);
        await this.fireSubscriptions("TaskFailed", t.corr, new Map([["reason", v]]));
        throw new TaskDoneSignal();
      }
      case "cancel": {
        // §6c cooperative cancel: the authoritative tombstone. Cancel of an already-terminal task
        // appends nothing (first terminal wins). Never preemptive — a running handler is not interrupted;
        // the worker's `on cancelled` hook fires if the task had reached it.
        const hv = await this.evalExpr(s.handle, scope);
        if (hv.kind !== "taskref") throw typeError("`cancel` takes a Task<T> handle (§6c)");
        const t = this.tasks.get(hv.corr);
        if (!t || taskTerminal(t)) return;
        t.status = "cancelled";
        this.ledger.append("TaskCancelled", t.corr, undefined, scope.currentAgent()?.name);
        await this.fireSubscriptions("TaskCancelled", t.corr, new Map());
        if (t.delivered) {
          const worker = this.instances.get(t.dest);
          if (worker) await this.runHook(worker, "cancelled");
        }
        return;
      }
      case "emit": {
        // §6c: TaskProgress is the repeatable worker task event — emittable only inside a task handler,
        // correlated to the ACTIVE task (its subject is the task correlation, not the agent).
        if (s.name === "TaskProgress") {
          const inst = scope.currentAgent();
          const t = this.activeTaskALS.getStore();
          if (!t || !inst) throw typeError("TaskProgress is emittable only inside a task handler — it correlates to the active task (§6c)");
          const note = s.args[0] ? await this.evalExpr(s.args[0], scope) : settledText("");
          this.ledger.append("TaskProgress", t.corr, { note: render(note) }, inst.name);
          await this.fireSubscriptions("TaskProgress", t.corr, new Map([["note", note]]));
          return;
        }
        // §19.2: the etype is the FULLY-QUALIFIED event name — a bare event in a companion agent's body
        // resolves within its home module (`Glitch` inside `m` → `m.Glitch`), and the ledger keys on it,
        // so `a.Tick` and `b.Tick` are distinct rows.
        const etype = this.qualifyInModule(s.name, scope);
        if (!this.events.has(etype) && etype !== "Event" && etype !== "Error") {
          throw typeError(`emit of undeclared event '${etype}'`);
        }
        const args: Value[] = [];
        for (const a of s.args) args.push(await this.evalExpr(a, scope));
        const subj = this.agentSubject(scope);
        this.ledger.append(etype, subj, args.map(render), scope.currentAgent()?.name);
        // §9/§19.5 Error subtyping: an emitted `: Error` event is a leaf under the built-in Error root, so it
        // is ALSO auditable as an `Error`. The runner's `contains: Error` matcher is subtype-blind, so we keep
        // a synthetic `Error` audit row for it; real `when (Error e)` dispatch fires on the leaf itself, below.
        if (this.events.get(etype)?.errorSuper) {
          this.ledger.append("Error", subj, undefined, scope.currentAgent()?.name);
        }
        // §7/§16.3: the append fires any matching `when` subscriptions before the next statement begins.
        await this.fireSubscriptions(etype, subj, this.eventFields(etype, args));
        // §6b: a WIRED emit is the loose observation channel — emitting the event invokes the catalog
        // effector (emit is not a sink, so tainted payloads may flow), and the reply lands as the
        // configured result event whose payload JOINS the emitted payload's trust (no laundering).
        const wiring = this.eventWiring(etype);
        if (wiring) {
          const requestTrust = trustJoin(args);
          const reply = wiring.tool !== undefined
            ? await this.invokeWired(String(wiring.tool), args, scope, typeof wiring.result_event === "string" ? wiring.result_event : undefined)
            : undefined;
          if (typeof wiring.result_event === "string") {
            await this.landResultEvent(wiring.result_event, reply, requestTrust, subj, scope);
          }
        }
        return;
      }
      case "perform": return this.execPerform(s, scope);
      case "say": {
        this.stdout.push(render(await this.evalExpr(s.arg, scope)));
        return;
      }
      case "return": return;
      case "if": {
        const c = await this.evalExpr(s.cond, scope);
        if (c.kind !== "bool") throw typeError("an 'if' condition must be a bool");
        const taken = c.v;
        const branch = taken ? s.then : s.else ?? [];
        const inner = new Scope(scope);
        // Flow narrowing (§13/§15.3.3, W-Decision): inside the TRUE branch of
        // `if (d.committed == V)` for a real variant V, the Decision `d` may be endorsed.
        // Legacy Endorsement values still become sink-admissible when narrowed.
        if (taken) {
          const n = this.committedNarrowingOf(s.cond, scope);
          if (n) inner.set(n.name, this.narrow(n.value, true));
        }
        for (const st of branch) await this.execStmt(st, inner);
        return;
      }
      case "dispatch": return this.execDispatch(s, scope);
      case "when": return;
      case "memdecl": return this.execMemDecl(s, scope);
      case "forget": return this.execForget(s, scope);
      case "depdecl": {
        // §12: thread the group for the fusion compose order, AND record the assertion on the ledger —
        // "Independence is an asserted, unverified claim, recorded on the ledger so an over-confident
        // outcome traces back to the assertion that licensed it." Deterministic (a pure function of the
        // statement), so replay is unaffected.
        scope.addDepGroup(s.relation, s.names);
        this.ledger.append(
          "DependenceAsserted",
          this.agentSubject(scope),
          { relation: s.relation, names: s.names },
          scope.currentAgent()?.name,
        );
        return;
      }
      case "exprstmt": {
        // a bare query STATEMENT lands a `QueryResult(subject)` event (§10); the expression form
        // (bound by a vardecl) lands nothing. So only a top-level query exprstmt records the event.
        const e = s.expr;
        if (e.kind === "select") {
          await this.evalQuery(e, scope, /*asStatement*/ true);
          return;
        }
        await this.evalExpr(s.expr, scope);
        return;
      }
    }
  }

  // memdecl ::= "mem" Ident ("<-" expr)? ";" — declare a private-memory region on this instance (§10).
  private async execMemDecl(s: A.MemDecl, scope: Scope): Promise<void> {
    const agent = scope.currentAgent();
    if (!agent) throw new RuntimeError("`mem` declared outside an agent");
    const region: MemRegion = { writes: [], forgotten: false };
    const memScope = this.memoryScope(agent, s.name);
    await this.memory.declare?.(memScope);
    agent.mems.set(s.name, region);
    scope.set(s.name, { kind: "memref", name: s.name, trust: "settled" });
    if (s.init) {
      const v = await this.evalExpr(s.init, scope);
      region.writes.push(v);
      // E-Store (§15.4.2): the declare-with-init form is a store too — it internalizes and traces.
      const receipt = await this.memory.internalize({
        scope: memScope,
        value: v,
        memory: renderStoreRecollection(s.name, v),
        episode: { act: "store" },
        summary: valueSummary(v),
        metadata: { source: "memdecl", subject: s.name, ...this.memoryProvenance() },
      });
      this.ledger.append("Internalized", s.name, this.memoryInternalizedPayload(s.name, v, receipt), agent.name);
    }
  }

  // forget ::= "forget" Ident ";" — an audit-preserving tombstone; the region becomes unrecallable (§10).
  private async execForget(s: A.ForgetStmt, scope: Scope): Promise<void> {
    const agent = scope.currentAgent();
    const region = agent?.mems.get(s.name);
    if (!region) throw typeError(`'forget ${s.name}': not a mem handle`);
    const receipt = await this.memory.forget({ scope: this.memoryScope(agent!, s.name) });
    const payload = this.memoryForgottenPayload(s.name, region, receipt);
    region.writes = [];
    region.forgotten = true;
    this.ledger.append("Forgotten", s.name, payload, agent?.name);
  }

  private async execSpawn(s: A.SpawnStmt, scope: Scope): Promise<void> {
    // the STATEMENT form: identity IS the declared name (a named singleton/service, addressable by name).
    await this.spawnInstance(s.agentType, s.name, s.args, scope);
  }

  // per call-site sequence for `spawn` EXPRESSIONS outside a fan-out (deterministic in sequential eval).
  private spawnSeq = new Map<string, number>();

  // §6/§15.4 the `spawn` EXPRESSION: `Verifier v = spawn Verifier;` mints a FRESH instance and returns it
  // as an agentref value. The name is derived from (call-site, fan-out path) — NOT execution order — so a
  // dynamic `xs |> f` that spawns inside `f` produces the same names on every replay. `@`/`#` cannot occur
  // in a source identifier, so a generated name never collides with a `spawn Type name` singleton.
  private async evalSpawnExpr(e: A.SpawnExpr, scope: Scope): Promise<Value> {
    const agentType = this.qualifyInModule(e.agentType, scope);
    const site = `${e.pos.line}:${e.pos.col}`;
    const path = scope.getFanoutPath();
    let token: string;
    if (path.length) token = path.join(".");
    else { const n = this.spawnSeq.get(site) ?? 0; this.spawnSeq.set(site, n + 1); token = `s${n}`; }
    const name = `${agentType}@${site}#${token}`;
    await this.spawnInstance(e.agentType, name, e.args, scope);
    return { kind: "agentref", name, agentType, trust: "settled" };
  }

  // §15.4.2 E-Spawn: allocate + construct an instance under `name`, then append Spawned. Shared by the
  // statement form (name = the declared identifier) and the expression form (name = a generated id).
  private async spawnInstance(agentTypeRaw: string, name: string, argExprs: A.Expr[], scope: Scope): Promise<AgentInstance> {
    // §19.2: the spawned type may be QUALIFIED (`spawn m.Worker`) or a bare name resolved within the
    // spawning agent's home module. The instance records that home module so ITS body's bare event/action
    // names resolve within it (`m.Worker`'s `emit Glitch` → `m.Glitch`).
    const agentType = this.qualifyInModule(agentTypeRaw, scope);
    const decl = this.agents.get(agentType);
    if (!decl) throw new RuntimeError(`unknown agent type '${agentType}'`);
    const homeModule = this.agentModuleOf.get(agentType);
    const inst: AgentInstance = { name, agentType, decl, awake: false, fields: new Map(), mems: new Map(), module: homeModule };
    for (const f of decl.fields) inst.fields.set(f.name, this.zeroOf(f.type));
    // E-Spawn (§15.4.2): bind constructor arguments positionally to the agent's declared params, evaluated
    // in the SPAWNING scope (the args are the caller's expressions). These become instance fields visible to
    // the ctor/hooks/handlers; an agent-typed param binding is authority-checked by `reach` at each send (§13).
    for (let i = 0; i < decl.params.length; i++) {
      const p = decl.params[i]!;
      const arg = argExprs[i];
      inst.fields.set(p.name, arg ? await this.evalExpr(arg, scope) : this.zeroOf(p.type));
    }
    this.instances.set(name, inst);
    // the constructor body runs FIRST, then the Spawned event is appended.
    const ctorScope = new Scope(undefined, inst);
    for (const st of this.ctorOf(inst)) await this.execStmt(st, ctorScope);
    this.ledger.append("Spawned", name, { value: valueSummary({ kind: "agentref", name, agentType, trust: "settled" }) }, name);
    return inst;
  }

  // the constructor statements of an instance, with an `extend`ed parent's ctor running first (§5).
  private ctorOf(inst: AgentInstance): A.Stmt[] {
    const ext = inst.decl.extends;
    const parent = ext ? this.agents.get(ext.name) : undefined;
    const inherited = parent ? parent.ctor : [];
    return [...inherited, ...inst.decl.ctor];
  }

  private async execAwake(name: string): Promise<void> {
    const inst = this.requireInstance(name);
    inst.awake = true;
    this.ledger.append("AgentAwake", name, { value: valueSummary({ kind: "agentref", name, agentType: inst.agentType, trust: "settled" }) }, name);
    // §7: awakening ARMS this agent's `when` handlers as subscriptions (lexical order), so a subsequent
    // matching event append fires them. Guard against re-arming on a re-awake.
    if (!this.subscriptions.some((s) => s.inst === inst)) {
      for (const w of inst.decl.whens) this.subscriptions.push({ inst, when: w });
    }
    // §6: any send that EXPIRED before this agent was awake is refused on its (late) awakening — a late
    // delivery attempt records DeliveryRefused (not Delivered), and it is not an Error.
    for (const p of this.pendingExpired) if (p.dest === name) this.ledger.append("DeliveryRefused", p.subj, undefined, name);
    this.pendingExpired = this.pendingExpired.filter((p) => p.dest !== name);
    // §5b: the prompt sensor is opened once at program start (see `run`), because the sensor opens from the
    // DECLARATION, not from an agent's awakening or subscription. Awakening only starts this agent's own
    // `on awake` hook and arms its `when` subscriptions.
    try {
      await this.runHook(inst, "awake");
    } catch (err) {
      if (!(err instanceof CrashError)) throw err;
      // §5: a crash is CONTAINED — record AgentCrashed, run the on-crash hook, and the instance survives.
      this.ledger.append("AgentCrashed", name, undefined, name);
      await this.runHook(inst, "crash");
    }
  }

  private async runHook(inst: AgentInstance, event: A.OnHook["event"]): Promise<void> {
    const hook = inst.decl.hooks.find((h) => h.event === event);
    if (!hook) return;
    const scope = new Scope(undefined, inst);
    // §16.3: a block's `when` subscriptions are HOISTED at scope entry, with the hook scope captured so
    // an `about h` filter can see bindings the hook makes (e.g. a Task<T> handle).
    this.registerBlockWhens(hook.body, scope, inst);
    for (const st of hook.body) await this.execStmt(st, scope);
  }

  // hoist the `when` statements of a handler block (including nested if/when bodies) as subscriptions
  // carrying the block scope. Registered once per when-statement object (a re-awake does not duplicate).
  private registerBlockWhens(stmts: A.Stmt[], scope: Scope, inst?: AgentInstance): void {
    for (const st of stmts) {
      if (st.kind === "when") {
        if (!this.subscriptions.some((s) => s.when === st)) this.subscriptions.push({ inst, when: st, scope });
        this.registerBlockWhens(st.body, scope, inst);
      } else if (st.kind === "if") {
        this.registerBlockWhens(st.then, scope, inst);
        if (st.else) this.registerBlockWhens(st.else, scope, inst);
      }
    }
  }

  // ---- §6c the task runtime (§16.3a) ----

  // deliver every queued background task, in submission order; a delivery may enqueue more.
  private async drainTasks(): Promise<void> {
    if (this.drainingTasks) return;
    this.drainingTasks = true;
    try {
      while (this.pendingDeliveries.length > 0) {
        const t = this.pendingDeliveries.shift()!;
        await this.deliverTask(t);
      }
    } finally {
      this.drainingTasks = false;
    }
  }

  // the quiescence sweep: any still-open task (sent or delivered) expires — its mandatory lifetime is
  // the guaranteed terminal (§6c). First terminal wins: a completed/failed/cancelled task is untouched.
  private async sweepExpiredTasks(): Promise<void> {
    for (const t of this.tasks.values()) {
      if (!taskTerminal(t)) {
        t.status = "expired";
        this.ledger.append("Expired", t.corr, { to: t.dest, task: true }, t.delegator);
        await this.fireSubscriptions("Expired", t.corr, new Map());
      }
    }
  }

  // Deliver one task: append the transport Delivered (≡ TaskAssigned), then run the worker's
  // `on assigned` handler with this task ACTIVE — the programmatic reply (§6c). A handler fault is the
  // WORKER's contained crash; a `complete`/`fail` ends the handler via TaskDoneSignal.
  private async deliverTask(t: TaskState): Promise<void> {
    if (taskTerminal(t)) return; // cancelled (or expired) before delivery — the tombstone won
    const inst = this.instances.get(t.dest);
    if (!inst?.awake) return;    // no mailbox: stays a stalled prefix; the expiry sweep will tombstone it
    t.status = "delivered";
    t.delivered = true;
    this.ledger.append("Delivered", t.corr, { to: t.dest, task: true }, t.delegator);
    await this.fireSubscriptions("Delivered", t.corr, new Map());
    const hook = inst.decl.hooks.find((h) => h.event === "assigned");
    if (!hook) return; // no completing handler is not an error — expiry backstops it (§6c)
    const hscope = new Scope(undefined, inst);
    // run the handler inside this task's async context; nested delegation nests the context, and
    // concurrent deliveries to the same agent each keep their own active task (no clobbering).
    try {
      const runHandler = () => this.activeTaskALS.run(t, async () => {
        this.registerBlockWhens(hook.body, hscope, inst);
        for (const st of hook.body) await this.execStmt(st, hscope);
      });
      // restore the delegating reaction's prompt provenance (captured at the task-send).
      await (t.provenance ? this.promptProvenanceALS.run(t.provenance, runHandler) : runHandler());
    } catch (err) {
      if (err instanceof TaskDoneSignal) {
        // the handler completed/failed the task — normal termination
      } else if (err instanceof CrashError) {
        // §16.6: the fault is contained to the WORKER's invocation; the task stays open (expiry backstops).
        this.ledger.append("AgentCrashed", inst.name, undefined, inst.name);
        await this.runHook(inst, "crash");
      } else {
        throw err;
      }
    }
  }

  private async deliverPrompt(input: PromptInput): Promise<void> {
    const decl = this.prompts.get(input.name);
    if (!decl) throw typeError(`prompt input for undeclared prompt '${input.name}'`);
    const ingress = this.ingressForPrompt(input.name);
    const value = this.valueFromPromptInput(input.value, decl.type, new Scope(), ingress);
    const summary = valueSummary(value);
    const attestation = localAttestation("prompt", { prompt: input.name, input: summary }, input.attestation);
    const fields = new Map<string, Value>([
      ["value", value],
      ["text", { kind: "text", v: render(value), trust: "settled", ingress: ingressOf(value) }],
      ["attester", settledText(String(attestation.attester))],
      ["payload_hash", settledText(String(attestation.payload_hash))],
      ["signature", settledText(String(attestation.signature))],
    ]);
    this.ledger.append("Prompt", input.name, { input: summary, attestation }, undefined);
    // The delivery's whole cascade runs under this provenance, so a memory store anywhere in
    // the reaction records which attested prompt input it traces to (the dogfood contamination
    // fix: a test-harness attester is distinguishable from the real user at recall time).
    const provenance: MemoryProvenance = { attester: String(attestation.attester), prompt_name: input.name };
    await this.promptProvenanceALS.run(provenance, () => this.fireSubscriptions("Prompt", input.name, fields));
  }

  // §7/§16.3: fire every armed subscription that MATCHES an appended event, in registration order. Matching is
  // by subtype (a `when (Error e)` catches any Error leaf, §9), the `about <subj>` filter (the event must be
  // about the held subject), and the `if (guard)` predicate. The bound event evaluates to a struct exposing its
  // payload fields (`p.msg`, `q.body`). A snapshot is taken so a handler that awakes a NEW agent does not fire
  // that agent's fresh subscriptions for the CURRENT event; cascades from the handler's own appends still do.
  private async fireSubscriptions(evEtype: string, evSubject: string, fields: Map<string, Value>): Promise<void> {
    if (this.dispatchDepth > 64) return; // reentrancy backstop (a program that self-emits the event it handles)
    const subs = [...this.subscriptions];
    this.dispatchDepth++;
    try {
      for (const sub of subs) {
        // §6c aliases: `when (TaskSubmitted|TaskAssigned|TaskExpired …)` are rewrites onto the transport
        // chain (Sent/Delivered/Expired), filtered by the task correlation through the `about` clause.
        const subEtype = TASK_ALIASES[sub.when.etype] ?? sub.when.etype;
        if (!this.eventMatches(evEtype, this.qualifyWhenEtype(subEtype, sub.inst))) continue;
        const hscope = new Scope(sub.scope, sub.inst);
        if (sub.when.about) {
          // A hoisted subscription's subject expression may not be resolvable yet (§16.3 hoists a block's
          // `when`s BEFORE its statements run — e.g. `about h` before the handle binds). An unresolvable
          // subject simply cannot match this event; it resolves for later events once bound.
          let aboutName: string | undefined;
          try {
            aboutName = await this.eventAboutName(sub.when.about, hscope);
          } catch {
            continue;
          }
          if (aboutName !== evSubject) continue;
        }
        if (sub.when.binder) hscope.set(sub.when.binder, { kind: "struct", typeName: evEtype, fields, trust: "graded", ingress: ingressJoin([...fields.values()]) });
        if (sub.when.guard) {
          const g = await this.evalExpr(sub.when.guard, hscope);
          if (!(g.kind === "bool" && g.v)) continue;
        }
        for (const st of sub.when.body) await this.execStmt(st, hscope);
      }
    } finally {
      this.dispatchDepth--;
    }
  }

  private async eventAboutName(e: A.Expr, scope: Scope): Promise<string> {
    if (e.kind === "ident" && this.prompts.has(e.name)) return e.name;
    const av = await this.evalExpr(e, scope);
    return av.kind === "agentref" ? av.name : render(av);
  }

  // §9 subtype matching: a subscription's declared event type against an appended event's type.
  private eventMatches(evEtype: string, subEtype: string): boolean {
    if (subEtype === evEtype) return true;
    if (subEtype === "Event") return true; // `Event` is the root of the event hierarchy (§9)
    if (subEtype === "Error") return this.isErrorSubtype(evEtype);
    return false;
  }
  private isErrorSubtype(etype: string): boolean {
    if (["Error", "Contradiction", "TypeMismatch", "RetryExhausted", "FailedPrincipalDecision", "MarginFloorViolation", "TaskScopeViolation", "AgentCrashed"].includes(etype)) return true;
    const bare = etype.includes(".") ? etype.split(".").pop()! : etype;
    return (this.events.get(etype) ?? this.events.get(bare))?.errorSuper === true;
  }
  // qualify a companion agent's bare `when` event type in its home module (`when (Glitch)` in module m → m.Glitch).
  private qualifyWhenEtype(etype: string, inst?: AgentInstance): string {
    if (etype.includes(".") || !inst?.module) return etype;
    return this.moduleDeclNames.get(inst.module)?.has(etype) ? `${inst.module}.${etype}` : etype;
  }
  // the payload struct-fields of an emitted event, keyed by the event decl's field names (§7 binder access).
  private eventFields(etype: string, args: Value[]): Map<string, Value> {
    const decl = this.events.get(etype) ?? this.events.get(etype.includes(".") ? etype.split(".").pop()! : etype);
    const fields = new Map<string, Value>();
    (decl?.fields ?? []).forEach((f, i) => { const a = args[i]; if (a) fields.set(f.name, a); });
    return fields;
  }

  // §13/§16.6 the runtime margin floor, checked at the consequential sink. A committed decision whose rule
  // carried a `floor m` authorizes an Endorsement carrying that `m`; if the endorsed value's margin is below
  // `m` when it reaches a `perform` argument, the action FAULTS: append a typed MarginFloorViolation (a
  // catchable Error, the typed trigger for escalation) and abandon the invocation. The action never runs — the
  // MarginFloorViolation is appended before the action row, so no perform is recorded. Same shape and handling
  // as the task-scope enablement check (§6c). A rule with no floor raises nothing.
  private enforceMarginFloor(v: Value, action: string, agent: AgentInstance | undefined): void {
    if (v.kind !== "endorsement" || v.floor === undefined || v.margin >= v.floor) return;
    const subject = v.binding ?? render(v.subject);
    this.ledger.append(
      "MarginFloorViolation",
      subject,
      { action, margin: v.margin, floor: v.floor },
      agent?.name,
    );
    throw new CrashError();
  }

  private async execPerform(s: A.PerformStmt, scope: Scope): Promise<void> {
    const agent = scope.currentAgent();
    // §19.2: the action name may be QUALIFIED (a cross-module action) or a bare name resolved within the
    // current agent's home module; the ledger keys on the fully-qualified name.
    const name = this.qualifyInModule(s.name, scope);
    if (!this.actions.has(name)) throw typeError(`perform of undeclared action '${name}'`);
    const grants = agent?.decl.grants;
    // §19.2/§19.4: a grant is written with a BARE name in source (`grants { perform Log }`), but the target
    // `name` is qualified in the agent's home module (`m.Log`). Match against BOTH forms so a companion
    // agent can exercise its own finite grants; a bare grant only qualifies to its home module, so it can
    // never satisfy a FOREIGN qualified action — the authority direction is preserved (default-deny).
    const granted = grants === "all" || (Array.isArray(grants) && grants.some((g) => g.cap === "perform" && (g.name === name || this.qualifyInModule(g.name, scope) === name)));
    if (!granted) throw authorityViolation(`agent lacks 'perform ${name}'`);
    // §6c/§13 task-scope enablement (the second runtime sink check, beside the margin floor): a perform
    // executed while this agent runs an ASSIGNED task requires the active task to be ENDORSED and to name
    // this action in its `scope`. The static grant is the upper bound — this check only ever disables.
    const active = this.activeTaskALS.getStore();
    if (active && agent) {
      const bare = name.includes(".") ? name.split(".").pop()! : name;
      if (!active.endorsed || !(active.scope.includes(name) || active.scope.includes(bare))) {
        this.ledger.append("TaskScopeViolation", agent.name, { action: name, task: active.corr }, agent.name);
        throw new CrashError();
      }
    }
    const argValues: Value[] = [];
    const payload: string[] = [];
    for (const a of s.args) {
      const v = await this.evalExpr(a, scope);
      this.enforceMarginFloor(v, name, agent); // §13/§16.6 sink margin floor (before the action row is appended)
      const sunk = this.sinkValue(v, name);
      argValues.push(sunk);
      payload.push(render(sunk));
    }
    this.ledger.append(name, agent?.name ?? "<top>", payload, agent?.name);
    // §6b the world interface: a WIRED action's perform invokes its catalog effector (the replay-journal
    // ToolStarted/ToolResolved pair) and lands the configured result event, if any.
    const wiring = this.actionWiring(name);
    if (wiring) {
      const reply = wiring.tool !== undefined
        ? await this.invokeWired(String(wiring.tool), argValues, scope, typeof wiring.result_event === "string" ? wiring.result_event : undefined)
        : undefined;
      if (typeof wiring.result_event === "string") {
        await this.landResultEvent(wiring.result_event, reply, "settled", agent?.name ?? name, scope);
      }
    }
  }

  // §6b foreground perform binding: `T r = perform A(args) expires N;` — the delegation discipline
  // applied to the world: mandatory expires, settled args (uniform sink rule), the reply lands as the
  // configured result event AND binds inline. Requires a result_event wiring (else ConfigError).
  private async evalPerformExpr(e: A.PerformExpr, scope: Scope): Promise<Value> {
    const agent = scope.currentAgent();
    const name = this.qualifyInModule(e.name, scope);
    if (!this.actions.has(name)) throw typeError(`perform of undeclared action '${name}'`);
    const grants = agent?.decl.grants;
    const granted = grants === "all" || (Array.isArray(grants) && grants.some((g) => g.cap === "perform" && (g.name === name || this.qualifyInModule(g.name, scope) === name)));
    if (!granted) throw authorityViolation(`agent lacks 'perform ${name}'`);
    // §6c task-scope enablement applies to expression performs too.
    const active = this.activeTaskALS.getStore();
    if (active && agent) {
      const bare = name.includes(".") ? name.split(".").pop()! : name;
      if (!active.endorsed || !(active.scope.includes(name) || active.scope.includes(bare))) {
        this.ledger.append("TaskScopeViolation", agent.name, { action: name, task: active.corr }, agent.name);
        throw new CrashError();
      }
    }
    if (e.expires === undefined) throw typeError("a result-bound `perform` requires `expires` (§6b/§6c)");
    const life = await this.evalExpr(e.expires, scope);
    if (life.kind !== "int" && life.kind !== "float") throw typeError("`expires` requires a numeric lifetime (§6)");
    if (life.trust !== "settled") throw taintViolation("`expires` requires a SETTLED numeric expression (§6, §6b)");
    const argValues: Value[] = [];
    const payload: string[] = [];
    for (const a of e.args) {
      const v = await this.evalExpr(a, scope);
      this.enforceMarginFloor(v, name, agent); // §13/§16.6 sink margin floor (before the action row is appended)
      const sunk = this.sinkValue(v, name);
      argValues.push(sunk);
      payload.push(render(sunk));
    }
    const wiring = this.actionWiring(name);
    if (typeof wiring?.result_event !== "string") {
      throw configError(`a result-bound perform of '${name}' requires an [actions.${name}] wiring with a result_event — there is nothing to bind (§6b, §17.1)`);
    }
    this.ledger.append(name, agent?.name ?? "<top>", payload, agent?.name);
    const reply = wiring.tool !== undefined ? await this.invokeWired(String(wiring.tool), argValues, scope, wiring.result_event) : undefined;
    return this.landResultEvent(wiring.result_event, reply, "settled", agent?.name ?? name, scope);
  }

  // §6b wiring lookups — [actions.NAME] / [events.NAME] manifest tables (bare name preferred).
  private actionWiring(name: string) {
    const bare = name.includes(".") ? name.split(".").pop()! : name;
    return this.manifest?.actions?.[name] ?? this.manifest?.actions?.[bare];
  }
  private eventWiring(name: string) {
    const bare = name.includes(".") ? name.split(".").pop()! : name;
    return this.manifest?.events?.[name] ?? this.manifest?.events?.[bare];
  }

  private ingressPolicy(): "warn" | "deny" | "off" {
    const policy = this.manifest?.security?.tainted_ingress_to_provider;
    return policy === "deny" || policy === "off" ? policy : "warn";
  }

  private ingressEntry(kind: "prompts" | "events", name: string): unknown {
    const bare = name.includes(".") ? name.split(".").pop()! : name;
    const group = this.manifest?.security?.ingress?.[kind];
    return group?.[name] ?? group?.[bare];
  }

  private ingressForPrompt(name: string): IngressProvenance {
    return this.ingressEntry("prompts", name) ? "external_screened" : "external_unscreened";
  }

  private ingressForEvent(name: string): IngressProvenance {
    return this.ingressEntry("events", name) ? "external_screened" : "external_unscreened";
  }

  private checkProviderIngress(promptValue: Value, prompt: string, scope: Scope, subject: string): void {
    if (ingressOf(promptValue) !== "external_unscreened") return;
    const policy = this.ingressPolicy();
    if (policy === "off") return;
    const message = `provider prompt '${subject}' renders external unscreened ingress; configure [security.ingress.prompts.NAME] or [security.ingress.events.NAME] screening, or change [security] tainted_ingress_to_provider`;
    if (policy === "deny") throw taintViolation(message);
    this.warnings.push({
      kind: "tainted_ingress_to_provider",
      message,
      prompt,
      ingress: "external_unscreened",
      agent: scope.currentAgent()?.name,
      subject,
    });
  }

  // Invoke a [tools.*] catalog effector (§6b/§16.4): append the correlated ToolStarted/ToolResolved
  // pair — the seam's REPLAY JOURNAL (§16.5), beneath the named domain rows — and return the reply.
  private async invokeWired(catalogKey: string, args: Value[], scope: Scope, resultEvent?: string): Promise<Value> {
    const agent = scope.currentAgent();
    const binding = this.catalogBinding(catalogKey);
    const payload = this.toolPayload(catalogKey, args);
    const startedPayload = { binding: this.bindingSummary(binding), args: args.map(valueSummary), payload };
    const resultIngress = resultEvent ? this.ingressForEvent(resultEvent) : "external_unscreened";
    this.ledger.append("ToolStarted", catalogKey, startedPayload, agent?.name);
    return this.inResolutionOrder(
      this.effectorResult(catalogKey, args, binding, payload).then((resolved) => this.withIngress(resolved, resultIngress)),
      (resolved) => {
        this.ledger.append("ToolResolved", catalogKey, { ...startedPayload, result: valueSummary(resolved) }, agent?.name);
      },
    );
  }

  // Land a configured result event (§6b): the effector's reply becomes the event's typed payload.
  // Judgment trust follows the request payload: the perform path is already settled; an
  // emit-triggered read joins the emitted payload's trust (no laundering). Ingress provenance is
  // tracked separately for prompt/provider screening. Returns the
  // value a foreground binding receives (single-field event → the field; else a struct of the fields).
  private async landResultEvent(eventName: string, reply: Value | undefined, requestTrust: Trust, subj: string, scope: Scope): Promise<Value> {
    const decl = this.events.get(eventName);
    if (!decl) throw configError(`wiring names result_event '${eventName}', which is not a declared event (§6b, §17.1)`);
    const agent = scope.currentAgent();
    const fields = new Map<string, Value>();
    const resultIngress = this.ingressForEvent(eventName);
    decl.fields.forEach((f, i) => {
      let v: Value;
      if (decl.fields.length === 1 && reply && reply.kind === "text" && f.type.kind === "scalar" && f.type.name === "text") {
        v = reply; // a single text field receives the reply verbatim
      } else if (reply && reply.kind === "struct" && reply.fields.has(f.name)) {
        v = reply.fields.get(f.name)!;
      } else {
        v = this.mockFieldValue(f.type, `${eventName}|${f.name}|${i}|${reply ? render(reply) : ""}`);
      }
      fields.set(f.name, this.withIngress(this.withTrust(v, requestTrust === "settled" ? "settled" : requestTrust), resultIngress));
    });
    this.ledger.append(eventName, subj, Object.fromEntries([...fields].map(([k, v]) => [k, valueSummary(v)])), agent?.name);
    await this.fireSubscriptions(eventName, subj, fields);
    if (decl.fields.length === 1) return fields.get(decl.fields[0]!.name)!;
    return { kind: "struct", typeName: eventName, fields, trust: requestTrust, ingress: ingressJoin([...fields.values()]) };
  }

  // a deterministic mock value for a result-event field (a pure function of its seed → replay-stable).
  private mockFieldValue(t: A.TypeRef, seed: string): Value {
    if (t.kind === "scalar") {
      switch (t.name) {
        case "int": return { kind: "int", v: hashInt(seed), trust: "settled" };
        case "float": return { kind: "float", v: hashInt(seed) / 1000, trust: "settled" };
        case "bool": return { kind: "bool", v: hashInt(seed) % 2 === 0, trust: "settled" };
        case "text": return { kind: "text", v: `world:${seed}`, trust: "settled" };
        case "null": return { kind: "null", trust: "settled" };
      }
    }
    return { kind: "text", v: `world:${seed}`, trust: "settled" };
  }

  private async inResolutionOrder<T>(work: Promise<T>, apply: (result: T) => void | Promise<void>): Promise<T> {
    const previous = this.resolutionTail;
    let release!: () => void;
    this.resolutionTail = new Promise<void>((resolve) => { release = resolve; });
    let result: T;
    try {
      result = await work;
    } catch (err) {
      await previous;
      release();
      throw err;
    }
    await previous;
    try {
      await apply(result);
      return result;
    } finally {
      release();
    }
  }

  private sinkValue(v: Value, sink: string): Value {
    if (v.kind === "endorsement") {
      if (!v.committedNarrowed) throw taintViolation(`an abstained/un-narrowed Endorsement cannot reach sink '${sink}'`);
      return v.subject;
    }
    // a bare Decision or Credence is a gate intermediate, not a settled datum: only a
    // committed-narrowed Endorsement may settle a subject into a consequential sink (§13 kernel safety).
    if (v.kind === "decision" || v.kind === "credence") {
      throw taintViolation(`a ${v.kind} cannot reach sink '${sink}' — endorse the subject first`);
    }
    if (v.trust !== "settled") throw taintViolation(`a ${v.trust} value cannot reach sink '${sink}' (gate it through decide/endorse)`);
    return v;
  }

  private async execDispatch(s: A.DispatchStmt, scope: Scope): Promise<void> {
    const { value, committed } = await this.evalGate(s.gate, scope, s.arms);
    if (committed !== "abstained") {
      const arm = s.arms.find((a) => a.head === committed);
      if (!arm) {
        if (s.abstain) return this.runArm(s.abstain.binder, this.narrow(value, false), s.abstain.body, scope);
        throw new RuntimeError(`non-exhaustive dispatch: no arm for committed variant '${committed}'`);
      }
      return this.runArm(arm.binder, this.narrow(value, true), arm.body, scope);
    } else if (s.abstain) {
      return this.runArm(s.abstain.binder, this.narrow(value, false), s.abstain.body, scope);
    }
  }

  private async runArm(binder: string | undefined, bound: Value, body: A.Stmt[], scope: Scope): Promise<void> {
    const inner = new Scope(scope);
    if (binder) inner.set(binder, bound);
    for (const st of body) await this.execStmt(st, inner);
  }

  // §20.1: does an endorse arm reach a REVERSIBLE consequential sink — a `perform` of a `reversible action`,
  // or a call to a `reversible write tool`? A NON-reversible sink does NOT earn the cold-start commit (it must
  // defer, §20.3); an arm with no sink at all earns nothing (the supervised cold start abstains, §13).
  private armReachesReversibleSink(stmts: A.Stmt[]): boolean {
    const exprRev = (e: A.Expr): boolean => {
      switch (e.kind) {
        case "call": return exprRev(e.callee) || e.args.some(exprRev);
        case "member": return exprRev(e.obj);
        case "binary": return exprRev(e.left) || exprRev(e.right);
        case "unary": return exprRev(e.operand);
        default: return false;
      }
    };
    for (const st of stmts) {
      if (st.kind === "perform") {
        const act = this.actions.get(st.name) ?? this.actions.get(st.name.includes(".") ? st.name.split(".").pop()! : st.name);
        if (act?.reversible) return true;
      }
      if (st.kind === "exprstmt" && exprRev(st.expr)) return true;
      if (st.kind === "var" && st.init && exprRev(st.init)) return true;
      if (st.kind === "if" && (this.armReachesReversibleSink(st.then) || (st.else ? this.armReachesReversibleSink(st.else) : false))) return true;
      if (st.kind === "dispatch" && (st.arms.some((a) => this.armReachesReversibleSink(a.body)) || (st.abstain ? this.armReachesReversibleSink(st.abstain.body) : false))) return true;
    }
    return false;
  }

  private narrow(value: Value, committedBranch: boolean): Value {
    if (value.kind === "endorsement") return { ...value, committedNarrowed: committedBranch };
    return value;
  }

  // Narrowing target: if `cond` is `IDENT.committed == VARIANT` with VARIANT a real (non-`abstained`)
  // enum variant or bool literal, return that binding so the TRUE branch can re-bind it narrowed.
  // Decisions become endorsement-admissible; legacy Endorsement bindings remain sink-admissible.
  private committedNarrowingOf(cond: A.Expr, scope: Scope): { name: string; value: Value } | undefined {
    if (cond.kind !== "binary" || cond.op !== "==") return undefined;
    const committedIdent = (e: A.Expr): string | undefined =>
      e.kind === "member" && e.field === "committed" && e.obj.kind === "ident" ? e.obj.name : undefined;
    const leftName = committedIdent(cond.left);
    const name = leftName ?? committedIdent(cond.right);
    if (!name) return undefined;
    const other = leftName ? cond.right : cond.left;
    const variant = other.kind === "ident" ? other.name : other.kind === "bool" ? String(other.value) : undefined;
    if (!variant || variant === "abstained") return undefined;
    const v = scope.get(name);
    if (!v || (v.kind !== "endorsement" && v.kind !== "decision")) return undefined;
    return { name, value: v };
  }

  // ---- the gate ----
  private async evalGate(gate: A.GateExpr, scope: Scope, dispatchArms?: A.DispatchStmt["arms"], bindName?: string): Promise<{ value: Value; committed: Committed }> {
    if (gate.kind === "decide") {
      const cred = await this.evalExpr(gate.credence, scope);
      if (cred.kind !== "credence") throw new RuntimeError("`decide` requires a Credence");
      // DECIDE-BY-PRINCIPAL (§13): the decide is principal-driven when it carries an escalation prefix
      // (`p decide …`) OR its rule is a policy name that is a DECLARED principal (the suite's `decide c by p`
      // form — the parser records `p` as a {policy} rule since it cannot tell principal from policy). The
      // pure `by p` form has NO separate rule to run first, so it routes DIRECTLY to the principal; the
      // prefix form runs the rule first and escalates only when it cannot commit (SPEC prefix semantics).
      const byFormPrincipal = gate.rule.kind === "policy" && this.principals.has(gate.rule.name) ? gate.rule.name : undefined;
      const principalName = gate.principal ?? byFormPrincipal;
      const pureByForm = byFormPrincipal !== undefined && gate.principal === undefined;
      let committed: Committed;
      let margin: number;
      let basis: string;
      let floor: number | undefined;
      let predictionSet: string[] | undefined;
      let principalEvent: number | undefined;
      if (pureByForm) {
        // route directly to the principal; no rule collapse (the "rule" IS the principal name).
        ({ committed, margin, basis, principalEvent } = await this.principalRule(cred, scope, principalName!));
      } else {
        ({ committed, margin, basis, floor, predictionSet } = this.collapse(cred, gate.rule));
        // prefix form: escalate to the principal ONLY when the rule could not commit (§13).
        if (committed === "abstained" && principalName) {
          ({ committed, margin, basis, principalEvent } = await this.principalRule(cred, scope, principalName));
        }
      }
      const decisionSubject = bindName ?? (gate.credence.kind === "ident" ? gate.credence.name : this.agentSubject(scope));
      const decisionId = this.ledger.events.length;
      const decidedPayload: Record<string, unknown> = {
        decision_id: decisionId,
        credence: cred.enumName,
        enum: cred.enumName,
        binding: bindName,
        committed,
        basis,
        margin,
        rule: ruleSummary(gate.rule),
        source: scoreSummary(cred.scores),
        principal_event: principalEvent,
      };
      // the consequential floor and the conformal prediction set are recorded only when the rule produces
      // them, so a plain threshold decision's canonical payload is byte-for-byte unchanged (§16.2).
      if (floor !== undefined) decidedPayload.floor = floor;
      if (predictionSet !== undefined) decidedPayload.prediction_set = predictionSet;
      this.ledger.append("Decided", decisionSubject, decidedPayload, scope.currentAgent()?.name);
      // §8/§11: committing a Credence<Entailment> to Contradicts also appends a first-class Contradiction,
      // subjected at the judged credence, so a downstream `when (Contradiction c)` / `when (Error e)` reacts
      // to the conflict (Contradiction extends Error, §9).
      if (cred.enumName === "Entailment" && committed === "Contradicts") {
        const subj = gate.credence.kind === "ident" ? gate.credence.name : this.agentSubject(scope);
        this.ledger.append("Contradiction", subj, undefined, scope.currentAgent()?.name);
        await this.fireSubscriptions("Contradiction", subj, new Map()); // §7: `when (Error e)` catches it (§9)
      }
      const value: Value = {
        kind: "decision",
        enumName: cred.enumName,
        committed,
        basis,
        margin,
        floor,
        predictionSet,
        decisionId,
        principalEvent,
        rule: ruleSummary(gate.rule),
        trust: "settled",
        binding: bindName,
        source: cred,
        ingress: ingressOf(cred),
      };
      return { value, committed };
    }
    const subject = await this.evalExpr(gate.subject, scope);
    const dec = await this.evalExpr(gate.decision, scope);
    if (dec.kind !== "decision") throw new RuntimeError("`endorse` requires a Decision");
    // RUNTIME BACKSTOP (§14 fail-closed). The static checker is the primary guard for the §13
    // dependency-scope rule, but the kernel guarantee is absolute: an un-endorsed value must never reach a
    // sink through the endorse wrapper. So the runtime independently refuses to settle a subject that still
    // carries un-endorsed cognition (raw/graded) UNLESS the decision was demonstrably ABOUT that subject —
    // the subject IS the exact Credence the decision collapsed, OR it fed that credence's prompt (its
    // dependency scope). A judgment-settled subject (constant, external ingress, a prior
    // Endorsement) always passes; any other raw/graded subject cannot be laundered by a decision about
    // something else, so we fail closed rather than infer authority (mirrors the static §13 scope check).
    if (subject.trust !== "settled" && !this.decisionIsAbout(dec, subject)) {
      throw taintViolation(
        `endorse: the subject carries un-endorsed cognition (${subject.trust}) and is not the judgment this ` +
        `decision settled — a decision about something else cannot settle it for a sink (§13/§14); re-decide it on its own credence`,
      );
    }
    const committed = dec.committed;
    if (committed === "abstained") {
      throw taintViolation("endorse requires a committed Decision; an abstained Decision has no endorsement to give (§13)");
    }
    const subjId = gate.subject.kind === "ident" ? gate.subject.name
      : gate.subject.kind === "string" ? gate.subject.value // a string-literal subject IS its own identifier
      : `#${render(subject).slice(0, 12)}`;
    const endorsementPayload = {
      decision: {
        decision_id: dec.decisionId,
        enum: dec.enumName,
        binding: dec.binding,
        committed: dec.committed,
        basis: dec.basis,
        margin: dec.margin,
        rule: dec.rule,
        source: dec.source?.kind === "credence" ? scoreSummary(dec.source.scores) : undefined,
      },
      endorsement: {
        subject: valueSummary(subject),
        binding: bindName,
        committed,
        branch: `${committed}`,
      },
    };
    this.ledger.append("Endorsed", subjId, endorsementPayload, scope.currentAgent()?.name);
    const value: Value = {
      kind: "endorsement", subject, enumName: dec.enumName, committed,
      basis: dec.basis, margin: dec.margin, floor: dec.floor, committedNarrowed: true, trust: "settled", binding: bindName, decisionId: dec.decisionId,
      ingress: ingressOf(subject),
    };
    return { value, committed };
  }

  // Whether a decision was ABOUT a subject (§13 dependency scope), for the endorse runtime backstop: the
  // subject is the exact Credence the decision collapsed, or it fed that credence's prompt (derivedFrom).
  // When the decision has no recorded source (e.g. a principal-only or fused decision the runtime does not
  // thread), we do NOT fail closed here — the static checker remains the authority — so accept tests that
  // legitimately endorse such subjects are never runtime-false-rejected.
  private decisionIsAbout(dec: Extract<Value, { kind: "decision" }>, subject: Value): boolean {
    const src = dec.source;
    if (!src) return true; // no runtime source recorded → defer to the static scope check; do not reject
    if (src === subject) return true;
    if (src.kind === "credence" && src.derivedFrom?.some((v) => v === subject)) return true;
    return false;
  }

  private collapse(
    cred: Extract<Value, { kind: "credence" }>,
    rule: A.Rule,
  ): { committed: Committed; margin: number; basis: string; floor?: number; predictionSet?: string[] } {
    const { variant, score } = topVariant(cred.scores);
    const runnerUp = secondScore(cred.scores);
    const margin = score - runnerUp;
    if (rule.kind === "confidence") {
      // §13 threshold basis: commit iff score ≥ θ AND margin ≥ δ (both checked at DECISION time). The `floor m`
      // is NOT a decision-time gate — it is threaded to the sink where it faults a committed-but-thin decision
      // (MarginFloorViolation, §16.6). A rule with no floor raises none.
      const passθ = score >= rule.theta;
      const passδ = rule.margin === undefined || margin >= rule.margin;
      return { committed: passθ && passδ ? variant : "abstained", margin, basis: "Threshold", floor: rule.floor };
    }
    if (rule.kind === "conformal") {
      // §15.5.6 conformal basis: with a compatible calibration pool at/above the rule's `readiness`, form the
      // split-conformal prediction set and commit iff it is a singleton. Below readiness (or with no pool) the
      // quantile is uncertified → the supervised cold start abstains/defers (§13).
      const conformal = this.conformalCollapse(cred, rule, margin);
      return { ...conformal, floor: rule.floor };
    }
    if (rule.kind === "policy") {
      // §13 named policy: commit iff the score clears `threshold` AND the margin clears `margin` (both at
      // decision time). The `floor` is threaded to the sink, NOT folded into the decision — a committed
      // decision whose margin is below the floor faults the ACTION at its `perform` (§16.6), it does not
      // abstain here. An undefined directive is unconstrained.
      const pol = this.policies.get(rule.name);
      if (pol) {
        const passθ = pol.threshold === undefined || score >= pol.threshold;
        const passδ = pol.margin === undefined || margin >= pol.margin;
        return { committed: passθ && passδ ? variant : "abstained", margin, basis: "Threshold", floor: pol.floor };
      }
    }
    const passθ = score >= 0.5;
    return { committed: passθ ? variant : "abstained", margin, basis: "Threshold" };
  }

  // §15.5.6 split-conformal prediction over the gate's calibration pool. Nonconformity nc(x, y) = 1 − score(y|x);
  // score each calibration case at its TRUE label, take q̂ as the ⌈(n+1)(1−α)⌉-th smallest nc (clamped to the
  // largest observed nc when that index exceeds n), and form Cα(x) = { v : nc(x, v) ≤ q̂ }. Commit iff |Cα| = 1.
  private conformalCollapse(
    cred: Extract<Value, { kind: "credence" }>,
    rule: Extract<A.Rule, { kind: "conformal" }>,
    margin: number,
  ): { committed: Committed; margin: number; basis: string; predictionSet?: string[] } {
    const alpha = rule.alpha ?? this.fileConformalAlpha ?? 0.05;
    const pool = this.calibrationPool;
    const readiness = rule.readiness ?? 1;
    // cold start: no certified quantile below the readiness minimum of labelled cases.
    if (pool.length === 0 || pool.length < readiness) {
      return { committed: "abstained", margin, basis: "Conformal" };
    }
    const ncScores = pool
      .map((c) => 1 - (c.scores[c.label] ?? 0))
      .sort((a, b) => a - b);
    const n = ncScores.length;
    const rank = Math.ceil((n + 1) * (1 - alpha)); // 1-indexed target rank
    const qHat = rank > n ? ncScores[n - 1]! : ncScores[rank - 1]!;
    const variants = this.enums.get(cred.enumName) ?? Object.keys(cred.scores);
    const predictionSet = variants.filter((v) => 1 - (cred.scores[v] ?? 0) <= qHat + 1e-12);
    const committed: Committed = predictionSet.length === 1 ? (predictionSet[0] as Committed) : "abstained";
    return { committed, margin, basis: "Conformal", predictionSet };
  }

  // Reach the identity dependency (§13): consult the principal `p`. The mock outcome is a PURE function of
  // the harness `principal:` directive, so replay stays deterministic. The identity dependency FAILS CLOSED
  // (§13, lines 1193-1194: "A declined or unavailable principal records `FailedPrincipalDecision` and the
  // decision stays `abstained`"). Only an EXPLICIT `grant` is an approval: the principal rules for the
  // credence's top variant and a `PrincipalDecision { who, credence, decision }` is recorded (basis
  // Principal). Every other case — an explicit `deny`, AND a genuinely unconfigured/unavailable identity
  // dependency (no `principal:` directive, `principalOutcome === undefined`) — records a
  // `FailedPrincipalDecision` and the decision stays `abstained`. An unavailable principal must never
  // fabricate an approval that never happened (a governance/authority soundness requirement). No
  // taint/authority/endorsement bypass: the Decision still settles a subject only through the unchanged
  // endorse machinery.
  private async principalRule(
    cred: Extract<Value, { kind: "credence" }>,
    scope: Scope,
    who: string,
  ): Promise<{ committed: Committed; margin: number; basis: string; principalEvent?: number }> {
    const { variant, score } = topVariant(cred.scores);
    const margin = score - secondScore(cred.scores);
    // apply one attestation (pre-supplied by the harness/UI, or returned live by the consult seam):
    // an explicit decline / an out-of-enum ruling → FailedPrincipalDecision (fail closed); a valid
    // variant ruling → PrincipalDecision (basis Principal). §13: "the human's reply arrives as one
    // of E's variants".
    const apply = (att: PrincipalAttestation) => {
      if (att.approved === false) {
        const attestation = localAttestation("principal-decline", { principal: who, credence: cred.enumName, scores: cred.scores }, att);
        const ev = this.ledger.append("FailedPrincipalDecision", who, { credence: cred.enumName, ...scoreSummary(cred.scores), attestation }, scope.currentAgent()?.name);
        return { committed: "abstained" as Committed, margin, basis: "Principal", principalEvent: ev.tick };
      }
      const decision = att.decision || variant;
      if (!Object.prototype.hasOwnProperty.call(cred.scores, decision)) {
        const attestation = localAttestation("principal-invalid", { principal: who, credence: cred.enumName, decision }, att);
        const ev = this.ledger.append("FailedPrincipalDecision", who, { credence: cred.enumName, decision, ...scoreSummary(cred.scores), attestation }, scope.currentAgent()?.name);
        return { committed: "abstained" as Committed, margin, basis: "Principal", principalEvent: ev.tick };
      }
      const attestation = localAttestation("principal-decision", { principal: who, credence: cred.enumName, decision, scores: cred.scores }, att);
      const ev = this.ledger.append("PrincipalDecision", who, { credence: cred.enumName, decision, ...scoreSummary(cred.scores), attestation }, scope.currentAgent()?.name);
      return { committed: decision as Committed, margin, basis: "Principal", principalEvent: ev.tick };
    };
    const attested = this.principalAttestations.find((a) => a.principal === who);
    if (attested) return apply(attested);
    if (this.principalOutcome === "grant") {
      const ev = this.ledger.append("PrincipalDecision", who, { credence: cred.enumName, decision: variant, ...scoreSummary(cred.scores) }, scope.currentAgent()?.name);
      return { committed: variant, margin, basis: "Principal", principalEvent: ev.tick };
    }
    // §16.4 — the LIVE consult seam: no pre-supplied ruling and no harness directive, but a consult
    // handler is attached (the studio's attestation flow). The run PAUSES here awaiting the principal's
    // ruling: one of E's variants (→ PrincipalDecision) or a decline (→ FailedPrincipalDecision).
    if (this.principalOutcome === undefined && this.onConsult) {
      const supplied = await this.onConsult({
        principal: who,
        enumName: cred.enumName,
        variants: this.enums.get(cred.enumName) ?? Object.keys(cred.scores),
        scores: cred.scores,
        margin,
        agent: scope.currentAgent()?.name,
      });
      if (supplied) return apply({ ...supplied, principal: who });
      const attestation = localAttestation("principal-decline", { principal: who, credence: cred.enumName, scores: cred.scores });
      const ev = this.ledger.append("FailedPrincipalDecision", who, { credence: cred.enumName, ...scoreSummary(cred.scores), attestation }, scope.currentAgent()?.name);
      return { committed: "abstained", margin, basis: "Principal", principalEvent: ev.tick };
    }
    // explicit deny, OR unavailable/unconfigured → fail closed (abstain), never a fabricated approval.
    const ev = this.ledger.append("FailedPrincipalDecision", who, { credence: cred.enumName, ...scoreSummary(cred.scores) }, scope.currentAgent()?.name);
    return { committed: "abstained", margin, basis: "Principal", principalEvent: ev.tick };
  }

  private resolveMarkdownImport(importPath: string): string {
    if (!importPath || importPath.includes("\0") || importPath.includes("\\") || isAbsolute(importPath) || /^[A-Za-z]:/.test(importPath)) {
      throw new RuntimeError("markdown import must be a project-relative .md path: " + JSON.stringify(importPath));
    }
    if (!/\.(?:md|markdown)$/i.test(importPath)) {
      throw new RuntimeError("markdown import must end in .md or .markdown: " + JSON.stringify(importPath));
    }
    const parts = importPath.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
      throw new RuntimeError("markdown import must not contain empty, current, or parent path segments: " + JSON.stringify(importPath));
    }
    const root = resolvePath(this.projectRoot);
    const full = resolvePath(root, importPath);
    const rel = relative(root, full);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new RuntimeError("markdown import escapes the project root: " + JSON.stringify(importPath));
    }
    return full;
  }

  // ---- expressions ----
  private async evalExpr(e: A.Expr, scope: Scope, expected?: A.TypeRef, bindName?: string): Promise<Value> {
    switch (e.kind) {
      case "int": return { kind: "int", v: e.value, trust: "settled" };
      case "float": return { kind: "float", v: e.value, trust: "settled" };
      case "string": return settledText(e.value);
      case "mdimport": {
        try {
          return { kind: "text", v: await readFile(this.resolveMarkdownImport(e.path), "utf8"), trust: "raw", ingress: "external_unscreened" };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new RuntimeError("failed to import project markdown " + JSON.stringify(e.path) + ": " + message);
        }
      }
      case "bool": return { kind: "bool", v: e.value, trust: "settled" };
      case "null": return { kind: "null", trust: "settled" };
      case "fstring": {
        // an f-string joins the trust of its interpolated operands (contagious-upward, §15.3.1):
        // `f"{raw}"` is raw, not settled — interpolation must NOT launder cognition-provenance.
        let out = "";
        const parts: Value[] = [];
        for (const p of e.parts) {
          if (p.kind === "text") { out += p.text; }
          else { const v = await this.evalExpr(p.expr, scope); out += render(v); parts.push(v); }
        }
        return { kind: "text", v: out, trust: trustJoin(parts), ingress: ingressJoin(parts) };
      }
      case "self": {
        const a = scope.currentAgent();
        if (!a) throw new RuntimeError("`self` outside an agent");
        return { kind: "agentref", name: a.name, agentType: a.agentType, trust: "settled" };
      }
      case "ident": {
        if (e.name === "abstained") return { kind: "enumval", enumName: "", variant: "abstained", trust: "settled" };
        const v = scope.get(e.name);
        if (v) return v;
        const enumName = this.enumOfVariant(e.name, expected);
        if (enumName) return { kind: "enumval", enumName, variant: e.name, trust: "settled" };
        // a spawned agent instance is referenceable by name as an agentref (§15.4): it can be bound to a
        // variable (including an interface-typed slot — the interface erases, §19.5) and used as a `<-` dest.
        const inst = this.instances.get(e.name);
        if (inst) return { kind: "agentref", name: inst.name, agentType: inst.agentType, trust: "settled" };
        throw new RuntimeError(`unknown identifier '${e.name}'`);
      }
      case "send": return this.evalSend(e, scope, expected, bindName);
      case "recall": return this.evalRecall(e, scope, expected);
      case "select": return this.evalQuery(e, scope, /*asStatement*/ false);
      case "structlit": {
        // a struct literal is a record value (§3); its trust joins its field values' trust. Field
        // arity/names against the declared struct are checked statically (check.ts); here we only build
        // the value and preserve per-field values so member access (`m.field`) reads them back (§3).
        const fields = new Map<string, Value>();
        const parts: Value[] = [];
        for (const f of e.fields) {
          const v = await this.evalExpr(f.value, scope);
          fields.set(f.name, v);
          parts.push(v);
        }
        return { kind: "struct", typeName: e.typeName, fields, trust: trustJoin(parts), ingress: ingressJoin(parts) };
      }
      case "decide": case "endorse": return (await this.evalGate(e, scope, undefined, bindName)).value;
      case "member": return this.evalMember(e, scope);
      case "index": {
        // `a[i]` element access (§10): the element inherits the array's trust (a match/query hit is graded).
        const arr = await this.evalExpr(e.obj, scope);
        const idx = await this.evalExpr(e.index, scope);
        const trust = arr.trust ?? "raw";
        if (arr.kind === "array") {
          const el = arr.items[idx.kind === "int" ? idx.v : 0];
          if (el) return { ...el, trust: el.trust ?? trust } as Value;
        }
        return { kind: "null", trust, ingress: ingressOf(arr) };
      }
      case "binary": return this.evalBinary(e, scope);
      case "unary": {
        const o = await this.evalExpr(e.operand, scope);
        if (e.op === "!" && o.kind === "bool") return { kind: "bool", v: !o.v, trust: o.trust, ingress: ingressOf(o) };
        if (e.op === "-" && (o.kind === "int" || o.kind === "float")) return { ...o, v: -o.v };
        throw new RuntimeError(`bad unary ${e.op}`);
      }
      case "call": {
        // a call to a user-declared function `f(a, …)` (§15.2). Generic functions are monomorphized and
        // their type arguments erased before this point (§19.5), so the concrete argument values suffice.
        if (e.callee.kind === "ident" && this.fns.has(e.callee.name)) {
          const argv: Value[] = [];
          for (const a of e.args) argv.push(await this.evalExpr(a, scope));
          return this.callFn(e.callee, argv, scope);
        }
        // §19.2: a QUALIFIED function call `util.dbl(21)` / `u.dbl(21)` — the callee is a `member` whose obj
        // names an imported whole/alias module prefix and whose field is a pub fn. Resolve the qualified name
        // and dispatch to the companion fn (visibility was already checked statically, so this never leaks).
        const qcall = this.qualifiedCallee(e.callee, scope);
        if (qcall && this.fns.has(qcall)) {
          const argv: Value[] = [];
          for (const a of e.args) argv.push(await this.evalExpr(a, scope));
          return this.callFn({ kind: "ident", name: qcall, pos: e.callee.pos }, argv, scope);
        }
        // §4 kernel builtins — the only self-declaring calls, resolved after user functions so a
        // declared fn of the same name wins. `now()` reads the kernel's own clock: settled (a
        // world-fact from the trusted kernel, not cognition), banned inside `pure` (a clock read
        // is a world reach). `take(xs, n)` keeps the first n elements; with array `+` concat it is
        // the rolling-window primitive, so bounded program state needs no numbered bindings.
        if (e.callee.kind === "ident" && e.callee.name === "now") {
          if (e.args.length !== 0) throw typeError("now() takes no arguments");
          return settledText(clockText());
        }
        if (e.callee.kind === "ident" && (e.callee.name === "take" || e.callee.name === "skip")) {
          if (e.args.length !== 2) throw typeError(`${e.callee.name}(xs, n) takes an array and a count`);
          const xs = await this.evalExpr(e.args[0]!, scope);
          const n = await this.evalExpr(e.args[1]!, scope);
          if (xs.kind !== "array") throw typeError(`${e.callee.name}: the first argument must be an array`);
          if (n.kind !== "int" && n.kind !== "float") throw typeError(`${e.callee.name}: the count must be a number`);
          const c = Math.max(0, Math.floor(Number(n.v)));
          const items = e.callee.name === "take" ? xs.items.slice(0, c) : xs.items.slice(c);
          return { kind: "array", items, trust: trustJoin(items), ingress: ingressJoin(items) };
        }
        if (e.callee.kind === "ident" && e.callee.name === "len") {
          if (e.args.length !== 1) throw typeError("len(xs) takes one array");
          const xs = await this.evalExpr(e.args[0]!, scope);
          if (xs.kind !== "array") throw typeError("len: the argument must be an array");
          // the count is the kernel's own tally of the collection, not cognition — settled.
          return { kind: "int", v: xs.items.length, trust: "settled", ingress: ingressJoin(xs.items) };
        }
        throw new RuntimeError("v0 does not support general calls yet");
      }
      case "arraylit": {
        const items: Value[] = [];
        for (const it of e.items) items.push(await this.evalExpr(it, scope));
        return { kind: "array", items, trust: trustJoin(items), ingress: ingressJoin(items) };
      }
      case "pipe": return this.evalPipe(e, scope);
      case "spawnexpr": return this.evalSpawnExpr(e, scope);
      case "agg": return this.evalAgg(e, scope);
      case "quorum": return this.evalQuorum(e, scope);
      case "performexpr": return this.evalPerformExpr(e, scope);
      case "tasklit": {
        // §6c the task literal: builds a TaskSpec. objective/acceptance REQUIRED text; trust is the join
        // of the fields (delegation never launders trust); a `scope` clause can only ATTENUATE the
        // delegator's own authority.
        if (!e.objective || !e.acceptance) throw typeError("a task literal requires BOTH `objective` and `acceptance` (§6c)");
        const obj = await this.evalExpr(e.objective, scope);
        if (obj.kind !== "text") throw typeError("task `objective` must be text (§6c)");
        const acc = await this.evalExpr(e.acceptance, scope);
        if (acc.kind !== "text") throw typeError("task `acceptance` must be text (§6c)");
        if (e.scope.length > 0) {
          const agent = scope.currentAgent();
          const grants = agent?.decl.grants;
          for (const a of e.scope) {
            const held = grants === "all" || (Array.isArray(grants) && grants.some((g) => g.cap === "perform" && g.name === a));
            if (!held) {
              throw authorityViolation(`task scope names 'perform ${a}', which the delegator does not hold — a task can only ATTENUATE its delegator's authority, never mint new authority (§6c, §13)`);
            }
          }
        }
        const fields = new Map<string, Value>([["objective", obj], ["acceptance", acc]]);
        return { kind: "struct", typeName: "TaskSpec", fields, trust: trustJoin([obj, acc]), ingress: ingressJoin([obj, acc]), taskScope: e.scope.length ? [...e.scope] : undefined };
      }
    }
  }

  // `coll |> fn` (§12): map `fn` over each element of the collection. When `fn` is async, the fan-out is
  // concurrent (await-all, no short-circuit); the mock fns here are pure/local so the order is stable.
  private async evalPipe(e: A.PipeExpr, scope: Scope): Promise<Value> {
    const src = await this.evalExpr(e.source, scope);
    if (src.kind !== "array") throw new RuntimeError("`|>` requires a collection on the left");
    if (e.fn.kind !== "ident") throw new RuntimeError("`|>` requires a named function on the right");
    // pass each element's INDEX so a `spawn` inside the mapped fn gets a deterministic per-path name.
    const results = await Promise.all(src.items.map((el, i) => this.callFn(e.fn as A.IdentExpr, [el], scope, i)));
    return { kind: "array", items: results, trust: trustJoin(results), ingress: ingressJoin(results) };
  }

  // Call a user-declared function by name, binding the argument values positionally to its parameters,
  // executing its body, and returning the `return`ed value. Used by `|>` (one element bound to the first
  // parameter, §12) and by a direct call `f(a, …)` (§15.2). Generics are monomorphized/erased before this
  // point (§19.5), so no type-parameter environment is needed — the body runs on the concrete values.
  private async callFn(fnRef: A.IdentExpr, args: Value[], scope: Scope, pathIndex?: number): Promise<Value> {
    const fn = this.fns.get(fnRef.name);
    if (!fn) throw new RuntimeError(`unknown function '${fnRef.name}'`);
    // Functions are not closures over caller locals, but when an agent calls a function the function
    // executes in that agent context. This lets async `coll |> fn` fan-out preserve `self`, grants,
    // and private agent fields for each mapped path.
    const local = new Scope(undefined, scope.currentAgent());
    // extend the caller's fan-out path with this element's index (nested `|>` compose), so a `spawn`
    // expression in the body names its instance by position, not by execution timing (§12/§15.4).
    const base = scope.getFanoutPath();
    if (pathIndex !== undefined) local.fanoutPath = [...base, pathIndex];
    else if (base.length) local.fanoutPath = base;
    fn.params.forEach((p, i) => { if (i < args.length) local.set(p.name, args[i]!); });
    let ret: Value = { kind: "null", trust: "settled" };
    for (const st of fn.body) {
      if (st.kind === "return") { ret = st.value ? await this.evalExpr(st.value, local) : ret; break; }
      await this.execStmt(st, local);
    }
    return ret;
  }

  // `all`/`any` over evaluated operands (§12). Over plain bool → ordinary conjunction/disjunction. Over
  // Credence<bool> → FUSE into a single Credence<bool> under the declared dependence structure, so a later
  // `decide`/`endorse` gates it once (P → P; only the gate crosses P → U).
  private async evalAgg(e: A.AggExpr, scope: Scope): Promise<Value> {
    // evaluate each operand, then FLATTEN any array-valued operand into its elements so the single-array
    // form `all(arr)` (§15.2: "a comma list, OR a single array<Credence<bool>>") fuses the array's actual
    // credences rather than mis-reading the whole `array` value as a non-credence (which fused nothing and
    // returned a degenerate p=0). Each flattened value carries the source operand (an array element has no
    // source ident, so it fuses as an independent unit — it cannot be named in a dependence declaration).
    const flat: { val: Value; operand: A.Expr; coverName?: string }[] = [];
    for (const o of e.operands) {
      const v = await this.evalExpr(o, scope);
      // an array-valued operand (an inline literal OR an array<Credence>-typed variable/query) flattens to
      // its elements. The COVERABLE name of each element is the source array VARIABLE's identifier when the
      // operand is a bare ident (`independent arr;` names it), or an element ident for an inline literal;
      // otherwise it is anonymous (no declaration can name it — §12).
      if (v.kind === "array") {
        const litItems = o.kind === "arraylit" ? o.items : undefined;
        v.items.forEach((it, i) => {
          const elemName = litItems && litItems[i]?.kind === "ident"
            ? (litItems[i] as A.IdentExpr).name
            : o.kind === "ident" ? o.name : undefined;
          flat.push({ val: it, operand: o, coverName: elemName });
        });
      } else {
        flat.push({ val: v, operand: o, coverName: o.kind === "ident" ? o.name : undefined });
      }
    }
    const vals = flat.map((f) => f.val);
    if (vals.length > 0 && vals.every((v) => v.kind === "bool")) {
      const fold = e.op === "all"
        ? vals.every((v) => (v as any).v)
        : vals.some((v) => (v as any).v);
      return { kind: "bool", v: fold, trust: trustJoin(vals), ingress: ingressJoin(vals) };
    }
    // the operand list aligned 1:1 with the fused credences (an array element's operand is the array expr,
    // which is not an ident, so it contributes no dependence name — i.e. an independent unit).
    const creds: Extract<Value, { kind: "credence" }>[] = [];
    const coverNames: (string | undefined)[] = [];
    for (const f of flat) {
      if (f.val.kind === "credence") { creds.push(f.val); coverNames.push(f.coverName); }
    }
    // RUNTIME §12 backstop: fusing two-or-more Credences requires total dependence coverage. The checker is
    // conservative for a fuse over an array-typed variable/query (length unknown statically), so the runtime
    // — which knows the ACTUAL fused set — enforces coverage here. A length-0/1 fuse never triggers it, so
    // no false-reject of a genuine short array (§15.3).
    this.checkFusionCoverageRuntime(coverNames, scope);
    const p = this.fuseCredences(creds, coverNames, e.op, scope);
    return this.credenceOfP(p, creds);
  }

  // `quorum(k, [c1..cn])` (§12): fuse `n` Credence<bool> judgments into a single Credence<bool> for
  // "at least k of n commit," combined under the declared dependence structure. The exact number is not
  // asserted by any test; the formula is spec-faithful (exact Poisson-binomial tail over independent
  // judges; a dependent cluster collapses to its Fréchet-bounded single p first) and deterministic.
  private async evalQuorum(e: A.QuorumExpr, scope: Scope): Promise<Value> {
    const arr = await this.evalExpr(e.source, scope);
    const creds = arr.kind === "array"
      ? arr.items.filter((v): v is Extract<Value, { kind: "credence" }> => v.kind === "credence")
      : [];
    const elems = e.source.kind === "arraylit" ? e.source.items : [];
    // RUNTIME §12 backstop (as evalAgg): every fused pair must be dependence-covered. The coverable name of
    // each element is its element ident for an inline literal, or the source array VARIABLE's ident when the
    // source is a bare ident (`independent arr;`); else anonymous. Enforced over the ACTUAL fused set so an
    // uncovered `quorum(k, arr)` over a 2+-element array variable is a TypeError, matching §12/T-Fuse.
    const litItems = e.source.kind === "arraylit" ? e.source.items : undefined;
    const coverNames = creds.map((_c, i) =>
      litItems && litItems[i]?.kind === "ident" ? (litItems[i] as A.IdentExpr).name
      : e.source.kind === "ident" ? e.source.name : undefined,
    );
    this.checkFusionCoverageRuntime(coverNames, scope);
    // per-cluster fold to per-judge p(true): a dependent cluster collapses to one p (min for "commit"),
    // independent judges stay as separate p_i for the Poisson-binomial tail.
    const ps = this.clusterProbs(creds, coverNames, "all", scope); // "commit" = p(true) per independent unit
    const p = poissonBinomialTail(ps, e.k);
    return this.credenceOfP(p, creds);
  }

  // Fuse a set of Credence<bool> under the in-scope dependence declarations (§12). `all`/conjunction and
  // `any`/disjunction differ only in the Fréchet bound (min vs max) and the identity of the log-odds sum.
  private fuseCredences(
    creds: Extract<Value, { kind: "credence" }>[],
    names: (string | undefined)[],
    op: "all" | "any",
    scope: Scope,
  ): number {
    const units = this.clusterProbs(creds, names, op, scope);
    // combine the per-cluster/independent units by the independent rule: log-odds addition.
    return logOddsCombine(units);
  }

  // Resolve the fused set to a list of per-UNIT probabilities: each `dependent` cluster is fused
  // conservatively first (Fréchet bound: min for all/conjunction, max for any/disjunction), and each
  // remaining (independent) credence contributes its own p(true). Names not declared dependent-together
  // are treated as independent units (the checker has already required total pair coverage).
  private clusterProbs(
    creds: Extract<Value, { kind: "credence" }>[],
    names: (string | undefined)[],
    op: "all" | "any",
    scope: Scope,
  ): number[] {
    const pOf = (c: Extract<Value, { kind: "credence" }>) => c.scores["true"] ?? 0;
    // pair each credence with its coverage/dependence name — the SAME name the coverage check uses (the
    // element ident for an array literal, the source array-variable ident for an array-variable fuse, else
    // anonymous). Using the coverName here (not the raw operand AST) is what lets a `dependent` cluster form
    // for `all([c1,c2])` and `quorum(k, arr)`, not only the comma-list form (closes the over-confidence gap).
    const list: { name?: string; p: number }[] = names.length === creds.length
      ? creds.map((c, i) => ({ name: names[i], p: pOf(c) }))
      : creds.map((c) => ({ name: undefined, p: pOf(c) }));
    // only `dependent` groups form a conservative-Fréchet cluster; `independent` groups keep units apart.
    const depGroups = scope.allDepGroups().filter((g) => g.relation === "dependent").map((g) => g.names);
    // union-find over dependent-declared names to form clusters.
    const clusters = clusterByDependence(list, depGroups);
    const bound = op === "all" ? Math.min : Math.max;
    return clusters.map((cl) => (cl.length === 1 ? cl[0]! : bound(...cl)));
  }

  // T-Fuse coverage (§12/§15.2), enforced at RUNTIME over the ACTUALLY-fused Credence set. The static
  // checker (check.ts checkFusionCoverage) covers the statically-enumerable forms (comma lists, array
  // literals) but must stay conservative for a fuse over an array-typed VARIABLE/query whose length it
  // cannot prove — so this is the backstop for those. Fusing two-or-more Credences requires every unordered
  // pair to be covered by SOME in-scope independent/dependent declaration; a pair is UNCOVERED when either
  // unit is anonymous (no declaration can name it: an array-element with no source ident, a nested fuse,
  // a raw send) or no in-scope group contains both names. A fuse of 0 or 1 credence never triggers it, so a
  // genuine short array is never false-rejected. Same total-coverage rule as the static check — deferring
  // the array-variable case to here, not weakening it (§12: "coverage must be total").
  private checkFusionCoverageRuntime(coverNames: (string | undefined)[], scope: Scope): void {
    if (coverNames.length < 2) return; // n<2: no fusion of distinct Credences; nothing to cover.
    const groups = scope.allDepGroups().map((g) => g.names);
    const covered = (a?: string, b?: string): boolean =>
      a !== undefined && b !== undefined && groups.some((g) => g.includes(a) && g.includes(b));
    for (let i = 0; i < coverNames.length; i++) {
      for (let j = i + 1; j < coverNames.length; j++) {
        const a = coverNames[i], b = coverNames[j];
        if (!covered(a, b)) {
          const label = (n?: string) => n ?? "an unnameable fused credence (an array element / send / nested fuse)";
          throw typeError(
            `fusion of Credence values requires a total dependence declaration (§12): the pair ` +
            `(${label(a)}, ${label(b)}) is neither independent- nor dependent-declared — ` +
            `declare every fused pair by name before fusing`,
          );
        }
      }
    }
  }

  // build a Credence<bool> value over { true: p, false: 1-p } that a later decide/endorse consumes; its
  // dependency scope (derivedFrom) is the operand credences so §13 scope is preserved through the fuse.
  private credenceOfP(p: number, creds: Extract<Value, { kind: "credence" }>[]): Value {
    const clamped = Math.max(0, Math.min(1, p));
    return {
      kind: "credence",
      enumName: creds[0]?.enumName ?? "bool",
      scores: { true: clamped, false: 1 - clamped },
      trust: "graded",
      derivedFrom: creds,
      ingress: ingressJoin(creds),
    };
  }

  private catalogBinding(key: string): ToolBindingConfig {
    return this.manifest?.tools?.[key] ?? { driver: "mock" };
  }

  private bindingSummary(binding: ToolBindingConfig): Record<string, unknown> {
    const secretish = /(api[_-]?key|token|secret|password|credential|auth)/i;
    return Object.fromEntries(Object.entries(binding)
      .filter(([k]) => !secretish.test(k))
      .sort(([a], [b]) => a.localeCompare(b)));
  }

  // Effector invocation is an adapter boundary (§6b/§16.4). `mock` is built in for demos/replay-stable
  // tests (a deterministic pure function of the payload); every other driver is supplied by the embedding
  // runtime via `toolHandlers`, keyed by the [tools.*] catalog key — MCP is one supported transport, not
  // a semantic requirement of the language.
  private async effectorResult(catalogKey: string, args: Value[], binding: ToolBindingConfig, payload: string): Promise<Value> {
    const driver = binding.driver ?? "mock";
    if (driver === "mock") return { kind: "text", v: `tool:${catalogKey}(${payload})`, trust: "settled" };
    const handler = this.toolHandlers[catalogKey];
    if (!handler) {
      throw configError(`catalog entry [tools.${catalogKey}] is configured with driver '${driver}', but this runtime has no adapter registered for it (§17.1)`);
    }
    const raw = await handler({ name: catalogKey, binding, args, payload });
    if (isRuntimeValue(raw)) return raw;
    return this.jsonValue(raw, "Reply");
  }

  // the deterministic correlation payload: a pure function of (name, rendered args), so two runs of the
  // same program produce identical ToolResolved payloads and therefore an identical hash-chain head.
  private toolPayload(name: string, args: Value[]): string {
    return `${name}|${args.map(render).join("|")}`;
  }

  // The in-scope values that feed a prompt expression (the identifiers it references — e.g. `draft` in
  // `f"is this faithful: {draft}"`, or `m` in `f"approve {m}?"`). These are the credence's dependency
  // scope (§13): endorsing any of them by a decision over that credence is ABOUT the subject.
  private promptSources(e: A.Expr, scope: Scope): Value[] {
    const out: Value[] = [];
    const walk = (x: A.Expr): void => {
      switch (x.kind) {
        case "ident": { const v = scope.get(x.name); if (v) out.push(v); return; }
        case "member": walk(x.obj); return;
        case "binary": walk(x.left); walk(x.right); return;
        case "unary": walk(x.operand); return;
        case "fstring": for (const p of x.parts) if (p.kind === "expr") walk(p.expr); return;
        case "call": for (const a of x.args) walk(a); return;
        default: return;
      }
    };
    walk(e);
    return out;
  }

  private blobRef(parts: Record<string, unknown>): string {
    return `blob:sha256:${sha256(parts)}`;
  }

  private memoryScope(agent: AgentInstance, mem: string): MemoryScope {
    const project = this.manifest?.project?.name;
    return {
      agent: agent.name,
      mem,
      project: typeof project === "string" ? project : undefined,
    };
  }

  // Provenance metadata for a memory write inside the current reaction. Additive only: existing
  // metadata keys are untouched, and a reaction with no originating prompt delivery omits the
  // key entirely rather than inventing an attester.
  private memoryProvenance(): { provenance: MemoryProvenance } | Record<string, never> {
    const p = this.promptProvenanceALS.getStore();
    return p ? { provenance: p } : {};
  }

  private memoryDriverRefs(receipt?: MemoryReceipt): Record<string, unknown> {
    if (!receipt) return {};
    return {
      ...(receipt.eventId ? { driver_event: receipt.eventId } : {}),
      ...(receipt.ids?.length ? { driver_ids: receipt.ids } : {}),
    };
  }

  private memoryInternalizedPayload(mem: string, value: Value, receipt?: MemoryReceipt): Record<string, unknown> {
    const summary = valueSummary(value);
    const refs = {
      input: this.blobRef({ mem, view: "input", value: summary }),
      facts_delta: this.blobRef({ mem, view: "facts_delta", value: summary }),
      graph_delta: this.blobRef({ mem, view: "graph_delta", value: summary }),
      vector_delta: this.blobRef({ mem, view: "vector_delta", value: summary }),
      ...this.memoryDriverRefs(receipt),
      ...(receipt?.refs ?? {}),
    };
    const policy = {
      indexing: "incremental",
      background_reindex: "runtime-managed",
      graph_forget: "cascade",
      archive: "runtime-configured",
      ...(receipt?.policy ?? {}),
    };
    return {
      // The runtime owns memory-text policy: prefer what it actually stored
      // (reflected prose when [memory] reflect is on); fall back to the
      // deterministic template for drivers that don't report it.
      memory: receipt?.memory ?? renderStoreRecollection(mem, value),
      value: summary,
      effects: receipt?.effects ?? {
        facts: { upserted: 1, tombstoned: 0, deleted: 0 },
        graph: {
          nodes_upserted: 1,
          edges_upserted: 0,
          nodes_tombstoned: 0,
          edges_tombstoned: 0,
          nodes_deleted: 0,
          edges_deleted: 0,
        },
        vectors: { chunks_upserted: 1, chunks_deleted: 0, embeddings_deleted: 0 },
        blobs: { archived: 1, redacted: 0, deleted: 0 },
      },
      refs,
      policy,
      ...(receipt?.status ? { driver_status: receipt.status } : {}),
    };
  }

  private receivedReplyInternalizedPayload(prompt: string, value: Value, sourceEvent: number, receipt?: MemoryReceipt): Record<string, unknown> {
    return {
      memory: receipt?.memory ?? renderReplyRecollection(prompt, value),
      prompt,
      reply: valueSummary(value),
      source_event: sourceEvent,
      derived_from: ["prompt", "provider reply"],
      trust: value.trust,
      ...(receipt ? { refs: this.memoryDriverRefs(receipt) } : {}),
      ...(receipt?.status ? { driver_status: receipt.status } : {}),
    };
  }

  private async internalizeReceivedReply(subj: string, prompt: string, value: Value, sourceEvent: number, agent?: AgentInstance): Promise<void> {
    let receipt: MemoryReceipt | undefined;
    if (agent) {
      receipt = await this.memory.internalize({
        scope: this.memoryScope(agent, "__agent__"),
        value,
        memory: renderReplyRecollection(prompt, value),
        episode: { act: "provider_reply", prompt: compactMemoryText(prompt) },
        summary: valueSummary(value),
        metadata: { source: "provider_reply", subject: subj, source_event: sourceEvent, ...this.memoryProvenance() },
      });
    }
    this.ledger.append("Internalized", subj, this.receivedReplyInternalizedPayload(prompt, value, sourceEvent, receipt), agent?.name);
  }

  private memoryForgottenPayload(mem: string, region: MemRegion, receipt?: MemoryReceipt): Record<string, unknown> {
    const n = region.writes.length;
    return {
      mode: "cascade",
      effects: receipt?.effects ?? {
        facts: { upserted: 0, tombstoned: n, deleted: 0 },
        graph: {
          nodes_upserted: 0,
          edges_upserted: 0,
          nodes_tombstoned: n,
          edges_tombstoned: 0,
          nodes_deleted: 0,
          edges_deleted: 0,
        },
        vectors: { chunks_upserted: 0, chunks_deleted: n, embeddings_deleted: n },
        blobs: { archived: n, redacted: 0, deleted: 0 },
      },
      refs: {
        forget_delta: this.blobRef({ mem, op: "forget", count: n }),
        ...this.memoryDriverRefs(receipt),
        ...(receipt?.refs ?? {}),
      },
      policy: {
        graph_forget: "cascade",
        redaction: "separate-operation",
        archive: "runtime-configured",
        ...(receipt?.policy ?? {}),
      },
      ...(receipt?.status ? { driver_status: receipt.status } : {}),
    };
  }

  private jsonValue(raw: unknown, typeName = "Json"): Value {
    if (typeof raw === "string") return settledText(raw);
    if (typeof raw === "boolean") return { kind: "bool", v: raw, trust: "settled" };
    if (typeof raw === "number") {
      return Number.isInteger(raw)
        ? { kind: "int", v: raw, trust: "settled" }
        : { kind: "float", v: raw, trust: "settled" };
    }
    if (raw === null || raw === undefined) return { kind: "null", trust: "settled" };
    if (Array.isArray(raw)) return { kind: "array", items: raw.map((x) => this.jsonValue(x)), trust: "settled" };
    const fields = new Map<string, Value>();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) fields.set(k, this.jsonValue(v));
    return { kind: "struct", typeName, fields, trust: "settled" };
  }

  private ledgerEntryValue(ev: { tick: number; etype: string; subject: string; agent?: string }, eventType: string, fields: Record<string, Value>): Value {
    const out = new Map<string, Value>();
    out.set("_meta", this.jsonValue({
      tick: ev.tick,
      etype: ev.etype,
      subject: ev.subject,
      agent: ev.agent ?? "",
      hash: this.ledger.head(),
    }, "LedgerMeta"));
    for (const [k, v] of Object.entries(fields)) out.set(k, v);
    return { kind: "struct", typeName: `LedgerEntry<${eventType}>`, fields: out, trust: "settled" };
  }

  private async evalSend(e: A.SendExpr, scope: Scope, expected?: A.TypeRef, bindName?: string): Promise<Value> {
    const dest = await this.evalExpr(e.dest, scope);
    // `<-` is LHS-type-directed (§10): an established `mem` on the left STORES into the region (no
    // provider call, no Sent/Delivered); an agent on the left is a send to cognition.
    if (dest.kind === "memref") {
      const agent = scope.currentAgent();
      const region = agent?.mems.get(dest.name);
      const v = await this.evalExpr(e.message, scope);
      if (!region) throw typeError(`'${dest.name} <-': not a mem handle`);
      if (region.forgotten) throw typeError(`'${dest.name} <-': the handle was forgotten and is no longer writable`);
      region.writes.push(v);
      // E-Store (§15.4.2): a mem write mutates the live private-memory views and appends an audit receipt.
      const receipt = await this.memory.internalize({
        scope: this.memoryScope(agent!, dest.name),
        value: v,
        memory: renderStoreRecollection(dest.name, v),
        episode: { act: "store" },
        summary: valueSummary(v),
        metadata: { source: "store", subject: dest.name, ...this.memoryProvenance() },
      });
      const payload = this.memoryInternalizedPayload(dest.name, v, receipt);
      const ev = this.ledger.append("Internalized", dest.name, payload, agent?.name);
      return this.ledgerEntryValue(ev, "Internalized", {
        mem: settledText(dest.name),
        input: v,
        effects: this.jsonValue(payload.effects, "MemoryEffects"),
        refs: this.jsonValue(payload.refs, "MemoryRefs"),
        policy: this.jsonValue(payload.policy, "MemoryPolicy"),
      });
    }
    // The DESTINATION MUST BE AN ADDRESS (§6: "A send `dest <- p` goes to the agent at `dest`" / "the
    // destination is only an address"). Only an agent (a send to cognition) or a `mem` handle (a write,
    // handled above) is a legal `<-` LHS. A non-agent, non-mem destination — an int/text/struct/etc. — is
    // NOT an address and is a TypeError. This closes the reach bypass: without it, such a destination fell
    // through to `render(dest)` and reached the provider with ZERO authority, defeating default-deny (§13).
    if (dest.kind !== "agentref") {
      throw typeError(`a send '<-' requires an agent or mem handle on the left, not a ${dest.kind} (the destination is only an address, §6)`);
    }
    // AUTHORITY (W-Auth, §13, default-deny): sending INTO ANOTHER agent requires a `reach` grant covering
    // that agent's concrete type OR an interface it implements (`reach Iface` authorizes any implementor,
    // §19.5). A send to `self` is the agent's own cognition and needs no grant. `reach` covers every
    // agent-typed binding uniformly — a param, a `spawn` result, an interface-typed slot — because the
    // check keys on the RESOLVED destination instance's type, not on the syntactic form of the binding.
    this.assertReach(dest, scope);
    const destName = dest.name;
    const msgVal = await this.evalExpr(e.message, scope);
    // §6c: a send whose message is a TaskSpec (a task literal / draft) or an Endorsement<TaskSpec>
    // is a DELEGATION — the recipient answers with code (its task handler), not one provider call.
    const taskInfo = this.taskSpecOf(msgVal);
    if (taskInfo) return this.evalTaskSend(e, dest, taskInfo, scope, expected, bindName);
    const prompt = render(msgVal);
    // §6: a typed binding `T s = d <- …` gives the produced send its subject `s`; an unbound send is
    // subjected at the destination.
    const subj = bindName ?? destName;
    this.ledger.append("Sent", subj, { to: destName, prompt }, scope.currentAgent()?.name);
    // §6: a send to a NON-awake agent has no mailbox — the chain stalls at `Sent` (never `Delivered`); loss is
    // the ABSENCE of Delivered, not an event. A send with an `expires N` lifetime that elapses undelivered
    // appends an `Expired` tombstone instead. A send to `self` (own cognition) always delivers.
    const destInst = this.instances.get(destName);
    const toSelf = destName === scope.currentAgent()?.name;
    if (destInst && !destInst.awake && !toSelf) {
      if (e.expires !== undefined) {
        this.ledger.append("Expired", subj, { to: destName }, scope.currentAgent()?.name);
        this.pendingExpired.push({ dest: destName, subj }); // refused if the dest later awakes (§6)
      }
      return { kind: "text", v: "", trust: "raw" }; // an undelivered orphan reply
    }
    this.ledger.append("Delivered", subj, { to: destName }, scope.currentAgent()?.name);
    this.checkProviderIngress(msgVal, prompt, scope, subj);
    // §5/§8 provider faults: `empty` = an unrecoverable seam failure → the agent crashes (contained); a
    // `schema_violation` = a structured typed reply that fails its schema → a clean, catchable TypeMismatch.
    const fault = (this.provider as { fault?: string }).fault;
    if (fault === "empty") throw new CrashError();
    if (fault === "schema_violation" && expected && expected.kind !== "credence") {
      this.ledger.append("TypeMismatch", subj, undefined, scope.currentAgent()?.name);
      return { kind: "null", trust: "raw" };
    }
    if (expected?.kind === "credence") {
      const variants = this.variantsOf(expected.enumName);
      if (!variants) throw new RuntimeError(`unknown enum '${expected.enumName}'`);
      const { scores } = await this.inResolutionOrder(
        this.provider.judge(prompt, expected.enumName, variants),
        ({ scores: resolvedScores }) => {
          const sources = this.promptSources(e.message, scope);
          const resolvedValue: Value = { kind: "credence", enumName: expected.enumName, scores: resolvedScores, trust: "graded", derivedFrom: sources, ingress: ingressJoin(sources) };
          this.ledger.append("Resolved", subj, {
            kind: "credence",
            prompt,
            reply: valueSummary(resolvedValue),
            enum: expected.enumName,
            rule: undefined,
            ...scoreSummary(resolvedScores),
          }, scope.currentAgent()?.name);
        },
      );
      const sources = this.promptSources(e.message, scope);
      const value: Value = { kind: "credence", enumName: expected.enumName, scores, trust: "graded", derivedFrom: sources, ingress: ingressJoin(sources) };
      // §13 dependency scope: record which in-scope values fed this credence's prompt, so a later
      // `endorse subject by (decide c)` can confirm the decision is ABOUT the subject (see evalGate).
      return value;
    }
    const structuredType = this.structuredType(expected, scope);
    if (structuredType) {
      const schema = this.schemaOf(structuredType, scope)!;
      const rawWork: Promise<{ raw?: unknown; error?: unknown }> = (this.provider.structured
        ? this.provider.structured(prompt, schema, bindName ?? "Reply")
        : this.provider.reply(`${prompt}\n\nReturn only JSON matching this schema:\n${JSON.stringify(schema)}`).then((reply) => JSON.parse(reply)))
        .then((raw) => ({ raw }), (error) => ({ error }));
      let value: Value = { kind: "null", trust: "raw" };
      await this.inResolutionOrder(rawWork, async ({ raw, error }) => {
        if (error) {
          this.ledger.append("TypeMismatch", subj, {
            schema,
            raw,
            error: (error as Error).message,
          }, scope.currentAgent()?.name);
          value = { kind: "null", trust: "raw" };
          return;
        }
        try {
          value = this.valueFromStructured(raw, structuredType, scope);
          const resolved = this.ledger.append("Resolved", subj, {
            kind: "structured",
            prompt,
            schema,
            reply: valueSummary(value),
          }, scope.currentAgent()?.name);
          // §16.7: a received typed reply is internalized into the agent's private memory — the mandatory
          // memory envelope (consult+internalize is unconditional; no opt-in/opt-out config knob).
          await this.internalizeReceivedReply(subj, prompt, value, resolved.tick, scope.currentAgent());
        } catch (err) {
          this.ledger.append("TypeMismatch", subj, {
            schema,
            raw,
            error: (err as Error).message,
          }, scope.currentAgent()?.name);
          value = { kind: "null", trust: "raw" };
        }
      });
      return value;
    }
    let value: Value = { kind: "null", trust: "raw" };
    await this.inResolutionOrder(this.provider.reply(prompt), async (reply) => {
      value = { kind: "text", v: reply, trust: "raw" };
      const resolved = this.ledger.append("Resolved", subj, { kind: "reply", prompt, reply: valueSummary(value) }, scope.currentAgent()?.name);
      // §16.7: a received typed reply is internalized into the agent's private memory — the mandatory memory
      // envelope (consult+internalize is unconditional; there is no opt-in/opt-out config knob). A typed
      // binding slot (`text r = d <- …`) internalizes; a bare unbound send (`d <- …;`) records only its
      // lifecycle. (Credence-slot judgments take the judge path above, not this reply path.)
      if (expected !== undefined) await this.internalizeReceivedReply(subj, prompt, value, resolved.tick, scope.currentAgent());
    });
    return value;
  }

  // §6c: recognize a delegation message — a TaskSpec struct (a task literal / bound draft) or an
  // Endorsement<TaskSpec> (the endorsed, possibly scope-carrying form).
  private taskSpecOf(v: Value): { scope: string[]; endorsed: boolean } | undefined {
    if (v.kind === "struct" && v.typeName === "TaskSpec") return { scope: v.taskScope ?? [], endorsed: false };
    if (v.kind === "endorsement" && v.subject.kind === "struct" && v.subject.typeName === "TaskSpec") {
      return { scope: v.subject.taskScope ?? [], endorsed: true };
    }
    return undefined;
  }

  // §6c the task-send. Foreground (result-bound) delivers inline — the delegator's invocation waits on
  // the terminal, and any terminal other than TaskCompleted faults it via the contained-crash path
  // (§16.6). Background (Task<T>-bound) queues the delivery for the next inter-invocation drain
  // (§16.3a) and returns the settled handle.
  private async evalTaskSend(
    e: A.SendExpr,
    dest: Extract<Value, { kind: "agentref" }>,
    info: { scope: string[]; endorsed: boolean },
    scope: Scope,
    expected?: A.TypeRef,
    bindName?: string,
  ): Promise<Value> {
    const agent = scope.currentAgent();
    if (!expected) {
      throw typeError("a delegation must be bound — hold the result (`T r = …`) or a Task<T> handle; bare statement-form delegation is rejected (§6c)");
    }
    if (e.expires === undefined) {
      throw typeError("a delegation requires `expires` — every task is terminal by construction (§6c)");
    }
    const life = await this.evalExpr(e.expires, scope);
    if (life.kind !== "int" && life.kind !== "float") throw typeError("`expires` requires a numeric lifetime (§6)");
    if (life.trust !== "settled") throw taintViolation("`expires` requires a SETTLED numeric expression — a cognition-derived lifetime is rejected (§6, §6c)");
    if (info.scope.length > 0 && !info.endorsed) {
      throw taintViolation("a scoped task grants perform authority and must be ENDORSED — send an Endorsement<TaskSpec> constructed inside a committed branch (§6c, §13)");
    }
    const foreground = expected.kind !== "task";
    const corr = bindName ?? dest.name;
    const t: TaskState = {
      corr, dest: dest.name, delegator: agent?.name,
      scope: info.scope, endorsed: info.endorsed, foreground,
      status: "sent", delivered: false,
      provenance: this.promptProvenanceALS.getStore(),
    };
    this.tasks.set(corr, t);
    this.ledger.append("Sent", corr, { to: dest.name, task: true }, agent?.name);
    await this.fireSubscriptions("Sent", corr, new Map()); // ≡ TaskSubmitted (alias, §6c)
    if (foreground) {
      const inst = this.instances.get(dest.name);
      if (!inst?.awake) {
        // no mailbox and the delegator is waiting: the mandatory lifetime converts the silence into a
        // tombstone, and the tombstone faults the awaiting invocation (§6c, §16.6).
        t.status = "expired";
        this.ledger.append("Expired", corr, { to: dest.name, task: true }, agent?.name);
        await this.fireSubscriptions("Expired", corr, new Map());
        throw new CrashError();
      }
      await this.deliverTask(t);
      if (t.status === "completed") return this.foregroundResult(t.result!);
      if (!taskTerminal(t)) {
        // the handler returned without a terminal — the lifetime elapses with nothing to wait for.
        t.status = "expired";
        this.ledger.append("Expired", corr, { to: dest.name, task: true }, agent?.name);
        await this.fireSubscriptions("Expired", corr, new Map());
      }
      throw new CrashError(); // failed / cancelled / expired — fault the awaiting invocation (§16.6)
    }
    this.pendingDeliveries.push(t);
    return { kind: "taskref", corr, trust: "settled" };
  }

  // §6c: a delegated result is RAW by default — it is the worker's cognition until the delegator gates
  // it. A worker that completes with a gate value (an Endorsement<T> above all) hands it over as-is:
  // an endorsement is a settled, ledger-backed subject.
  private foregroundResult(v: Value): Value {
    if (v.kind === "endorsement" || v.kind === "credence" || v.kind === "decision") return v;
    return this.withTrust(v, "raw");
  }

  // W-Auth reach (§13): the current agent must hold `reach` for the destination agent's concrete type or
  // an interface that type implements (`reach Iface` covers any implementor, §19.5). Sending to `self` is
  // own-cognition and always permitted. Default-deny: no grant covering the destination ⇒ AuthorityViolation.
  private assertReach(dest: Extract<Value, { kind: "agentref" }>, scope: Scope): void {
    const agent = scope.currentAgent();
    if (agent && dest.name === agent.name) return; // self-send: own cognition, no reach needed (§6)
    const grants = agent?.decl.grants;
    if (grants === "all") return; // grants { * }: lattice top, reaches everything
    // the destination's reachable type names: its concrete agent type, plus every interface it implements.
    const destDecl = this.agents.get(dest.agentType);
    const reachable = new Set<string>([dest.agentType, ...(destDecl?.ifaces ?? [])]);
    // A bare `reach` grant is matched against the destination's (qualified) type/interfaces both as-written
    // and qualified in the reaching agent's home module (§19.2/§19.4), so a companion agent can reach its
    // own-module peer; the home-module qualification cannot name a foreign agent, preserving default-deny.
    const granted = Array.isArray(grants) && grants.some((g) => g.cap === "reach" && (reachable.has(g.name) || reachable.has(this.qualifyInModule(g.name, scope))));
    if (!granted) {
      throw authorityViolation(`agent lacks 'reach ${dest.agentType}' (sending into '${dest.name}' requires a reach grant, §13)`);
    }
  }

  // E-Recall (§10): `MEM -> "query"` consults the agent's private memory. A recall is ALWAYS tainted —
  // taint-equivalent to a send reply: `graded` when bound to a Credence<E> slot, else `raw` text. It
  // records a `MemoryConsulted` trace but never settles a value (no laundering path, §10/§16.7).
  private async evalRecall(e: A.RecallExpr, scope: Scope, expected?: A.TypeRef): Promise<Value> {
    const agent = scope.currentAgent();
    // `->` requires a `mem` on the left; any non-`mem` LHS is a TypeError (also caught statically, §10).
    if (e.mem.kind !== "ident") throw typeError("`->` recall requires a mem handle on the left");
    const region = agent?.mems.get(e.mem.name);
    if (!region) throw typeError(`'${e.mem.name} ->': not a mem handle`);
    if (region.forgotten) throw typeError(`'${e.mem.name} ->': the handle was forgotten and is no longer recallable`);
    const queryValue = await this.evalExpr(e.query, scope);
    const query = render(queryValue);
    const consulted = await this.memory.consult({ scope: this.memoryScope(agent!, e.mem.name), query });
    const overlayCandidates = region.writes.map(valueSummary);
    const candidates = [...consulted.candidates, ...overlayCandidates];
    const recalled = consulted.recalled || (region.writes.length ? render(region.writes[region.writes.length - 1]!) : "");
    const hits = Math.max(consulted.hits.length, region.writes.length);
    if (expected?.kind === "credence") {
      const variants = this.variantsOf(expected.enumName);
      if (!variants) throw new RuntimeError(`unknown enum '${expected.enumName}'`);
      this.checkProviderIngress(queryValue, query, scope, agent?.name ?? "<top>");
      const { scores } = await this.inResolutionOrder(
        this.provider.judge(query, expected.enumName, variants),
        ({ scores: resolvedScores }) => {
          this.ledger.append("MemoryConsulted", agent?.name ?? "<top>", {
            query,
            hits,
            candidates,
            recalled,
            kind: "credence",
            enum: expected.enumName,
            ...scoreSummary(resolvedScores),
          }, agent?.name);
        },
      );
      const sources = this.promptSources(e.query, scope);
      return { kind: "credence", enumName: expected.enumName, scores, trust: "graded", derivedFrom: sources, ingress: ingressJoin(sources) };
    }
    // raw recall text — never settled (a recalled value must be re-decided + endorsed before a sink).
    this.ledger.append("MemoryConsulted", agent?.name ?? "<top>", {
      query,
      hits,
      candidates,
      recalled,
    }, agent?.name);
    return { kind: "text", v: recalled, trust: "raw" };
  }

  // E-Query (§10, §16.7): a deterministic read of the facts table / relationship graph / the ledger
  // itself. A queried value carries the trust of its PROVENANCE event — `graded` by default (most facts
  // trace to internalized, un-endorsed cognition), `settled` only per-row when the origin is an
  // already-endorsed event. This holds uniformly for `from F` AND `from ledger`: a ledger holds many
  // un-endorsed events (Internalized, Sent, MemoryConsulted, Spawned, …), so a blanket `settled` would
  // launder a tainted value at a sink. v0 keeps no materialized rows, so the result is an empty set whose
  // trust is the join over its rows' provenance; with no endorsed-origin row that join is `graded` — never
  // `settled`. The expression form yields the result set and appends nothing; the bare statement form
  // lands a `QueryResult(subject)` event (the subject is the query target: the agent, or `ledger`).
  private async evalQuery(e: A.SelectExpr, scope: Scope, asStatement: boolean): Promise<Value> {
    const agent = scope.currentAgent();
    if (asStatement) {
      this.ledger.append("QueryResult", e.target, undefined, agent?.name);
    }
    // The result trust is the join of the matched rows' RECORDED (provenance) trust (§10). A `from F`/graph
    // read over private memory defaults to `graded` (most facts trace to internalized, un-endorsed
    // cognition). A `from ledger` read is deterministic and carries recorded trust: an `Endorsed`-origin
    // row reads back `settled` (the ledger is the proof it was endorsed), every other origin (`Spawned`,
    // `Sent`, `Internalized`, `MemoryConsulted`, …) reads back `graded`, so a blanket `settled` cannot
    // launder a tainted row. With no matching rows the default is `graded` — never `settled` — withholding
    // by default (§13/§14): a `settled` result would require an actual endorsed-origin row.
    const trust: Trust = this.ledgerReadTrust(e);
    return { kind: "array", items: [], trust };
  }

  // The recorded trust of a `select … from ledger where { COND }` read (§10): the join over the trust of
  // the matched ledger rows, where an `Endorsed`/endorsement-class origin row is `settled` and every other
  // origin is `graded`. Only equality on `etype` is interpreted (the v0 `where` vocabulary the suite uses);
  // any un-interpreted condition is treated as matching every row, so the result can only be MORE tainted,
  // never less — the safe (non-laundering) direction. No rows match ⇒ `graded` (withhold by default).
  private ledgerReadTrust(e: A.SelectExpr): Trust {
    const etypeEq = e.cond.find((c) => (c.field === "etype" || c.field.endsWith(".etype")) && c.op === "==" && c.value.kind === "string");
    const wantEtype = etypeEq && etypeEq.value.kind === "string" ? etypeEq.value.value : undefined;
    const wanted = e.eventType ?? wantEtype;
    const rows = this.ledger.events.filter((ev) => (wanted === undefined ? true : ev.etype === wanted));
    if (rows.length === 0) return "graded";
    return rows.every((ev) => this.isEndorsedOrigin(ev.etype)) ? "settled" : "graded";
  }

  // an endorsement-class ledger origin: an `Endorsed` row (and its narrowed variants) is the recorded proof
  // that a subject was settled, so a ledger read of such a row carries `settled` recorded trust (§10).
  private isEndorsedOrigin(etype: string): boolean {
    return etype === "Endorsed";
  }


  private async evalMember(e: A.MemberExpr, scope: Scope): Promise<Value> {
    const o = await this.evalExpr(e.obj, scope);
    if (o.kind === "struct") {
      const f = o.fields.get(e.field);
      if (f) return f;
      throw new RuntimeError(`no field '${e.field}' on struct ${o.typeName ?? ""}`);
    }
    if (o.kind === "decision" || o.kind === "endorsement") {
      switch (e.field) {
        case "committed":
          return o.committed === "abstained"
            ? { kind: "enumval", enumName: "", variant: "abstained", trust: "settled" }
            : { kind: "enumval", enumName: o.enumName, variant: o.committed, trust: "settled" };
        case "basis": return { kind: "enumval", enumName: "Basis", variant: o.basis, trust: "settled" };
        case "margin": return { kind: "float", v: o.margin, trust: "settled" };
        case "decision_id": return { kind: "int", v: o.decisionId, trust: "settled" };
        case "subject": if (o.kind === "endorsement") {
          // a committed-narrowed endorsement exposes its subject as the CERTIFIED (settled) datum —
          // for DATA subjects; a gate-object subject (credence/decision/endorsement) keeps its own
          // nature (sinkValue rejects those regardless).
          return o.committedNarrowed ? this.settledEndorsedValue(o.subject) : o.subject;
        } break;
      }
      // §13/§9: the metadata accessors (committed/basis/margin/decision_id/subject) WIN a name collision;
      // any OTHER field on an Endorsement delegates to the subject (`e.body` → the subject struct's `body`),
      // also reachable through `.subject`. The Endorsement IS the settled form of the subject, so a field
      // read through a committed-narrowed endorsement is the CERTIFIED datum — it reads back settled (that
      // is exactly what the endorsement settled); an un-narrowed endorsement never upgrades trust.
      if (o.kind === "endorsement" && o.subject.kind === "struct") {
        const f = o.subject.fields.get(e.field);
        if (f) return o.committedNarrowed ? this.settledEndorsedValue(f) : f;
      }
    }
    throw new RuntimeError(`no field '${e.field}' on ${o.kind}`);
  }

  private settledEndorsedValue(v: Value): Value {
    switch (v.kind) {
      case "credence":
      case "decision":
      case "endorsement":
        return v;
      case "text": return { ...v, trust: "settled" };
      case "int": return { ...v, trust: "settled" };
      case "float": return { ...v, trust: "settled" };
      case "bool": return { ...v, trust: "settled" };
      case "null": return { ...v, trust: "settled" };
      case "enumval": return { ...v, trust: "settled" };
      case "agentref": return v;
      case "memref": return v;
      case "taskref": return v;
      case "struct": return { ...v, trust: "settled" };
      case "array": return { ...v, trust: "settled" };
    }
  }

  private async evalBinary(e: A.BinaryExpr, scope: Scope): Promise<Value> {
    const l = await this.evalExpr(e.left, scope);
    const r = await this.evalExpr(e.right, scope, this.enumHint(l));
    const num = (v: Value) => (v.kind === "int" || v.kind === "float" ? v.v : NaN);
    switch (e.op) {
      case "==": return { kind: "bool", v: this.eq(l, r), trust: "settled", ingress: ingressJoin([l, r]) };
      case "!=": return { kind: "bool", v: !this.eq(l, r), trust: "settled", ingress: ingressJoin([l, r]) };
      case "<": return { kind: "bool", v: num(l) < num(r), trust: "settled", ingress: ingressJoin([l, r]) };
      case ">": return { kind: "bool", v: num(l) > num(r), trust: "settled", ingress: ingressJoin([l, r]) };
      case "<=": return { kind: "bool", v: num(l) <= num(r), trust: "settled", ingress: ingressJoin([l, r]) };
      case ">=": return { kind: "bool", v: num(l) >= num(r), trust: "settled", ingress: ingressJoin([l, r]) };
      // value-producing ops join operand trust (contagious-upward, §15.3.1): `raw + "x"` stays raw —
      // string concat / arithmetic must NOT launder a cognition-provenance value to settled.
      case "+": {
        const t = trustJoin([l, r]);
        const ingress = ingressJoin([l, r]);
        if (l.kind === "array" && r.kind === "array") return { kind: "array", items: [...l.items, ...r.items], trust: t, ingress };
        if (l.kind === "text" || r.kind === "text") return { kind: "text", v: render(l) + render(r), trust: t, ingress };
        return { kind: "float", v: num(l) + num(r), trust: t, ingress };
      }
      case "-": return { kind: "float", v: num(l) - num(r), trust: trustJoin([l, r]), ingress: ingressJoin([l, r]) };
      case "*": return { kind: "float", v: num(l) * num(r), trust: trustJoin([l, r]), ingress: ingressJoin([l, r]) };
      case "/": return { kind: "float", v: num(l) / num(r), trust: trustJoin([l, r]), ingress: ingressJoin([l, r]) };
      case "&&": return { kind: "bool", v: (l as any).v && (r as any).v, trust: "settled", ingress: ingressJoin([l, r]) };
      case "||": return { kind: "bool", v: (l as any).v || (r as any).v, trust: "settled", ingress: ingressJoin([l, r]) };
    }
    throw new RuntimeError(`bad binary ${e.op}`);
  }

  private eq(l: Value, r: Value): boolean {
    if (l.kind === "enumval" && r.kind === "enumval") return l.variant === r.variant;
    if (l.kind === "enumval" && r.kind === "bool") return l.variant === String(r.v);
    if (l.kind === "bool" && r.kind === "enumval") return String(l.v) === r.variant;
    if (l.kind === "enumval") return false;
    if (r.kind === "enumval") return false;
    if ("v" in l && "v" in r) return (l as any).v === (r as any).v;
    return false;
  }

  private enumHint(l: Value): A.TypeRef | undefined {
    if (l.kind === "enumval" && l.enumName) return { kind: "named", name: l.enumName };
    return undefined;
  }

  private enumOfVariant(name: string, expected?: A.TypeRef): string | undefined {
    if (expected?.kind === "named" && this.enums.get(expected.name)?.includes(name)) return expected.name;
    if (expected?.kind === "credence" && this.variantsOf(expected.enumName)?.includes(name)) return expected.enumName;
    for (const [en, vs] of this.enums) if (vs.includes(name)) return en;
    return undefined;
  }

  private variantsOf(enumName: string): string[] | undefined {
    return this.enums.get(enumName) ?? (enumName === "bool" ? ["true", "false"] : undefined);
  }

  private structuredType(expected: A.TypeRef | undefined, scope: Scope): A.TypeRef | undefined {
    if (!expected) return undefined;
    const t = expected.kind === "event" ? expected.inner : expected;
    return this.schemaOf(t, scope) ? t : undefined;
  }

  private schemaOf(t: A.TypeRef, scope: Scope): StructuredSchema | undefined {
    switch (t.kind) {
      case "scalar":
        switch (t.name) {
          case "text": return { type: "string" };
          case "int": return { type: "integer" };
          case "float": return { type: "number" };
          case "bool": return { type: "boolean" };
          case "null": return { type: "null" };
        }
        break;
      case "array": {
        const items = this.schemaOf(t.inner, scope);
        return items ? { type: "array", items } : undefined;
      }
      case "named": {
        const name = this.resolveTypeName(t.name, scope);
        const variants = this.enums.get(name);
        if (variants) return { type: "string", enum: variants };
        const fields = this.structs.get(name);
        if (!fields) return undefined;
        const properties: Record<string, StructuredSchema> = {};
        const required: string[] = [];
        for (const f of fields) {
          const schema = this.schemaOf(f.type, scope);
          if (!schema) return undefined;
          properties[f.name] = schema;
          required.push(f.name);
        }
        return { type: "object", properties, required, additionalProperties: false };
      }
      default:
        return undefined;
    }
  }

  private resolveTypeName(name: string, scope: Scope): string {
    if (name.includes(".")) return name;
    const q = this.qualifyInModule(name, scope);
    return this.structs.has(q) || this.enums.has(q) ? q : name;
  }

  private valueFromPromptInput(raw: unknown, t: A.TypeRef, scope: Scope, ingress: IngressProvenance): Value {
    return this.withIngress(this.withTrust(this.valueFromStructured(this.coercePromptInput(raw, t, scope), t, scope), "settled"), ingress);
  }

  private coercePromptInput(raw: unknown, t: A.TypeRef, scope: Scope): unknown {
    if (t.kind === "event") return this.coercePromptInput(raw, t.inner, scope);
    if (t.kind === "scalar") {
      if (t.name === "text") return String(raw ?? "");
      if (t.name === "int") {
        const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
        if (!Number.isInteger(n)) throw typeError("prompt input is not an int");
        return n;
      }
      if (t.name === "float") {
        const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
        if (!Number.isFinite(n)) throw typeError("prompt input is not a float");
        return n;
      }
      if (t.name === "bool") {
        if (typeof raw === "boolean") return raw;
        const s = String(raw ?? "").trim().toLowerCase();
        if (["true", "yes", "1", "on"].includes(s)) return true;
        if (["false", "no", "0", "off"].includes(s)) return false;
        throw typeError("prompt input is not a bool");
      }
      if (t.name === "null") return null;
    }
    if (t.kind === "array") {
      const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!Array.isArray(arr)) throw typeError("prompt input is not an array");
      return arr.map((x) => this.coercePromptInput(x, t.inner, scope));
    }
    if (t.kind === "named") {
      const name = this.resolveTypeName(t.name, scope);
      const variants = this.enums.get(name);
      if (variants) return String(raw ?? "");
      const fields = this.structs.get(name);
      if (fields) {
        const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw typeError(`prompt input is not a ${name} object`);
        const src = obj as Record<string, unknown>;
        return Object.fromEntries(fields.map((f) => [f.name, this.coercePromptInput(src[f.name], f.type, scope)]));
      }
    }
    return raw;
  }

  private withTrust(v: Value, trust: Trust): Value {
    if (v.kind === "struct") {
      const fields = new Map([...v.fields].map(([k, val]) => [k, this.withTrust(val, trust)]));
      return { ...v, fields, trust };
    }
    if (v.kind === "array") return { ...v, items: v.items.map((item) => this.withTrust(item, trust)), trust };
    if (v.kind === "credence" || v.kind === "decision" || v.kind === "endorsement") return v;
    return { ...v, trust } as Value;
  }

  private withIngress(v: Value, ingress: IngressProvenance): Value {
    if (v.kind === "struct") {
      const fields = new Map([...v.fields].map(([k, val]) => [k, this.withIngress(val, ingress)]));
      return { ...v, fields, ingress };
    }
    if (v.kind === "array") return { ...v, items: v.items.map((item) => this.withIngress(item, ingress)), ingress };
    if (v.kind === "credence" || v.kind === "decision") return { ...v, ingress };
    if (v.kind === "endorsement") return { ...v, subject: this.withIngress(v.subject, ingress), ingress };
    return { ...v, ingress } as Value;
  }

  private valueFromStructured(raw: unknown, t: A.TypeRef, scope: Scope): Value {
    if (t.kind === "event") return this.valueFromStructured(raw, t.inner, scope);
    if (t.kind === "scalar") {
      switch (t.name) {
        case "text":
          if (typeof raw !== "string") throw new RuntimeError("structured reply field is not text");
          return { kind: "text", v: raw, trust: "raw" };
        case "int":
          if (typeof raw !== "number" || !Number.isInteger(raw)) throw new RuntimeError("structured reply field is not int");
          return { kind: "int", v: raw, trust: "raw" };
        case "float":
          if (typeof raw !== "number") throw new RuntimeError("structured reply field is not float");
          return { kind: "float", v: raw, trust: "raw" };
        case "bool":
          if (typeof raw !== "boolean") throw new RuntimeError("structured reply field is not bool");
          return { kind: "bool", v: raw, trust: "raw" };
        case "null":
          if (raw !== null) throw new RuntimeError("structured reply field is not null");
          return { kind: "null", trust: "raw" };
      }
    }
    if (t.kind === "array") {
      if (!Array.isArray(raw)) throw new RuntimeError("structured reply is not an array");
      const items = raw.map((x) => this.valueFromStructured(x, t.inner, scope));
      return { kind: "array", items, trust: trustJoin(items), ingress: ingressJoin(items) };
    }
    if (t.kind === "named") {
      const name = this.resolveTypeName(t.name, scope);
      const variants = this.enums.get(name);
      if (variants) {
        if (typeof raw !== "string" || !variants.includes(raw)) throw new RuntimeError(`structured reply is not a ${name} variant`);
        return { kind: "enumval", enumName: name, variant: raw, trust: "raw" };
      }
      const fields = this.structs.get(name);
      if (!fields) throw new RuntimeError(`unknown structured reply type '${name}'`);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new RuntimeError(`structured reply is not a ${name} object`);
      const obj = raw as Record<string, unknown>;
      const allowed = new Set(fields.map((f) => f.name));
      for (const key of Object.keys(obj)) if (!allowed.has(key)) throw new RuntimeError(`structured reply has extra field '${key}'`);
      const out = new Map<string, Value>();
      for (const f of fields) {
        if (!Object.prototype.hasOwnProperty.call(obj, f.name)) throw new RuntimeError(`structured reply missing field '${f.name}'`);
        out.set(f.name, this.valueFromStructured(obj[f.name], f.type, scope));
      }
      return { kind: "struct", typeName: name, fields: out, trust: trustJoin([...out.values()]), ingress: ingressJoin([...out.values()]) };
    }
    throw new RuntimeError("type does not have a structured reply schema");
  }

  private requireInstance(name: string): AgentInstance {
    const inst = this.instances.get(name);
    if (!inst) throw new RuntimeError(`unknown agent instance '${name}'`);
    return inst;
  }

  // §15.4: resolve a lifecycle target (`awake x` / `sleep x`) to a concrete instance name. `x` may be a
  // static instance name (the statement-form `spawn Type x`) OR a variable holding an agentref (the
  // expression form `Type x = spawn Type`); the latter names a generated instance, so resolve the value.
  private instanceNameOf(name: string, scope: Scope): string {
    const v = scope.get(name);
    return v && v.kind === "agentref" ? v.name : name;
  }
  private agentSubject(scope: Scope): string {
    return scope.currentAgent()?.name ?? "<top>";
  }
  private zeroOf(_t: A.TypeRef): Value {
    return { kind: "null", trust: "settled" };
  }
}

// trust join over the lattice settled ⊑ graded ⊑ raw — the result is as raw as its least-settled input
// (contagious upward, §15.3.1). With no inputs the result is settled because no input carried cognition.
function trustJoin(vs: { trust: Trust }[]): Trust {
  let t: Trust = "settled";
  for (const v of vs) {
    if (v.trust === "raw") return "raw";
    if (v.trust === "graded") t = "graded";
  }
  return t;
}

// ---- §12 fusion algebra (pure, deterministic) ----

// Group a list of (name, p) units into dependent clusters by the `dependent`/`independent` declarations:
// two names in the same declared group are placed in one cluster (union-find). An un-named unit, or a
// name in no group, is its own singleton cluster. Only DEPENDENT grouping matters for the Fréchet bound;
// `independent` declarations satisfy pair coverage but keep the units separate. Since a name may appear in
// both an `independent` and a `dependent` group, we cluster only by groups that co-locate names as a unit
// for the bound — here we union any two names that share a group AND are asserted dependent. We do not
// have the relation on the group here (both are stored as name-lists in scope.depGroups), so we treat any
// co-declared pair as a candidate; the conservative Fréchet bound over a singleton is identity, so a pure
// `independent` pair that we (over-)cluster would still combine correctly ONLY if we distinguish them.
// To keep the semantics faithful we cluster strictly by the dependent groups, which the interpreter records
// separately (see clusterByDependenceGroups). This wrapper keeps the call site stable.
function clusterByDependence(units: { name?: string; p: number }[], depGroups: string[][]): number[][] {
  // Union-find over indices; union i,j when they share ANY dependence group. (Independent groups are not
  // passed here — only dependent groups are; see evalAgg/evalQuorum which filter to dependent.)
  const parent = units.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };
  for (const g of depGroups) {
    const idxs = units.map((u, i) => (u.name && g.includes(u.name) ? i : -1)).filter((i) => i >= 0);
    for (let k = 1; k < idxs.length; k++) union(idxs[0]!, idxs[k]!);
  }
  const byRoot = new Map<number, number[]>();
  units.forEach((u, i) => {
    const r = find(i);
    (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(u.p);
  });
  return [...byRoot.values()];
}

// combine independent per-unit probabilities by log-odds addition (Good's weight of evidence): sum the
// logits, re-sigmoid. A single unit returns its own p. Probabilities are clamped away from 0/1 to keep
// the logit finite.
function logOddsCombine(ps: number[]): number {
  if (ps.length === 0) return 0;
  if (ps.length === 1) return ps[0]!;
  const clamp = (p: number) => Math.max(1e-9, Math.min(1 - 1e-9, p));
  const logitSum = ps.reduce((acc, p) => acc + Math.log(clamp(p) / (1 - clamp(p))), 0);
  return 1 / (1 + Math.exp(-logitSum));
}

// P(at least k of n independent Bernoulli(p_i) succeed) — exact Poisson-binomial tail via DP over the
// per-judge success probabilities. Deterministic; no numeric assertion in the suite, correctness of shape
// (a probability in [0,1]) and gating-once is what matters.
function poissonBinomialTail(ps: number[], k: number): number {
  const n = ps.length;
  // dp[j] = P(exactly j successes so far)
  let dp = new Array<number>(n + 1).fill(0);
  dp[0] = 1;
  for (let i = 0; i < n; i++) {
    const p = Math.max(0, Math.min(1, ps[i]!));
    const next = new Array<number>(n + 1).fill(0);
    for (let j = 0; j <= i; j++) {
      next[j] = next[j]! + dp[j]! * (1 - p);
      next[j + 1] = next[j + 1]! + dp[j]! * p;
    }
    dp = next;
  }
  let tail = 0;
  for (let j = Math.max(0, k); j <= n; j++) tail += dp[j]!;
  return tail;
}

// a small deterministic non-negative integer derived from a string (for the mock tool result value).
function hashInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0) % 100000;
}

function topVariant(scores: Record<Variant, number>): { variant: Variant; score: number } {
  let best: Variant = "";
  let bestScore = -1;
  for (const [v, s] of Object.entries(scores)) if (s > bestScore) { best = v; bestScore = s; }
  return { variant: best, score: bestScore };
}
function secondScore(scores: Record<Variant, number>): number {
  const sorted = Object.values(scores).sort((a, b) => b - a);
  return sorted[1] ?? 0;
}
