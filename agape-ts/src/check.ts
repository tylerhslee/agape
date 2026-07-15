// Semantic checker — a static pass over the parsed Program that raises the spec's compile-error
// classes (TypeError, ExhaustivenessError, …) BEFORE the program runs. It is deliberately
// CONSERVATIVE: it only rejects a construct when the violation is unambiguous, and treats anything
// it cannot infer as `unknown` (never a false reject). Taint/authority remain dynamic (§13), enforced
// by the interpreter; this pass covers the type-shape checks that the spec makes statically.

import type * as A from "./ast.js";
import { parse } from "./parser.js";
import { typeError, exhaustivenessError, colorViolation, authorityViolation, taintViolation, interfaceError, visibilityError, moduleError, configError, gateError } from "./errors.js";
import { hasConfiguredBinding, type Manifest, type BindingConfig, type WiringConfig } from "./config.js";

// a coarse type class — enough to catch shape mismatches without a full type system.
// `credarray` narrowly tracks an `array<Credence<…>>` (a credence collection produced by a query or an
// array literal of credences), so the §12 fusion-coverage check can see the single-array `all(arr)` form.
type Cls =
  | "int" | "float" | "bool" | "text" | "null"
  | "credence" | "credarray" | "decision" | "endorsement" | "enum" | "agent" | "mem" | "unknown";

interface Decls {
  enums: Map<string, string[]>;
  structs: Map<string, A.StructDecl>;
  actions: Map<string, A.Field[]>;
  // whether an action is declared `reversible` (§20.1): a `reversible action` is a low-stakes sink, so an
  // endorse arm reaching it is NOT a consequential path and does not require a principal fallback (§20.3).
  // A name absent from this map (or mapped false) is a non-reversible, consequential sink.
  actionReversible: Map<string, boolean>;
  events: Map<string, A.Field[]>;
  agents: Map<string, A.AgentDecl>;
  interfaces: Map<string, A.InterfaceDecl>;
  // user function declarations (§4/§15.2), keyed by name (bare and, for imports, qualified). Used by the
  // pure seam-freedom check: a `pure` fn may only call other `pure` fns (§4), so calling an async
  // (unmarked) user function from a `pure` body is a ColorViolation.
  fns: Map<string, A.FnDecl>;
  // declared-dependency name sets (§3/§5b): a `principal NAME;` names an accountable identity, a
  // `prompt T NAME;` names an external input sensor. Both are "known" names — used in a `by`/prefix
  // position (principal) or a `when (Prompt … about NAME)` subscription (prompt) without being an
  // undeclared-ident error, and consulted by the DECIDE-BY-PRINCIPAL predicate.
  principals: Set<string>;
  prompts: Set<string>;
  // whether a USER declaration name is `pub` (§19.4). A name absent from this map is either a built-in
  // (Error/Event/Principal/scalars — always exportable) or undeclared (unchecked, conservative).
  pub: Map<string, boolean>;
}

// the built-in event roots (§9): a generic `Event`/`Error` may be emitted with any payload, no decl.
// `TaskProgress` (§6c) is the worker-emittable repeatable task event — statically admissible; the
// RUNTIME requires an active task handler (emitting it outside one is a TypeError there).
const BUILTIN_EVENTS = new Set(["Event", "Error", "TaskProgress"]);

class Scope {
  vars = new Map<string, Cls>();
  // `mem` handles that `forget` has consumed — recall through a forgotten handle is a TypeError (§10).
  forgotten = new Set<string>();
  // PROVENANCE for the §13 dependency-scope check. `tainted` names a binding whose value came from a
  // memory read (recall `->`, `select`/`find`, or `match`) — a subjective, un-endorsed fact (§10). `scopeOf`
  // names, for a Credence/Decision binding, the set of identifiers in its DEPENDENCY SCOPE: the credence
  // it was produced from plus the identifiers that fed that credence's prompt. The endorsed subject of an
  // `endorse subject by d` must lie in `scopeOf(d)`; a tainted subject outside it is laundering (§13).
  tainted = new Set<string>();
  scopeOf = new Map<string, Set<string>>();
  // the enum a Credence/Decision binding gates over (from its declared type) — used for gate arm-head
  // validation and compile-time exhaustiveness (§13, §15.3.3).
  enumNames = new Map<string, string>();
  // §12 dependence declarations SEEN SO FAR IN SCOPE: each `independent`/`dependent NAME…` records the
  // set of names it groups. A pair (a,b) is COVERED (by either relation) when some group contains both.
  depGroups: string[][] = [];
  // The CONCRETE agent type a binding refers to, when statically known (a `spawn X n` names `n` as an `X`;
  // a `var m = n` / `assign m = n` copies n's type). Used for the §19.5 interface-typed-binding check:
  // binding a known non-implementor into an interface slot is an InterfaceError. Unknown ⇒ unchecked.
  agentTypeOf = new Map<string, string>();
  // Legacy dispatch bookkeeping for pre-core arm sugar. In the core, `endorse` can only be constructed
  // from a committed-narrowed Decision, so an Endorsement binder is sink-admissible immediately.
  nonCommittedEndorsements = new Set<string>();
  // Bindings narrowed committed in this child branch via `if (x.committed == V)` for a real variant V.
  // Decisions become endorsement-admissible; legacy Endorsements become sink-admissible.
  committedNarrowed = new Set<string>();
  committedDecisions = new Set<string>();
  // The `decide` expression a `Decision<E>` binding was produced from, when statically known (a
  // `Decision<E> d = decide c by R`). Used by the §20.3 deference check to ask whether the decision
  // endorsing a consequential path is principal-driven (a prefix `p decide …` or a `by <principal>` rule).
  decideOf = new Map<string, A.DecideExpr>();
  constructor(public parent?: Scope) {}
  setDecide(name: string, d: A.DecideExpr) { this.decideOf.set(name, d); }
  getDecide(name: string): A.DecideExpr | undefined {
    return this.decideOf.get(name) ?? this.parent?.getDecide(name);
  }
  markNonCommittedEndorsement(name: string) { this.nonCommittedEndorsements.add(name); }
  markCommittedNarrowed(name: string) { this.committedNarrowed.add(name); }
  markCommittedDecision(name: string) { this.committedDecisions.add(name); }
  isCommittedDecision(name: string): boolean {
    return this.committedDecisions.has(name) || (this.parent?.isCommittedDecision(name) ?? false);
  }
  isNonCommittedEndorsement(name: string): boolean {
    if (this.committedNarrowed.has(name)) return false; // narrowed committed in this branch → sink-admissible
    return this.nonCommittedEndorsements.has(name) || (this.parent?.isNonCommittedEndorsement(name) ?? false);
  }
  getAgentType(name: string): string | undefined {
    return this.agentTypeOf.get(name) ?? this.parent?.getAgentType(name);
  }
  setAgentType(name: string, t: string) { this.agentTypeOf.set(name, t); }
  get(name: string): Cls | undefined {
    return this.vars.get(name) ?? this.parent?.get(name);
  }
  set(name: string, c: Cls) { this.vars.set(name, c); }
  isForgotten(name: string): boolean {
    return this.forgotten.has(name) || (this.parent?.isForgotten(name) ?? false);
  }
  forget(name: string) { this.forgotten.add(name); }
  // a CHILD scope may locally CLEAR an inherited taint (an endorse commit arm settles its subject, §13).
  untainted = new Set<string>();
  isTainted(name: string): boolean {
    if (this.untainted.has(name)) return false;
    return this.tainted.has(name) || (this.parent?.isTainted(name) ?? false);
  }
  markTainted(name: string) { this.tainted.add(name); }
  clearTaint(name: string) { this.untainted.add(name); }
  // set-or-clear a name's taint to match the value just assigned to it: `assign NAME = value` refreshes the
  // name's provenance to the value's (a clean value un-taints; a memory-read value taints). Provenance is a
  // property of the *current* value bound to the name, not of the name forever. `delete` only clears this
  // scope; the laundering cases bind and reassign in the same (hook) scope, so that is sufficient.
  setTaintedTo(name: string, tainted: boolean) { if (tainted) this.tainted.add(name); else this.tainted.delete(name); }
  getScope(name: string): Set<string> | undefined {
    return this.scopeOf.get(name) ?? this.parent?.getScope(name);
  }
  setScope(name: string, s: Set<string>) { this.scopeOf.set(name, s); }
  getEnumName(name: string): string | undefined {
    return this.enumNames.get(name) ?? this.parent?.getEnumName(name);
  }
  setEnumName(name: string, e: string) { this.enumNames.set(name, e); }
  addDepGroup(names: string[]) { this.depGroups.push(names); }
  // all dependence groups in scope: this scope's plus every ancestor's (declarations are hoisted per
  // block; a declaration in an enclosing scope still covers a fuse in a nested one).
  allDepGroups(): string[][] {
    return [...this.depGroups, ...(this.parent ? this.parent.allDepGroups() : [])];
  }
  child(): Scope { return new Scope(this); }
}

// A companion module source, as loaded by the conformance harness from a test's `//! modules:` /
// `//! packages:` directive (§19.2/§19.3). `name`, when present, is the import root the harness assigns
// (a `packages:` entry names its own root); otherwise the module name is read from the source's own
// `module X;` header. The linker parses each companion, keys it by module name, and resolves the main
// program's `import`s against that table.
export interface ModuleInput { name?: string; src: string }

// ---- §19.2 module linker ----

// A loaded module: its parsed program, its own top-level declarations keyed by SIMPLE name (with the
// `pub` flag), and its own import headers (for cycle detection and `pub import` re-export resolution).
interface LinkedModule {
  name: string;
  program: A.Program;
  own: Map<string, { decl: A.Decl; pub: boolean }>;
  imports: A.ImportDecl[];
}

// The resolution the linker hands to the checker and the interpreter (§19.1: the layer erases to this
// map). `qualifiedDecls` maps every reachable qualified name (`util.dbl`, `geometry.Shape`, `a.Tick`)
// to its declaration, so the checker's shape checks and the interpreter's execution can find it.
// `bareBindings` maps a selectively-imported bare name (`dbl`, `ok`) to its resolved qualified name.
export interface Resolution {
  qualifiedDecls: Map<string, A.Decl>; // fully-qualified name → decl (companion + re-exported)
  bareBindings: Map<string, string>;   // bound bare name (selective import) → its qualified name
}

// The implicit root module's key (a program with no `module` header). Never collides with a user modpath.
const ROOT_MODULE = "<root>";

// Parse and key every companion module; build the module table. The KEY is `entry.name` when the
// harness assigned one (a `packages:` root overriding the companion's own header, §19.3), else the
// source's own `module X;` header, else the implicit root (§19.2).
function buildModuleTable(modules: ModuleInput[]): Map<string, LinkedModule> {
  const table = new Map<string, LinkedModule>();
  for (const m of modules) {
    const prog = parse(m.src);
    const name = m.name ?? prog.module ?? ROOT_MODULE;
    const own = new Map<string, { decl: A.Decl; pub: boolean }>();
    for (const d of prog.decls) {
      if (d.kind === "instruction" || d.kind === "conformal") continue; // no exportable name
      own.set((d as { name: string }).name, { decl: d, pub: !!(d as { pub?: boolean }).pub });
    }
    table.set(name, { name, program: prog, own, imports: prog.imports ?? [] });
  }
  return table;
}

// The set of modules imported by a module's own headers (whether plain or `pub`), used for cycle
// detection over the whole import graph (§19.2: imports are acyclic).
function importedModuleNames(imports: A.ImportDecl[]): string[] {
  return imports.map((i) => i.module);
}

// DFS the import graph for a back-edge; a cycle is a ModuleError (§19.2). The graph roots at the given
// entry (the main program's imports) plus every companion's own imports.
function assertAcyclic(mainImports: A.ImportDecl[], table: Map<string, LinkedModule>): void {
  const edges = (name: string): string[] => {
    if (name === ROOT_MODULE) return importedModuleNames(mainImports);
    const mod = table.get(name);
    return mod ? importedModuleNames(mod.imports) : [];
  };
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const visit = (name: string): void => {
    color.set(name, GREY);
    for (const next of edges(name)) {
      const c = color.get(next) ?? WHITE;
      if (c === GREY) throw moduleError(`import cycle detected involving module '${next}' (imports are acyclic, §19.2)`);
      if (c === WHITE) visit(next);
    }
    color.set(name, BLACK);
  };
  // start from the main program, then sweep any companion not yet reached (so a cycle among modules the
  // main program does not directly reach is still detected).
  visit(ROOT_MODULE);
  for (const name of table.keys()) if ((color.get(name) ?? WHITE) === WHITE) visit(name);
}

// The PUBLIC surface of a module (§19.2/§19.2a): the members it exports and the whole sub-prefixes it
// re-exports. `members` = its own `pub` decls PLUS every name selectively re-exported by a `pub import
// { … } from N` (resolved from N's public surface); `prefixes` = every whole `pub import N (as X)`,
// mapping the local prefix to the target module name (so a nested `facade.internal.Shape` descends).
// A `pub import` of a NON-pub name is a VisibilityError (§19.2a). Guarded against import cycles by the
// `seen` set (a cycle is already rejected by assertAcyclic, but re-exports resolve recursively here).
interface PublicSurface {
  members: Map<string, { decl: A.Decl; pub: boolean; qname: string }>;
  prefixes: Map<string, string>; // local prefix → target module name
}
function publicSurfaceOf(name: string, table: Map<string, LinkedModule>, seen: Set<string> = new Set()): PublicSurface {
  const members = new Map<string, { decl: A.Decl; pub: boolean; qname: string }>();
  const prefixes = new Map<string, string>();
  const mod = table.get(name);
  if (!mod || seen.has(name)) return { members, prefixes };
  seen.add(name);
  // own pub declarations are public members under this module's qualified prefix.
  for (const [simple, e] of mod.own) {
    if (e.pub) members.set(simple, { decl: e.decl, pub: true, qname: `${name}.${simple}` });
  }
  // re-exports (§19.2a): a `pub import` republishes into this module's public surface.
  for (const imp of mod.imports) {
    if (!imp.pub) continue; // a plain import is private to the importer; it republishes nothing
    const targetSurface = publicSurfaceOf(imp.module, table, seen);
    if (imp.selective) {
      const targetMod = table.get(imp.module);
      for (const nm of imp.selective) {
        // existence FIRST (absent → ModuleError), then pub-ness (present-not-pub → VisibilityError).
        const ownEntry = targetMod?.own.get(nm);
        const pubEntry = targetSurface.members.get(nm);
        if (!ownEntry && !pubEntry) {
          throw moduleError(`pub import of '${nm}' from '${imp.module}': no such export (§19.2)`);
        }
        if (pubEntry) members.set(nm, { decl: pubEntry.decl, pub: true, qname: pubEntry.qname });
        else throw visibilityError(`pub import of non-pub '${nm}' from '${imp.module}' (a pub import of a private name is a VisibilityError, §19.2a)`);
      }
    } else {
      // `pub import N (as X)`: re-export the whole prefix (nested qualified paths descend through it).
      prefixes.set(imp.alias ?? imp.module, imp.module);
    }
  }
  return { members, prefixes };
}

// Resolve a QUALIFIED reference (`m.X`, `facade.internal.Shape`) against the main program's import
// bindings and the module table (§19.2). Returns the resolved decl + qualified name, or a classified
// failure the caller maps to a ModuleError / VisibilityError.
type Resolved =
  | { ok: true; decl: A.Decl; pub: boolean; qname: string }
  | { ok: false; why: "no-module" | "no-member" | "private"; qname: string };

function resolveQualified(
  segments: string[],
  prefixBindings: Map<string, string>,
  table: Map<string, LinkedModule>,
): Resolved {
  const qname = segments.join(".");
  const head = segments[0]!;
  const rootModule = prefixBindings.get(head);
  if (rootModule === undefined) return { ok: false, why: "no-module", qname };
  // descend intermediate segments through re-exported whole prefixes (`facade.internal.Shape`).
  let currentModule = rootModule;
  for (let i = 1; i < segments.length - 1; i++) {
    const surface = publicSurfaceOf(currentModule, table);
    const nextModule = surface.prefixes.get(segments[i]!);
    if (nextModule === undefined) return { ok: false, why: "no-module", qname };
    currentModule = nextModule;
  }
  const member = segments[segments.length - 1]!;
  const mod = table.get(currentModule);
  if (!mod) return { ok: false, why: "no-module", qname };
  const ownEntry = mod.own.get(member);
  const surface = publicSurfaceOf(currentModule, table);
  const pubEntry = surface.members.get(member);
  if (!ownEntry && !pubEntry) return { ok: false, why: "no-member", qname };
  if (pubEntry) return { ok: true, decl: pubEntry.decl, pub: true, qname: pubEntry.qname };
  // present in the module but NOT pub, and reached from ANOTHER module → VisibilityError (§19.4).
  return { ok: false, why: "private", qname: `${currentModule}.${member}` };
}

// Link the main program against its companion modules (§19.2). Runs cycle detection, resolves the main
// program's imports (raising ModuleError/VisibilityError on failure), scans for ambiguous bare uses, and
// checks every qualified cross-module reference in the main program for visibility. Returns the erased
// resolution map (qualified-decl table + bare bindings) that the checker and interpreter reuse (§19.1).
export function linkModules(program: A.Program, modules: ModuleInput[]): Resolution {
  const table = buildModuleTable(modules);
  const mainImports = program.imports ?? [];

  // (1) the main program's own `pub import` re-exports must also obey visibility (§19.2a). Register the
  // main program as a module so publicSurfaceOf can validate its pub imports (e.g. mod_pub_import_private_reject,
  // whose main file carries a `module facade;` header and a `pub import { Hidden } from internal`).
  if (mainImports.some((i) => i.pub)) {
    const own = new Map<string, { decl: A.Decl; pub: boolean }>();
    for (const d of program.decls) {
      if (d.kind === "instruction" || d.kind === "conformal") continue; // no exportable name
      own.set((d as { name: string }).name, { decl: d, pub: !!(d as { pub?: boolean }).pub });
    }
    const mainName = program.module ?? ROOT_MODULE;
    table.set(mainName, { name: mainName, program, own, imports: mainImports });
    publicSurfaceOf(mainName, table); // validates the main program's pub imports (throws on a private one)
  }

  // (2) cycle detection over the whole import graph.
  assertAcyclic(mainImports, table);

  // (3) resolve the main program's imports into prefix + bare bindings.
  const prefixBindings = new Map<string, string>(); // local prefix → module name (whole/alias imports)
  // per bare name, the qualified targets bound to it (selective imports + re-exports feeding the same name),
  // to detect an ambiguous bare reference (§19.2).
  const bareSources = new Map<string, Set<string>>();
  const bareBindings = new Map<string, string>();
  const qualifiedDecls = new Map<string, A.Decl>();

  const registerModuleDecls = (moduleName: string): void => {
    const mod = table.get(moduleName);
    if (!mod) return;
    for (const [simple, e] of mod.own) qualifiedDecls.set(`${moduleName}.${simple}`, e.decl);
  };

  for (const imp of mainImports) {
    if (imp.selective) {
      const mod = table.get(imp.module);
      if (!mod) throw moduleError(`unresolved import: module '${imp.module}' not found (§19.2)`);
      const surface = publicSurfaceOf(imp.module, table);
      for (const nm of imp.selective) {
        // existence FIRST (absent → ModuleError), then pub-ness (present-not-pub → VisibilityError).
        const ownEntry = mod.own.get(nm);
        const pubEntry = surface.members.get(nm);
        if (!ownEntry && !pubEntry) throw moduleError(`selective import of '${nm}' from '${imp.module}': no such export (§19.2)`);
        if (!pubEntry) throw visibilityError(`import of non-pub '${nm}' from '${imp.module}' (a private declaration is not importable, §19.4)`);
        bareBindings.set(nm, pubEntry.qname);
        (bareSources.get(nm) ?? bareSources.set(nm, new Set()).get(nm)!).add(imp.module);
        qualifiedDecls.set(pubEntry.qname, pubEntry.decl);
      }
    } else {
      const localPrefix = imp.alias ?? imp.module;
      if (!table.has(imp.module)) throw moduleError(`unresolved import: module '${imp.module}' not found (§19.2)`);
      prefixBindings.set(localPrefix, imp.module);
      registerModuleDecls(imp.module);
      // register re-exported whole sub-prefixes' decls too (for a nested `facade.internal.Shape`).
      const surface = publicSurfaceOf(imp.module, table);
      for (const [subPrefix, targetModule] of surface.prefixes) {
        registerModuleDecls(targetModule);
        // also key the nested-path decls under the local.subPrefix.member form (facade.internal.Shape).
        const subMod = table.get(targetModule);
        if (subMod) for (const [simple, e] of subMod.own) qualifiedDecls.set(`${localPrefix}.${subPrefix}.${simple}`, e.decl);
      }
      for (const e of surface.members.values()) qualifiedDecls.set(`${localPrefix}.${(e.decl as { name: string }).name}`, e.decl);
    }
  }

  // (4) ambiguous bare reference: a bare name bound by 2+ sources AND used UNQUALIFIED (§19.2).
  const usedBare = collectBareUses(program);
  for (const [nm, sources] of bareSources) {
    if (sources.size >= 2 && usedBare.has(nm)) {
      throw moduleError(`ambiguous bare reference '${nm}': bound by ${[...sources].join(" and ")}; qualify it (§19.2)`);
    }
  }

  // (5) cross-module NAME visibility: every qualified reference in the main program must resolve to a
  // PUB member of the named module (§19.4). module-absent → ModuleError, member-absent → ModuleError,
  // member-present-not-pub → VisibilityError. A dotted name whose head is NOT an imported prefix is left
  // alone (an ordinary member expression, not a cross-module reference).
  for (const ref of collectQualifiedRefs(program)) {
    const segments = ref.split(".");
    if (segments.length < 2) continue;
    if (!prefixBindings.has(segments[0]!)) continue; // not a module prefix — an ordinary member access
    const r = resolveQualified(segments, prefixBindings, table);
    if (!r.ok) {
      if (r.why === "private") throw visibilityError(`'${r.qname}' is a module-private declaration and cannot be named from another module (§19.4)`);
      throw moduleError(`unresolved qualified reference '${r.qname}' (§19.2)`);
    }
    qualifiedDecls.set(ref, r.decl);
  }

  return { qualifiedDecls, bareBindings };
}

// Collect the bare identifiers USED UNQUALIFIED anywhere in the main program (call/ident/type/etype), so
// an ambiguous selective binding only errors when actually referenced by its bare name (§19.2).
function collectBareUses(program: A.Program): Set<string> {
  const out = new Set<string>();
  const addType = (t: A.TypeRef): void => {
    if (t.kind === "named" && !t.name.includes(".")) out.add(t.name);
    if (t.kind === "array" || t.kind === "event" || t.kind === "endorsement" || t.kind === "task") addType(t.inner);
    if (t.kind === "named" && t.typeArgs) for (const a of t.typeArgs) addType(a);
  };
  const addExpr = (e: A.Expr): void => {
    switch (e.kind) {
      case "ident": out.add(e.name); return;
      case "call": addExpr(e.callee); for (const a of e.args) addExpr(a); return;
      case "member": addExpr(e.obj); return;
      case "binary": addExpr(e.left); addExpr(e.right); return;
      case "unary": addExpr(e.operand); return;
      case "structlit": if (e.typeName && !e.typeName.includes(".")) out.add(e.typeName); for (const f of e.fields) addExpr(f.value); return;
      case "send": addExpr(e.dest); addExpr(e.message); return;
      case "recall": addExpr(e.mem); addExpr(e.query); return;
      case "decide": addExpr(e.credence); return;
      case "endorse": addExpr(e.subject); addExpr(e.decision); return;
      case "fstring": for (const p of e.parts) if (p.kind === "expr") addExpr(p.expr); return;
      case "agg": for (const o of e.operands) addExpr(o); return;
      case "quorum": addExpr(e.source); return;
      case "pipe": addExpr(e.source); addExpr(e.fn); return;
      case "arraylit": for (const it of e.items) addExpr(it); return;
      default: return;
    }
  };
  const addStmts = (stmts: A.Stmt[]): void => { for (const s of stmts) addStmt(s); };
  const addStmt = (s: A.Stmt): void => {
    switch (s.kind) {
      case "var": addType(s.type); if (s.init) addExpr(s.init); return;
      case "assign": addExpr(s.target); addExpr(s.value); return;
      case "say": addExpr(s.arg); return;
      case "return": if (s.value) addExpr(s.value); return;
      case "exprstmt": addExpr(s.expr); return;
      case "emit": case "perform": if (!s.name.includes(".")) out.add(s.name); for (const a of s.args) addExpr(a); return;
      case "spawn": if (!s.agentType.includes(".")) out.add(s.agentType); for (const a of s.args) addExpr(a); return;
      case "if": addExpr(s.cond); addStmts(s.then); if (s.else) addStmts(s.else); return;
      case "when": if (!s.etype.includes(".")) out.add(s.etype); addStmts(s.body); return;
      case "retry": addStmts(s.body); return;
      case "dispatch":
        if (s.gate.kind === "decide") addExpr(s.gate.credence); else { addExpr(s.gate.subject); addExpr(s.gate.decision); }
        for (const arm of s.arms) addStmts(arm.body); if (s.abstain) addStmts(s.abstain.body); return;
      case "memdecl": if (s.init) addExpr(s.init); return;
      default: return;
    }
  };
  for (const d of program.decls) {
    if (d.kind === "agent") {
      for (const h of d.hooks) addStmts(h.body);
      for (const w of d.whens) { if (!w.etype.includes(".")) out.add(w.etype); addStmts(w.body); }
      addStmts(d.ctor);
    } else if (d.kind === "fn") addStmts(d.body);
  }
  addStmts(program.stmts);
  return out;
}

// Collect every DOTTED reference in the main program (a qualified type/etype/spawn/emit/perform/reach/
// extend target, or a qualified struct-literal head). Used for the §19.4 cross-module visibility check.
function collectQualifiedRefs(program: A.Program): Set<string> {
  const out = new Set<string>();
  const addName = (n: string): void => { if (n.includes(".")) out.add(n); };
  const addType = (t: A.TypeRef): void => {
    if (t.kind === "named") { addName(t.name); if (t.typeArgs) for (const a of t.typeArgs) addType(a); }
    if (t.kind === "array" || t.kind === "event" || t.kind === "endorsement" || t.kind === "task") addType(t.inner);
  };
  // Flatten an ident-rooted member chain (`util.secretFn`, `facade.internal.f`) to its dotted name, so a
  // QUALIFIED reference — including a qualified CALLEE `util.secretFn(..)` — is submitted to the §19.4
  // visibility gate. Mirrors interp.qualifiedCallee. Returns undefined for a non-ident-rooted access
  // (an ordinary value member expression like `point.x`), whose head is checked separately via addExpr.
  const dottedName = (e: A.Expr): string | undefined => {
    const segs: string[] = [];
    let cur: A.Expr = e;
    while (cur.kind === "member") { segs.unshift(cur.field); cur = cur.obj; }
    if (cur.kind !== "ident") return undefined;
    segs.unshift(cur.name);
    return segs.length >= 2 ? segs.join(".") : undefined;
  };
  const addExpr = (e: A.Expr): void => {
    switch (e.kind) {
      case "structlit": if (e.typeName) addName(e.typeName); for (const f of e.fields) addExpr(f.value); return;
      case "call": {
        // A qualified callee (`util.secretFn(..)`) is a cross-module reference and must be visibility-gated;
        // flatten the member chain to its dotted name. If the callee is not an ident-rooted chain it is an
        // ordinary expression callee — recurse as before. Always visit the arguments.
        const d = dottedName(e.callee);
        if (d) addName(d); else addExpr(e.callee);
        for (const a of e.args) addExpr(a);
        return;
      }
      case "member": {
        // A bare qualified member reference (`util.pubFn` used as a value, `mod.CONST`) is likewise a
        // cross-module name; flatten it. A non-ident-rooted access (`point.x`) recurses into its object.
        const d = dottedName(e);
        if (d) addName(d); else addExpr(e.obj);
        return;
      }
      case "binary": addExpr(e.left); addExpr(e.right); return;
      case "unary": addExpr(e.operand); return;
      case "send": addExpr(e.dest); addExpr(e.message); return;
      case "recall": addExpr(e.mem); addExpr(e.query); return;
      case "decide": addExpr(e.credence); return;
      case "endorse": addExpr(e.subject); addExpr(e.decision); return;
      case "fstring": for (const p of e.parts) if (p.kind === "expr") addExpr(p.expr); return;
      case "agg": for (const o of e.operands) addExpr(o); return;
      case "quorum": addExpr(e.source); return;
      case "pipe": addExpr(e.source); addExpr(e.fn); return;
      case "arraylit": for (const it of e.items) addExpr(it); return;
      default: return;
    }
  };
  const addStmts = (stmts: A.Stmt[]): void => { for (const s of stmts) addStmt(s); };
  const addStmt = (s: A.Stmt): void => {
    switch (s.kind) {
      case "var": addType(s.type); if (s.init) addExpr(s.init); return;
      case "assign": addExpr(s.target); addExpr(s.value); return;
      case "say": addExpr(s.arg); return;
      case "return": if (s.value) addExpr(s.value); return;
      case "exprstmt": addExpr(s.expr); return;
      case "emit": case "perform": addName(s.name); for (const a of s.args) addExpr(a); return;
      case "spawn": addName(s.agentType); for (const a of s.args) addExpr(a); return;
      case "if": addExpr(s.cond); addStmts(s.then); if (s.else) addStmts(s.else); return;
      case "when": addName(s.etype); addStmts(s.body); return;
      case "retry": addStmts(s.body); return;
      case "dispatch":
        if (s.gate.kind === "decide") addExpr(s.gate.credence); else { addExpr(s.gate.subject); addExpr(s.gate.decision); }
        for (const arm of s.arms) addStmts(arm.body); if (s.abstain) addStmts(s.abstain.body); return;
      case "memdecl": if (s.init) addExpr(s.init); return;
      default: return;
    }
  };
  for (const d of program.decls) {
    if (d.kind === "agent") {
      // an agent's grants (reach/perform/use targets), its extend base, its fields, and its when/hook bodies.
      if (Array.isArray(d.grants)) for (const g of d.grants) addName(g.name);
      if (d.extends) addName(d.extends.name);
      for (const f of d.fields) addType(f.type);
      for (const p of d.params) addType(p.type);
      for (const h of d.hooks) addStmts(h.body);
      for (const w of d.whens) { addName(w.etype); addStmts(w.body); }
      addStmts(d.ctor);
    } else if (d.kind === "fn") { addType(d.ret); for (const p of d.params) addType(p.type); addStmts(d.body); }
    else if (d.kind === "struct") for (const f of d.fields) addType(f.type);
    else if (d.kind === "action" || d.kind === "event") for (const f of d.fields) addType(f.type);
  }
  addStmts(program.stmts);
  return out;
}

export function check(program: A.Program, modules?: ModuleInput[], manifest?: Manifest, strictConfig?: boolean): void {
  // §17 configuration validation (ConfigError). The `policy`/fallback_temperature rules fire on any manifest.
  // The §17.1 dependency-BINDING check is enabled by `strictConfig` — the harness runs the configuration
  // section in configured/strict mode, where every declared `principal`/`prompt`/`tool` dependency MUST have a
  // manifest binding; elsewhere a declared dependency is auto-bound to a mock default (the compiler stays
  // general — only the harness maps the config section to strict mode).
  const requireBinding = (kind: "principal" | "prompt", bindings: Record<string, BindingConfig> | undefined, name: string, missingMsg: string): void => {
    const hasEntry = bindings && Object.prototype.hasOwnProperty.call(bindings, name);
    if (strictConfig && !hasEntry) throw configError(missingMsg);
    if (hasEntry && !hasConfiguredBinding(bindings, name)) {
      throw configError(`${kind} '${name}' has a manifest binding but no required driver field (§17.1)`);
    }
  };
  for (const d of program.decls) {
    if (d.kind === "principal") {
      requireBinding(
        "principal",
        manifest?.identity,
        d.name,
        `principal '${d.name}' is a declared dependency (§3) with no configured identity binding — an unbound declared dependency is a ConfigError (§17.1)`,
      );
    }
    if (d.kind === "prompt") {
      requireBinding(
        "prompt",
        manifest?.prompts,
        d.name,
        `prompt '${d.name}' is a declared dependency (§5b) with no configured binding — an unbound declared dependency is a ConfigError (§17.1)`,
      );
    }
  }
  if (manifest?.policy && Object.keys(manifest.policy).length > 0) {
    // §17.2: decision policy is a SOURCE construct (`policy NAME { … }`), never a manifest binding.
    throw configError(`the manifest sets a decision policy (${Object.keys(manifest.policy).join(", ")}); a decision policy lives in source, never the manifest (§17.2)`);
  }
  const ingressPolicy = manifest?.security?.tainted_ingress_to_provider;
  if (ingressPolicy !== undefined && !["warn", "deny", "off"].includes(String(ingressPolicy))) {
    throw configError(`[security] tainted_ingress_to_provider must be "warn", "deny", or "off"`);
  }
  const pc = manifest?.provider;
  if (pc && pc.exposes_logprobs === false && pc.temperature === 0 && pc.fallback_temperature === undefined) {
    // §17/§16.8: a text-only provider (no logprobs) at temperature 0 has no variance for the sampling
    // fallback's forced draws, so it MUST configure a fallback_temperature — omitting it is a ConfigError.
    throw configError(`a text-only provider (exposes_logprobs=false) at temperature 0 requires a fallback_temperature for the sampling fallback (§17)`);
  }
  // §19.2 module linking: resolve the main program's imports against the companion modules the harness
  // supplied. Raises ModuleError/VisibilityError on a bad import (cycle, unresolved, unknown/private
  // member, ambiguous bare use, cross-module private reference) and returns the erased resolution map.
  const resolution = modules && (modules.length > 0 || (program.imports?.length ?? 0) > 0)
    ? linkModules(program, modules)
    : (program.imports?.length ? linkModules(program, []) : undefined);
  const decls: Decls = {
    enums: new Map([["bool", ["true", "false"]], ["Basis", ["Threshold", "Conformal", "Principal"]], ["Entailment", ["Entails", "Contradicts", "Neutral"]]]),
    structs: new Map(),
    actions: new Map(), actionReversible: new Map(), events: new Map(), agents: new Map(),
    interfaces: new Map(), pub: new Map(), fns: new Map(),
    principals: new Set(), prompts: new Set(),
  };
  for (const d of program.decls) {
    if (d.kind === "enum") decls.enums.set(d.name, d.variants);
    else if (d.kind === "struct") decls.structs.set(d.name, d);
    else if (d.kind === "action") { decls.actions.set(d.name, d.fields); decls.actionReversible.set(d.name, d.reversible); }
    else if (d.kind === "event") decls.events.set(d.name, d.fields);
    else if (d.kind === "agent") decls.agents.set(d.name, d);
    else if (d.kind === "interface") decls.interfaces.set(d.name, d);
    else if (d.kind === "fn") decls.fns.set(d.name, d);
    else if (d.kind === "principal") decls.principals.add(d.name);
    else if (d.kind === "prompt") decls.prompts.add(d.name);
    // record each user declaration's visibility (§19.4) for the shallow-export check. `instruction` and
    // the file-level `conformal` decl carry no exportable name, so they are skipped.
    if (d.kind !== "instruction" && d.kind !== "conformal") decls.pub.set(d.name, !!(d as { pub?: boolean }).pub);
  }
  // §19.2: feed the resolved cross-module declarations into the decl tables so shape checks (struct-lit
  // field arity, emit/perform arity, a call to an imported fn) work for qualified constructors/events and
  // for selectively-imported bare names. The linker keyed them by qualified name (`util.dbl`, `a.Tick`,
  // `geometry.Shape`) AND, for a selective import, by the bound bare name (`dbl` → `util.dbl`). Registered
  // names are already visibility-checked, so they are all admissible references.
  if (resolution) {
    const register = (name: string, d: A.Decl): void => {
      if (d.kind === "enum") decls.enums.set(name, d.variants);
      else if (d.kind === "struct") decls.structs.set(name, d);
      else if (d.kind === "action") { decls.actions.set(name, d.fields); decls.actionReversible.set(name, d.reversible); }
      else if (d.kind === "event") decls.events.set(name, d.fields);
      else if (d.kind === "agent") decls.agents.set(name, d);
      else if (d.kind === "interface") decls.interfaces.set(name, d);
      else if (d.kind === "fn") decls.fns.set(name, d);
      // an imported name is public by construction; mark it so the shallow-export check treats it as exempt.
      if (d.kind !== "instruction") decls.pub.set(name, true);
    };
    for (const [qname, d] of resolution.qualifiedDecls) register(qname, d);
    for (const [bare, qname] of resolution.bareBindings) {
      const d = resolution.qualifiedDecls.get(qname);
      if (d) register(bare, d);
    }
  }
  // the set of interface names implemented by SOME agent in the program (`agent X : Iface, …`). A `pub`
  // interface backed by an implementing agent names that agent's existing (module-private) surface rather
  // than introducing a fresh public one, so its event/outcome types are not an independent export (§19.4/§19.5).
  const implemented = new Set<string>();
  for (const d of program.decls) {
    if (d.kind === "agent") for (const i of d.ifaces ?? []) implemented.add(i);
  }
  // §6b/§17.1 wiring validation (STRICT/configured mode only, like dependency binding): a Studio root
  // manifest is shared by every program under it, so an entry wiring a name THIS program does not
  // declare is simply unused elsewhere — only the configuration harness runs with full lockstep.
  const validateWiring = (kind: "actions" | "events", entries: Record<string, WiringConfig> | undefined): void => {
    if (!strictConfig) return;
    for (const [name, w] of Object.entries(entries ?? {})) {
      const declared = kind === "actions" ? decls.actions.has(name) : decls.events.has(name) || BUILTIN_EVENTS.has(name);
      if (!declared) throw configError(`[${kind}.${name}] wires an undeclared ${kind === "actions" ? "action" : "event"} — wiring must reference a declared name (§6b, §17.1)`);
      if (w.tool !== undefined) {
        if (!(manifest?.tools && Object.prototype.hasOwnProperty.call(manifest.tools, String(w.tool)))) {
          throw configError(`[${kind}.${name}] references catalog entry [tools.${w.tool}], which is not configured (§6b, §17.1)`);
        }
        // a referenced catalog entry must name its driver; connector-specific fields are not enough (§17.1).
        if (!hasConfiguredBinding(manifest.tools, String(w.tool))) {
          throw configError(`[tools.${w.tool}] (referenced by [${kind}.${name}]) has no required driver field (§17.1)`);
        }
      }
      if (w.result_event !== undefined && !decls.events.has(String(w.result_event))) {
        throw configError(`[${kind}.${name}] names result_event '${w.result_event}', which is not a declared event (§6b, §17.1)`);
      }
    }
  };
  validateWiring("actions", manifest?.actions);
  validateWiring("events", manifest?.events);
  const c = new Checker(decls, implemented, manifest);
  // static well-formedness of every declared/annotated type: a type argument applied to a non-generic
  // declaration is a TypeError (§19.5). Walk every type surface in the program before body checking.
  c.checkTypeSurfaces(program);
  for (const d of program.decls) {
    if (d.kind === "agent") c.checkAgent(d);
    else if (d.kind === "fn") c.checkFn(d);
    else if (d.kind === "interface") c.checkInterface(d);
    else if (d.kind === "struct") c.checkStructExport(d);
  }
  c.checkBody(program.stmts, new Scope());
  c.checkDeferenceFlow(program.stmts, new Scope());
  checkReturnPlacement(program);
  checkDenyModePromptIngress(program, manifest, decls.prompts);
}

// §4: `return` is honored in TAIL POSITION ONLY — the runtime (interp `callFn`) inspects only a
// function's top-level statements and acts on a `return` solely when it is the final one. A `return`
// anywhere else — nested inside an `if`/gate arm/`retry`, a non-final top-level statement, or in a
// non-function body (agent hook, `when`, constructor, top-level program) — is NEVER honored: its
// expression is not even evaluated and its value is silently discarded. That silent no-op is a
// correctness trap in a typed language (it once ate a demo author's recursion), so we reject it
// statically rather than let it misbehave at runtime. Whether the kernel should grow real
// early-return control flow is an open language-design question, deferred to the owner.
function checkReturnPlacement(program: A.Program): void {
  const complain = (): never => {
    throw typeError(
      "`return` is only honored in tail position — the final statement of a function body. " +
      "This `return` is not in that position, so the kernel would silently ignore it (its expression " +
      "is never evaluated and its value is discarded). The kernel has no early-return control flow: " +
      "assign to a result variable in each branch and `return` it as the last statement instead (§4).",
    );
  };
  // Walk a statement list. `allowTail` is true only for a function's own top-level statement list —
  // the sole place the runtime honors a `return`, and then only as the final element. Nested bodies
  // are always entered with `allowTail = false` because the runtime never looks inside them.
  const walk = (stmts: A.Stmt[], allowTail: boolean): void => {
    stmts.forEach((s, i) => {
      const isFinal = i === stmts.length - 1;
      if (s.kind === "return" && !(allowTail && isFinal)) complain();
      switch (s.kind) {
        case "if": walk(s.then, false); if (s.else) walk(s.else, false); break;
        case "retry": walk(s.body, false); break;
        case "when": walk(s.body, false); break;
        case "dispatch":
          for (const arm of s.arms) walk(arm.body, false);
          if (s.abstain) walk(s.abstain.body, false);
          break;
      }
    });
  };
  for (const d of program.decls) {
    if (d.kind === "fn") walk(d.body, true);
    else if (d.kind === "agent") {
      for (const h of d.hooks) walk(h.body, false);
      for (const w of d.whens) walk(w.body, false);
      walk(d.ctor, false);
    }
  }
  walk(program.stmts, false);
}

// §5b/§17 deny-mode provider-prompt ingress, statically (the T-Send/T-Credence premise
// `provider_ingress_policy(ι_p, manifest) ≠ deny`, §15.3.2): under [security]
// tainted_ingress_to_provider = "deny", a prompt arrival whose source has NO manifest-configured
// ingress screen delivers an `external_unscreened` value, so a send that interpolates it into a
// cognition prompt is rejected before it can reach the provider — a TaintViolation. A screened
// source ([security.ingress.prompts.NAME]) delivers `external_screened` values and passes.
// Conservative dataflow: the `when (Prompt p about NAME)` binder, and any local initialized from
// an expression that references it, carry the unscreened ingress. (The runtime deny check in the
// interpreter still guards flows this static walk cannot see.)
function checkDenyModePromptIngress(program: A.Program, manifest: Manifest | undefined, prompts: Set<string>): void {
  if (manifest?.security?.tainted_ingress_to_provider !== "deny") return;
  const screens = manifest.security.ingress?.prompts ?? {};
  const screened = (name: string) => Object.prototype.hasOwnProperty.call(screens, name);

  // whether an expression references an ingress-carrying binding (or contains a send that does).
  const refs = (e: A.Expr | undefined, tainted: Set<string>): boolean => {
    if (!e) return false;
    switch (e.kind) {
      case "ident": return tainted.has(e.name);
      case "member": return refs(e.obj, tainted);
      case "binary": return refs(e.left, tainted) || refs(e.right, tainted);
      case "unary": return refs(e.operand, tainted);
      case "call": return refs(e.callee, tainted) || e.args.some((a) => refs(a, tainted));
      case "fstring": return e.parts.some((p) => p.kind === "expr" && refs(p.expr, tainted));
      case "structlit": return e.fields.some((f) => refs(f.value, tainted));
      case "arraylit": return e.items.some((it) => refs(it, tainted));
      case "send": return refs(e.message, tainted);
      default: return false;
    }
  };

  // walk every expression under a subscribed handler; a send whose rendered prompt references
  // ingress-carrying data under deny mode is the violation.
  const inspectExpr = (e: A.Expr | undefined, tainted: Set<string>, source: string): void => {
    if (!e) return;
    if (e.kind === "send" && refs(e.message, tainted)) {
      throw taintViolation(
        `provider prompt renders external unscreened ingress from prompt '${source}' under [security] ` +
        `tainted_ingress_to_provider = "deny" — configure [security.ingress.prompts.${source}] screening, ` +
        `or change the policy (§5b, §17)`,
      );
    }
    switch (e.kind) {
      case "member": inspectExpr(e.obj, tainted, source); return;
      case "binary": inspectExpr(e.left, tainted, source); inspectExpr(e.right, tainted, source); return;
      case "unary": inspectExpr(e.operand, tainted, source); return;
      case "call": inspectExpr(e.callee, tainted, source); e.args.forEach((a) => inspectExpr(a, tainted, source)); return;
      case "fstring": e.parts.forEach((p) => { if (p.kind === "expr") inspectExpr(p.expr, tainted, source); }); return;
      case "structlit": e.fields.forEach((f) => inspectExpr(f.value, tainted, source)); return;
      case "arraylit": e.items.forEach((it) => inspectExpr(it, tainted, source)); return;
      case "send": inspectExpr(e.dest, tainted, source); inspectExpr(e.message, tainted, source); return;
      default: return;
    }
  };

  const inspectBody = (stmts: A.Stmt[], tainted: Set<string>, source: string): void => {
    for (const st of stmts) {
      switch (st.kind) {
        case "var":
          inspectExpr(st.init, tainted, source);
          if (st.init && refs(st.init, tainted)) tainted.add(st.name); // conservative propagation
          break;
        case "assign":
          inspectExpr(st.value, tainted, source);
          if (st.target.kind === "ident" && refs(st.value, tainted)) tainted.add(st.target.name);
          break;
        case "say": inspectExpr(st.arg, tainted, source); break;
        case "return": inspectExpr(st.value, tainted, source); break;
        case "exprstmt": inspectExpr(st.expr, tainted, source); break;
        case "emit": st.args.forEach((a) => inspectExpr(a, tainted, source)); break;
        case "perform": st.args.forEach((a) => inspectExpr(a, tainted, source)); break;
        case "if":
          inspectExpr(st.cond, tainted, source);
          inspectBody(st.then, new Set(tainted), source);
          if (st.else) inspectBody(st.else, new Set(tainted), source);
          break;
        case "when": inspectBody(st.body, new Set(tainted), source); break;
        case "retry": inspectBody(st.body, new Set(tainted), source); break; // §11: taint flows into the recovery block
        case "dispatch":
          for (const arm of st.arms) inspectBody(arm.body, new Set(tainted), source);
          if (st.abstain) inspectBody(st.abstain.body, new Set(tainted), source);
          break;
        default: break;
      }
    }
  };

  // find every `when (Prompt p about NAME)` handler over an UNSCREENED declared prompt source.
  const visitWhen = (w: A.WhenStmt): void => {
    if (w.etype === "Prompt" && w.binder && w.about?.kind === "ident" && prompts.has(w.about.name) && !screened(w.about.name)) {
      inspectBody(w.body, new Set([w.binder]), w.about.name);
    }
    scanForWhens(w.body);
  };
  const scanForWhens = (stmts: A.Stmt[]): void => {
    for (const st of stmts) {
      switch (st.kind) {
        case "when": visitWhen(st); break;
        case "if": scanForWhens(st.then); if (st.else) scanForWhens(st.else); break;
        case "retry": scanForWhens(st.body); break;
        case "dispatch": for (const arm of st.arms) scanForWhens(arm.body); if (st.abstain) scanForWhens(st.abstain.body); break;
        default: break;
      }
    }
  };
  scanForWhens(program.stmts);
  for (const d of program.decls) {
    if (d.kind !== "agent") continue;
    for (const w of d.whens) visitWhen(w);
    for (const h of d.hooks) scanForWhens(h.body);
    scanForWhens(d.ctor);
  }
}

function declClass(t: A.TypeRef): Cls {
  switch (t.kind) {
    case "scalar": return t.name;
    case "mem": return "mem";
    case "credence": return "credence";
    case "decision": return "decision";
    case "endorsement": return "endorsement";
    case "named": return "enum"; // enum/struct/agent — treated leniently
    case "array": return t.inner.kind === "credence" ? "credarray" : "unknown"; // narrow: array<Credence<…>>
    default: return "unknown"; // legacy event<>
  }
}

// two classes conflict only when BOTH are known and different (unknown is compatible with anything).
// `int` and `float` are numerically compatible (e.g. `int a = 2 + 3` where `+` widens to a number).
function conflicts(a: Cls, b: Cls): boolean {
  if (a === "unknown" || b === "unknown" || a === b) return false;
  const numeric = (c: Cls) => c === "int" || c === "float";
  if (numeric(a) && numeric(b)) return false;
  return true;
}

class Checker {
  constructor(private d: Decls, private implementedIfaces: Set<string> = new Set(), private manifest?: Manifest) {}

  // ---- §19.5 generics: a type argument may instantiate only a generic declaration ----

  // Walk every type surface in the program (declared field/param/return types, var/binding annotations,
  // and struct-literal type-names) and reject a type argument applied to a NON-generic referent.
  checkTypeSurfaces(program: A.Program): void {
    for (const d of program.decls) {
      switch (d.kind) {
        case "struct": for (const f of d.fields) this.checkTypeRef(f.type); break;
        case "event":
          // §19.5/§19.6: the ONLY permitted user-event supertype is the built-in `Error`. A non-`Error`
          // supertype (e.g. `event Bad(..) : Thing`) is a TypeError — it is well-formed syntax but names a
          // supertype the type system rejects. (An `action` supertype stays a ParseError, handled in the
          // parser: `action` has no supertype grammar.)
          if (d.superName !== undefined && d.superName !== "Error") {
            throw typeError(`event '${d.name}' declares supertype '${d.superName}'; the only permitted user-event supertype is the built-in 'Error' (§19.5)`);
          }
          for (const f of d.fields) this.checkTypeRef(f.type); break;
        case "action": for (const f of d.fields) this.checkTypeRef(f.type); break;
        case "prompt": this.checkTypeRef(d.type); break; // the sensor's element type (§5b)
        case "fn": this.checkTypeRef(d.ret); for (const f of d.params) this.checkTypeRef(f.type); this.walkStmts(d.body); break;
        case "interface":
          for (const m of d.members) if (m.kind === "handler") { this.checkTypeRef(m.event); this.checkTypeRef(m.outcome); }
          break;
        case "agent":
          for (const f of d.params) this.checkTypeRef(f.type);
          for (const f of d.fields) this.checkTypeRef(f.type);
          for (const h of d.hooks) this.walkStmts(h.body);
          for (const w of d.whens) this.walkStmts(w.body);
          this.walkStmts(d.ctor);
          break;
      }
    }
    this.walkStmts(program.stmts);
  }

  private walkStmts(stmts: A.Stmt[]): void {
    for (const s of stmts) this.walkStmt(s);
  }
  private walkStmt(s: A.Stmt): void {
    switch (s.kind) {
      case "var": this.checkTypeRef(s.type); if (s.init) this.walkExpr(s.init); return;
      case "assign": this.walkExpr(s.target); this.walkExpr(s.value); return;
      case "say": this.walkExpr(s.arg); return;
      case "return": if (s.value) this.walkExpr(s.value); return;
      case "exprstmt": this.walkExpr(s.expr); return;
      case "emit": case "perform": for (const a of s.args) this.walkExpr(a); return;
      case "spawn": for (const a of s.args) this.walkExpr(a); return;
      case "if": this.walkExpr(s.cond); this.walkStmts(s.then); if (s.else) this.walkStmts(s.else); return;
      case "when": this.walkStmts(s.body); return;
      case "retry": this.walkStmts(s.body); return; // §11: validate types inside the recovery block
      case "dispatch":
        this.walkGate(s.gate);
        for (const arm of s.arms) this.walkStmts(arm.body);
        if (s.abstain) this.walkStmts(s.abstain.body);
        return;
      case "memdecl": if (s.init) this.walkExpr(s.init); return;
      default: return;
    }
  }
  private walkGate(g: A.GateExpr): void {
    if (g.kind === "decide") { this.checkDecidePrincipal(g); this.walkExpr(g.credence); }
    else { this.walkExpr(g.subject); this.walkExpr(g.decision); }
  }

  // T-Decide-Principal (§13/§15.3.2): the escalation prefix `p` in `p decide c by r` must resolve to a
  // DECLARED `principal` (`Γ ⊢ p : Principal`). A `Principal` is constructed, never coerced — a `text`
  // value (or any other non-principal name) in the prefix position is a TypeError (§3: "a string in the
  // prefix position is a forgeable claim, not a credential"). Conservative: only fires for the explicit
  // prefix form; the `by p` rule form is disambiguated elsewhere (principalOfDecide) and an unknown name
  // there stays a policy reference.
  private checkDecidePrincipal(g: A.DecideExpr): void {
    if (g.principal !== undefined && !this.d.principals.has(g.principal)) {
      throw typeError(
        `'${g.principal} decide …': the escalation prefix must resolve to a declared \`principal\`, ` +
        `not an ordinary value — a \`Principal\` is a declared identity, never a \`text\` (§3, §13)`,
      );
    }
  }
  private walkExpr(e: A.Expr): void {
    switch (e.kind) {
      case "structlit":
        if (e.typeName && e.typeArgs) {
          for (const a of e.typeArgs) this.checkTypeRef(a);
          this.checkInstantiation(e.typeName);
        }
        for (const f of e.fields) this.walkExpr(f.value);
        return;
      case "member": this.walkExpr(e.obj); return;
      case "binary": this.walkExpr(e.left); this.walkExpr(e.right); return;
      case "unary": this.walkExpr(e.operand); return;
      case "call": this.walkExpr(e.callee); for (const a of e.args) this.walkExpr(a); return;
      case "send": this.walkExpr(e.dest); this.walkExpr(e.message); return;
      case "recall": this.walkExpr(e.mem); this.walkExpr(e.query); return;
      case "decide": this.checkDecidePrincipal(e); this.walkExpr(e.credence); return;
      case "endorse": this.walkExpr(e.subject); this.walkExpr(e.decision); return;
      case "fstring": for (const p of e.parts) if (p.kind === "expr") this.walkExpr(p.expr); return;
      case "agg": for (const o of e.operands) this.walkExpr(o); return;
      case "quorum": this.walkExpr(e.source); return;
      case "pipe": this.walkExpr(e.source); this.walkExpr(e.fn); return;
      case "arraylit": for (const it of e.items) this.walkExpr(it); return;
      case "tasklit": if (e.objective) this.walkExpr(e.objective); if (e.acceptance) this.walkExpr(e.acceptance); return;
      case "performexpr": for (const a of e.args) this.walkExpr(a); if (e.expires) this.walkExpr(e.expires); return;
      default: return;
    }
  }

  // a `named` type surface: recurse into its type arguments, then check the head instantiation.
  private checkTypeRef(t: A.TypeRef): void {
    if (t.kind === "named") {
      // §3: `Rule` is the gate PARAMETER (`confidence θ` / `conformal α` / a named `policy`), NOT a first-class
      // user-declared storage type — a `Rule`-typed binding (`Rule r = …`) is a TypeError.
      if (t.name === "Rule") throw typeError(`'Rule' is the gate parameter, not a first-class storage type — it cannot be stored in a binding (§3)`);
      if (t.typeArgs) {
        for (const a of t.typeArgs) this.checkTypeRef(a);
        if (t.name === "LedgerEntry") {
          if (t.typeArgs.length !== 1) throw typeError("LedgerEntry takes exactly one event type argument");
        } else {
          this.checkInstantiation(t.name);
        }
      }
      return;
    }
    if (t.kind === "array" || t.kind === "event" || t.kind === "endorsement" || t.kind === "task") this.checkTypeRef(t.inner);
  }

  // A type argument list `<…>` may instantiate ONLY a generic `struct` (the sole generic type-declaration
  // kind — `fn` generics apply at call sites, and enums/agents/interfaces are never generic, §19.5). A
  // type argument applied to a KNOWN non-generic declaration is a TypeError. Conservative: an UNKNOWN name
  // is left unchecked, and a generic struct is accepted without arity-checking (v0 monomorphizes leniently).
  private checkInstantiation(name: string): void {
    const struct = this.d.structs.get(name);
    if (struct) {
      if (!struct.typarams || struct.typarams.length === 0) {
        throw typeError(`'${name}' is not generic — a type argument cannot be applied to a non-generic declaration (§19.5)`);
      }
      return; // a generic struct — accepted (v0 does not arity-check)
    }
    // a known NON-struct declaration (enum/agent/interface/action/event) is never generic.
    if (this.d.enums.has(name) || this.d.agents.has(name) || this.d.interfaces.has(name) ||
        this.d.actions.has(name) || this.d.events.has(name)) {
      throw typeError(`'${name}' is not generic — a type argument cannot be applied to a non-generic declaration (§19.5)`);
    }
    // an unknown name — leave unchecked (conservative; never a false reject).
  }

  checkAgent(a: A.AgentDecl): void {
    // §6b/§13: grants are exactly `perform` and `reach`. The legacy `use` class parses (for a clean
    // diagnostic) but names no power — tools left the language; observation is wired in the manifest.
    if (Array.isArray(a.grants)) {
      for (const g of a.grants) {
        if (g.cap === "use") {
          throw typeError(`agent '${a.name}': 'use ${g.name}' — the \`use\` grant class no longer exists; grants are \`perform\` and \`reach\` (tools live in the manifest catalog, §6b, §13)`);
        }
      }
    }
    if (a.extends) this.checkSubtractiveGrants(a);
    for (const h of a.hooks) { this.checkBody(h.body, new Scope()); this.checkDeferenceFlow(h.body, new Scope()); }
    for (const w of a.whens) {
      const s = new Scope();
      if (w.binder) s.set(w.binder, "unknown"); // the matched event payload
      this.checkBody(w.body, s);
      this.checkDeferenceFlow(w.body, new Scope());
    }
    this.checkNominalConformance(a);
    this.checkAgentExport(a);
  }

  // ---- §19.5 nominal interface conformance ----

  // For each interface an agent declares (`agent PM : Iface, …`), the compiler checks that the agent has a
  // matching `when (Event …)` handler for every `when Event decide Result` member, that a handler which
  // DEMONSTRABLY produces a decision produces one over the declared Result enum, and that every `requires
  // cap` member is in the agent's grants. Any failure is an InterfaceError (§19.5). Conservative: an unknown
  // interface is skipped, and the outcome check fires only when a decision is demonstrably produced.
  private checkNominalConformance(a: A.AgentDecl): void {
    for (const ifaceName of a.ifaces ?? []) {
      const iface = this.d.interfaces.get(ifaceName);
      if (!iface) continue; // unknown interface — leave to other passes; do not false-reject
      for (const m of iface.members) {
        if (m.kind === "handler") {
          const eventName = m.event.kind === "named" ? m.event.name : undefined;
          if (eventName === undefined) continue; // non-nominal event surface — conservative
          const handler = a.whens.find((w) => w.etype === eventName);
          if (!handler) {
            throw interfaceError(`agent '${a.name}' declares interface '${ifaceName}' but has no 'when (${eventName} …)' handler for its 'when ${eventName} decide …' member (§19.5)`);
          }
          // Outcome check (§19.5: the handler must produce a `B` decision). We collect the SET of enums the
          // handler demonstrably decides over — every explicit `Decision<E>` binding AND every inline `decide`
          // gate (a `dispatch`/exprstmt/loosely-bound `decide c by …`, whose enum is `c`'s). The handler
          // CONFORMS iff it produces at least one decision over the required enum; it VIOLATES only when it
          // demonstrably produces decision(s) but NONE over `B` (so a correct top-level `Decision<B>` alongside
          // an incidental nested `Decision<S>` helper is NOT a violation — that was the false-reject). An empty
          // set (no demonstrable decision — e.g. a handler that merely `say(...)`s) stays conservative: no error.
          const wantEnum = m.outcome.kind === "named" ? m.outcome.name : undefined;
          const produced = this.decisionEnumsOf(handler);
          const knownProduced = [...produced].filter((e) => this.d.enums.has(e));
          if (wantEnum !== undefined && this.d.enums.has(wantEnum) &&
              knownProduced.length > 0 && !produced.has(wantEnum)) {
            const shown = knownProduced.join(", ");
            throw interfaceError(`agent '${a.name}': handler 'when (${eventName} …)' produces a Decision over {${shown}}, but interface '${ifaceName}' requires 'decide ${wantEnum}' (§19.5)`);
          }
        } else {
          // `requires cap NAME` — must be in the agent's grants (grants "all" satisfies everything).
          const g = a.grants;
          const satisfied = g === "all" || g.some((x) => x.cap === m.cap && x.name === m.name);
          if (!satisfied) {
            throw interfaceError(`agent '${a.name}' declares interface '${ifaceName}' which requires '${m.cap} ${m.name}', but the agent's grants do not include it (§19.5)`);
          }
        }
      }
    }
  }

  // The SET of enums a when-handler DEMONSTRABLY decides over: scan its statements — INCLUDING nested blocks
  // (an `if`/`else` branch, a gate arm/abstain body, a nested `when` body) — for every decision it produces.
  // A handler produces a `Decision<E>` in two forms, BOTH counted here so neither can hide a mismatch nor
  // cause a false-reject (§19.5 conformance is a property of the handler as a whole):
  //   (1) an EXPLICIT decision-typed binding `Decision<E> d = …`  (E = the annotation's enum), and
  //   (2) an INLINE `decide c by …` gate — as a `dispatch` gate, a bare exprstmt, or a loosely-typed var
  //       initializer — whose enum is that of the credence `c` being decided.
  // To resolve (2) we thread a name→enum environment of the credence/decision bindings seen so far in the
  // handler (a bare `decide c …` reads `c`'s recorded enum). Nested-block bindings are visible to the scan
  // (a conservative superset), which is safe: we only ever ADD to the produced-enum set, and the caller
  // treats the set membership, not order — a correct `Decision<B>` anywhere makes the handler conform, and a
  // demonstrable decision over some OTHER enum with no `B` at all is the only violation. An empty set stays
  // conservative (no error): a handler that merely `say(...)`s produces nothing to check.
  private decisionEnumsOf(w: A.WhenStmt): Set<string> {
    const out = new Set<string>();
    const env = new Map<string, string>(); // ident → the enum of a Credence/Decision binding in scope
    this.scanDecisionEnums(w.body, env, out);
    return out;
  }
  private scanDecisionEnums(stmts: A.Stmt[], env: Map<string, string>, out: Set<string>): void {
    for (const s of stmts) this.scanDecisionEnumStmt(s, env, out);
  }
  // The enum an inline `decide` gate decides over: the enum of the credence being decided. A bare credence
  // identifier resolves through the name→enum environment; any other credence form is anonymous (undefined).
  private decideGateEnum(g: A.GateExpr, env: Map<string, string>): string | undefined {
    if (g.kind !== "decide") return undefined;
    const c = g.credence;
    return c.kind === "ident" ? env.get(c.name) : undefined;
  }
  private scanDecisionEnumStmt(s: A.Stmt, env: Map<string, string>, out: Set<string>): void {
    switch (s.kind) {
      case "var": {
        // (1) an explicit `Decision<E>` binding: E is a produced outcome.
        if (s.type.kind === "decision") out.add(s.type.enumName);
        // record the enum of any Credence/Decision binding for later inline-`decide` resolution.
        if (s.type.kind === "credence" || s.type.kind === "decision") env.set(s.name, s.type.enumName);
        // (2) an inline `decide c by …` in the initializer (even when the slot is NOT `Decision<E>`-typed):
        // it still produces a decision over c's enum.
        if (s.init && s.init.kind === "decide") {
          const e = this.decideGateEnum(s.init, env);
          if (e !== undefined) out.add(e);
        }
        return;
      }
      case "assign":
        if (s.value.kind === "decide") {
          const e = this.decideGateEnum(s.value, env);
          if (e !== undefined) out.add(e);
        }
        return;
      case "exprstmt":
        if (s.expr.kind === "decide") {
          const e = this.decideGateEnum(s.expr, env);
          if (e !== undefined) out.add(e);
        }
        return;
      case "if":
        this.scanDecisionEnums(s.then, env, out);
        if (s.else) this.scanDecisionEnums(s.else, env, out);
        return;
      case "dispatch": {
        // (2) the dispatch's OWN gate, when it is an inline `decide c by …`, produces a decision.
        const e = this.decideGateEnum(s.gate, env);
        if (e !== undefined) out.add(e);
        for (const arm of s.arms) this.scanDecisionEnums(arm.body, env, out);
        if (s.abstain) this.scanDecisionEnums(s.abstain.body, env, out);
        return;
      }
      case "when":
        this.scanDecisionEnums(s.body, env, out);
        return;
      case "retry":
        this.scanDecisionEnums(s.body, env, out);
        return;
      default:
        return;
    }
  }

  // §19.5 interface subtyping: an interface-typed binding (`Iface x = v;`) accepts ONLY an implementor of
  // that interface. When the initializer's concrete agent type is statically known (a spawned/aliased
  // instance) and that agent does NOT declare the interface, binding it into the slot is an InterfaceError —
  // "an interface-typed binding accepts any implementor," and a non-implementor is not one. Conservative:
  // fires only over a KNOWN interface type and a KNOWN agent source that provably lacks it; any unknown
  // source (a param, a query, a cross-scope value) is admitted so no accept binding is false-rejected.
  private checkInterfaceBinding(type: A.TypeRef, init: A.Expr, scope: Scope): void {
    if (type.kind !== "named") return;
    const iface = this.d.interfaces.get(type.name);
    if (!iface) return; // not an interface-typed slot (an agent/struct/enum slot) — nothing to enforce here
    if (init.kind !== "ident") return; // only a bare binding has a statically-known concrete agent source
    const srcType = scope.getAgentType(init.name);
    if (srcType === undefined) return; // source's concrete type unknown — conservative, admit
    const srcAgent = this.d.agents.get(srcType);
    if (!srcAgent) return; // unknown agent decl — conservative
    if (!(srcAgent.ifaces ?? []).includes(type.name)) {
      throw interfaceError(
        `agent '${srcType}' does not implement interface '${type.name}', so it cannot be bound to the ` +
        `'${type.name}'-typed slot '${init.name}' — an interface-typed binding accepts only an implementor (§19.5)`,
      );
    }
  }

  // ---- §19.4 shallow visibility ----

  // Whether a type surface names a PRIVATE user declaration (a name declared without `pub`). Built-in roots
  // (Error/Event/Principal, scalars, mem, gate wrappers) and unknown names are exempt (return false).
  private namesPrivate(t: A.TypeRef): boolean {
    switch (t.kind) {
      case "named": {
        if (t.typeArgs && t.typeArgs.some((a) => this.namesPrivate(a))) return true;
        const isPub = this.d.pub.get(t.name);
        return isPub === false; // declared and NOT pub; unknown/built-in (undefined) is exempt
      }
      case "array": case "event": case "endorsement": case "task": return this.namesPrivate(t.inner);
      default: return false;
    }
  }

  // §19.4 shallow visibility: an interface is public via `pub`. A `pub interface` may not expose a private
  // surface — every handled event type, every decided outcome type, and every `requires`-cap target that
  // names a module-private user declaration is a VisibilityError.
  checkInterface(iface: A.InterfaceDecl): void {
    if (!iface.pub) return; // a private interface exposes nothing across a module boundary
    // an interface backed by an implementing agent merely names that agent's existing module-private
    // surface; only an UNREALIZED pub interface introduces a fresh public event/outcome export (§19.4/§19.5).
    const backed = this.implementedIfaces.has(iface.name);
    for (const m of iface.members) {
      if (m.kind === "handler") {
        if (!backed && this.namesPrivate(m.event)) {
          throw visibilityError(`pub interface '${iface.name}' handles a private event type '${this.typeName(m.event)}' (pub is shallow, §19.4)`);
        }
        if (!backed && this.namesPrivate(m.outcome)) {
          throw visibilityError(`pub interface '${iface.name}' decides a private outcome type '${this.typeName(m.outcome)}' (pub is shallow, §19.4)`);
        }
      } else {
        // a `requires cap NAME` whose target is a private user declaration.
        if (this.d.pub.get(m.name) === false) {
          throw visibilityError(`pub interface '${iface.name}' requires '${m.cap} ${m.name}', a private capability target (pub is shallow, §19.4)`);
        }
      }
    }
  }

  // §19.4 shallow export for a `pub struct`: no field type may name a private user declaration.
  checkStructExport(s: A.StructDecl): void {
    if (!s.pub) return;
    for (const f of s.fields) {
      if (this.namesPrivate(f.type)) {
        throw visibilityError(`pub struct '${s.name}' exposes a private field type '${this.typeName(f.type)}' via field '${f.name}' (pub is shallow, §19.4)`);
      }
    }
  }

  // §19.4 shallow export for a `pub fn`: no parameter or return type may name a private user declaration.
  private checkFnExport(f: A.FnDecl): void {
    if (!f.pub) return;
    if (this.namesPrivate(f.ret)) {
      throw visibilityError(`pub fn '${f.name}' returns a private type '${this.typeName(f.ret)}' (pub is shallow, §19.4)`);
    }
    for (const p of f.params) {
      if (this.namesPrivate(p.type)) {
        throw visibilityError(`pub fn '${f.name}' takes a private parameter type '${this.typeName(p.type)}' via '${p.name}' (pub is shallow, §19.4)`);
      }
    }
  }

  // §19.4 shallow export for a `pub agent`: no field type may name a private user declaration.
  private checkAgentExport(a: A.AgentDecl): void {
    if (!a.pub) return;
    for (const f of a.fields) {
      if (this.namesPrivate(f.type)) {
        throw visibilityError(`pub agent '${a.name}' exposes a private field type '${this.typeName(f.type)}' via field '${f.name}' (pub is shallow, §19.4)`);
      }
    }
  }

  private typeName(t: A.TypeRef): string {
    return t.kind === "named" ? t.name : t.kind;
  }

  // W-Extend (§15.3.3): grants(child) ⊆ grants(parent), uniform over perform/reach/use. A child that
  // claims a capability its parent does not hold is an AuthorityViolation (static, default-deny).
  private checkSubtractiveGrants(child: A.AgentDecl): void {
    const parent = this.d.agents.get(child.extends!.name);
    if (!parent) return; // unknown parent — leave to other passes; do not false-reject
    const pg = parent.grants;
    if (pg === "all") return; // parent holds everything ⇒ any child subset is admissible
    const childGrants = child.grants;
    if (childGrants === "all") {
      // child claims `*` but parent is a finite set ⇒ a strict superset
      throw authorityViolation(`agent '${child.name}' extends '${parent.name}' but grants { * } exceeds its parent's authority`);
    }
    const has = (g: A.Grant) => pg.some((p) => p.cap === g.cap && p.name === g.name);
    for (const g of childGrants) {
      if (!has(g)) {
        throw authorityViolation(`agent '${child.name}' extends '${parent.name}' but claims '${g.cap} ${g.name}', which the parent does not grant (capabilities are subtractive under extend)`);
      }
    }
  }

  // PURE (W-PureSeamFree, §15.3.3): a `pure` function may reach no declared dependency. A tool call,
  // a send, or a principal-prefixed decide forces async — inside a `pure` body it is a ColorViolation.
  checkFn(f: A.FnDecl): void {
    this.checkFnExport(f);
    if (f.pure) this.assertPureBody(f.body);
    this.checkBody(f.body, new Scope());
    this.checkDeferenceFlow(f.body, new Scope());
  }

  private assertPureBody(stmts: A.Stmt[]): void {
    for (const s of stmts) this.assertPureStmt(s);
  }
  private assertPureStmt(s: A.Stmt): void {
    switch (s.kind) {
      case "var": if (s.init) this.assertPureExpr(s.init); return;
      case "assign": this.assertPureExpr(s.value); return;
      case "say": this.assertPureExpr(s.arg); return;
      case "return": if (s.value) this.assertPureExpr(s.value); return;
      case "exprstmt": this.assertPureExpr(s.expr); return;
      case "perform":
        // §6b: every perform is async — an action is an act on the world, and whether it is wired to an
        // effector is a deployment fact the checker must not depend on.
        throw colorViolation(`a \`pure\` function may not \`perform\` (an action is an outbound act → async) (§6b)`);
      case "emit": for (const a of s.args) this.assertPureExpr(a); return;
      case "if": this.assertPureExpr(s.cond); this.assertPureBody(s.then); if (s.else) this.assertPureBody(s.else); return;
      case "retry": this.assertPureBody(s.body); return;
      case "dispatch": this.assertPureGate(s.gate); for (const arm of s.arms) this.assertPureBody(arm.body); if (s.abstain) this.assertPureBody(s.abstain.body); return;
      // §9/§10: a mem WRITE internalizes through the provider (decompose across the region's views) —
      // a dependency reach, so a `pure` body may not store (the recall seam is likewise async, below).
      case "memdecl":
        throw colorViolation("a `pure` function may not declare/write a `mem` (a memory write internalizes through the provider → async)");
      default: return;
    }
  }
  // DECIDE-BY-PRINCIPAL predicate (§13, the suite's `decide c by p` form): a `decide` is principal-driven
  // when it carries an escalation prefix (`p decide …`, gate.principal set) OR its rule is a policy name
  // that is a DECLARED principal (`decide c by p`, where the parser recorded `p` as a {policy} rule because
  // it cannot tell principal from policy context-free). Only a name that IS a declared principal is treated
  // as principal-driven — an unknown/real policy name keeps its policy semantics (conservative).
  private principalOfDecide(g: A.DecideExpr): string | undefined {
    if (g.principal) return g.principal;
    if (g.rule.kind === "policy" && this.d.principals.has(g.rule.name)) return g.rule.name;
    return undefined;
  }

  private assertPureGate(g: A.GateExpr): void {
    if (g.kind === "decide") {
      // a principal-driven decide (prefix `p decide …` OR `decide c by p` with a declared principal p)
      // reaches the identity dependency → async; inside a `pure` body it is a ColorViolation (§4/§13).
      if (this.principalOfDecide(g)) throw colorViolation("a `pure` function may not use a principal-driven `decide` (it reaches the identity dependency → async)");
      this.assertPureExpr(g.credence);
    } else {
      this.assertPureExpr(g.subject);
      this.assertPureExpr(g.decision);
    }
  }
  private assertPureExpr(e: A.Expr): void {
    switch (e.kind) {
      case "send": throw colorViolation("a `pure` function may not `<-` (a send reaches the provider → async)");
      // the memory substrate is async (§9/§10): a recall or ledger query reaches async runtime state.
      case "recall": throw colorViolation("a `pure` function may not recall (`->` reaches the async memory substrate → async)");
      case "select": throw colorViolation("a `pure` function may not query the ledger (`select` reaches async runtime state → async)");
      case "decide": case "endorse": this.assertPureGate(e); return;
      case "performexpr":
        throw colorViolation(`a \`pure\` function may not \`perform\` (an action is an outbound act → async) (§6b)`);
      case "call":
        // §4: a `pure` fn may only call other `pure` fns. Calling a KNOWN user function that is not marked
        // `pure` (its body may reach a declared dependency — a send, recall, tool call, or principal-decide)
        // forces async → a ColorViolation. Conservative: only a declared user fn that is provably async
        // triggers this; an unknown/built-in callee (`say`, a prelude helper) stays exempt so no accept
        // test is false-rejected. The call arguments are still walked for their own async reaches.
        if (e.callee.kind === "ident") {
          const callee = this.d.fns.get(e.callee.name);
          if (callee && !callee.pure) {
            throw colorViolation(`a \`pure\` function may only call other \`pure\` functions, not the async function '${e.callee.name}' (its body may reach a declared dependency → async) (§4)`);
          }
          // now() reads the kernel clock — a world reach, so a `pure` body may not observe it
          // (take() has no reach and stays legal).
          if (!callee && e.callee.name === "now") {
            throw colorViolation("a `pure` function may not read the kernel clock (now() observes the world → async) (§4)");
          }
        }
        for (const a of e.args) this.assertPureExpr(a);
        return;
      case "member": this.assertPureExpr(e.obj); return;
      case "binary": this.assertPureExpr(e.left); this.assertPureExpr(e.right); return;
      case "unary": this.assertPureExpr(e.operand); return;
      case "fstring": for (const p of e.parts) if (p.kind === "expr") this.assertPureExpr(p.expr); return;
      // §12 aggregation forms carry no async reach of their own; recurse into their operands so an async
      // reach nested inside (a send, a tool call) is still caught.
      case "agg": for (const o of e.operands) this.assertPureExpr(o); return;
      case "quorum": this.assertPureExpr(e.source); return;
      case "pipe": this.assertPureExpr(e.source); this.assertPureExpr(e.fn); return;
      case "arraylit": for (const it of e.items) this.assertPureExpr(it); return;
      default: return;
    }
  }

  checkBody(stmts: A.Stmt[], scope: Scope): void {
    for (const s of stmts) this.checkStmt(s, scope);
  }

  private checkStmt(s: A.Stmt, scope: Scope): void {
    switch (s.kind) {
      case "var": {
        if (s.init) {
          const got = this.infer(s.init, scope, s.type);
          const want = declClass(s.type);
          if (conflicts(want, got)) {
            throw typeError(`'${s.name}': cannot assign ${got} to ${want}`);
          }
          this.trackProvenance(s.name, s.init, scope, declClass(s.type));
          // §19.5 interface subtyping: binding a value into an interface-typed slot requires the value's
          // concrete agent to IMPLEMENT that interface. Enforced only when the init's agent type is
          // statically known (a spawned/aliased instance) and does NOT implement the interface — otherwise
          // conservative (an unknown source is admitted, so an accept binding is never false-rejected).
          this.checkInterfaceBinding(s.type, s.init, scope);
          // propagate a known concrete agent type through a simple alias `var m = n` (n an agent binding)
          // or a `spawn` expression `Verifier v = spawn Verifier;`, so a later `v <- task` / `reach` /
          // interface-binding check sees v's underlying agent type.
          const srcType = s.init.kind === "ident" ? scope.getAgentType(s.init.name)
            : s.init.kind === "spawnexpr" ? s.init.agentType
            : undefined;
          if (srcType) scope.setAgentType(s.name, srcType);
        }
        scope.set(s.name, declClass(s.type));
        if (s.type.kind === "credence" || s.type.kind === "decision") scope.setEnumName(s.name, s.type.enumName);
        // remember the originating `decide` for a Decision binding (any binding form, typed or not), so the
        // §20.3 deference check can ask whether the decision endorsing a consequential path is principal-driven.
        if (s.init && s.init.kind === "decide") scope.setDecide(s.name, s.init);
        return;
      }
      case "assign": {
        // a Decision/Endorsement's provenance fields are read-only (§20.4): `d.margin = …` is a TypeError.
        if (s.target.kind === "member") {
          const objCls = this.infer(s.target.obj, scope);
          if (objCls === "decision" || objCls === "endorsement") {
            throw typeError(`'.${s.target.field}' on a ${objCls} is read-only`);
          }
        }
        this.infer(s.value, scope);
        // §13 dependency-scope provenance must flow through reassignment too: `u = t` (t a recall/query)
        // must taint `u` exactly as a `var u = t` would, or an `endorse u by d` launders the tainted value
        // to a sink. The `var` case does this via trackProvenance; the `assign` case must not skip it.
        if (s.target.kind === "ident") this.trackProvenance(s.target.name, s.value, scope, scope.get(s.target.name));
        return;
      }
      case "emit": return this.checkInvoke("emit", s.name, s.args, this.d.events, scope);
      case "perform": return this.checkInvoke("perform", s.name, s.args, this.d.actions, scope);
      case "say": this.infer(s.arg, scope); return;
      case "if": {
        const cond = this.infer(s.cond, scope);
        if (cond !== "bool" && cond !== "unknown") {
          throw typeError(`an 'if' condition must be a bool, not ${cond} (gate a Credence first)`);
        }
        const thenScope = scope.child();
        // Model-A flow narrowing (§13/§15.3.3): inside the TRUE branch of `if (d.committed == V)`
        // for a real variant V, the Decision `d` is committed-narrowed and may be endorsed. The else branch
        // leaves it not committed-narrowed (the abstained / other-variant case).
        const narrowed = this.committedNarrowIdent(s.cond);
        if (narrowed) {
          if (scope.get(narrowed) === "decision") thenScope.markCommittedDecision(narrowed);
          else thenScope.markCommittedNarrowed(narrowed);
        }
        this.checkBody(s.then, thenScope);
        if (s.else) this.checkBody(s.else, scope.child());
        return;
      }
      case "dispatch": return this.checkDispatch(s, scope);
      case "memdecl": {
        if (s.init) this.infer(s.init, scope);
        scope.set(s.name, "mem"); // the handle has type `mem` (§10)
        return;
      }
      case "forget": {
        // `forget` requires a `mem` handle; it consumes it (recall afterward is a TypeError, §10).
        const c = scope.get(s.name);
        if (c !== undefined && c !== "unknown" && c !== "mem") {
          throw typeError(`'forget ${s.name}': forget requires a mem handle, not ${c}`);
        }
        scope.forget(s.name);
        return;
      }
      case "depdecl": {
        // record the dependence group for the T-Fuse coverage check (§12/§15.3.2). The names themselves
        // are not type-checked here (conservative): the coverage requirement is enforced at the fuse.
        scope.addDepGroup(s.names);
        return;
      }
      case "exprstmt": this.infer(s.expr, scope); return;
      case "complete": this.infer(s.value, scope); return; // task-handler-only: enforced dynamically (§6c)
      case "fail": {
        const rc = this.infer(s.reason, scope);
        if (rc !== "text" && rc !== "unknown") throw typeError(`\`fail\` requires a text reason, not ${rc} (§6c)`);
        return;
      }
      case "cancel": this.infer(s.handle, scope); return; // Task<T> handle check is dynamic (§6c)
      case "spawn": {
        // an interface is a TYPE but is NOT instantiable — `spawn Iface` is a TypeError (§19.5). Fires only
        // when the spawned name is a declared interface; an unknown agent type is left to execSpawn.
        if (this.d.interfaces.has(s.agentType)) {
          throw typeError(`'${s.agentType}' is an interface, which is not instantiable — a 'spawn' of an interface is a TypeError (§19.5)`);
        }
        // record the spawned instance's concrete agent type for the §19.5 interface-binding check. Its
        // coarse class is left `unknown` (declClass buckets agent/interface/enum `named` types together,
        // so pinning it to a class here would spuriously conflict when it is later bound to an agent- or
        // interface-typed slot); only the precise concrete type is tracked, on a dedicated map.
        if (this.d.agents.has(s.agentType)) scope.setAgentType(s.name, s.agentType);
        return;
      }
      case "retry":
        // §11: the bounded recovery block shares the enclosing scope (an attempt's binding persists), so
        // its body is checked in `scope` — the consequential-perform static rule (checkInvoke) and every
        // other statement check apply inside a `retry` exactly as at top level.
        this.checkBody(s.body, scope);
        return;
      default: return; // awake/sleep/return/when — no shape checks
    }
  }

  private checkInvoke(kind: "emit" | "perform", name: string, args: A.Expr[], table: Map<string, A.Field[]>, scope: Scope): void {
    const fields = table.get(name);
    if (!fields) {
      if (kind === "emit" && BUILTIN_EVENTS.has(name)) return; // generic root event, any payload
      throw typeError(`${kind} of undeclared ${kind === "emit" ? "event" : "action"} '${name}'`);
    }
    if (args.length !== fields.length) {
      throw typeError(`${kind} ${name}: expected ${fields.length} argument(s), got ${args.length}`);
    }
    // §13/§15.3.3 consequential-action rule (static admission). A `perform` argument is a consequential
    // sink; an `emit` is NOT, so these fire for `perform` only. The check is TOTAL over branches — it runs
    // wherever the `perform` is written, independent of which arm the runtime dispatch will take — so the
    // kernel guarantee (no un-endorsed cognition reaches a sink) is a compile-time property, not contingent
    // on a stochastic provider judgment that happens to route around the offending arm (W-Consequential-static).
    if (kind === "perform") {
      for (const arg of args) {
        for (const id of this.freeIdents(arg)) {
          // (a) a non-committed-narrowed `Endorsement` — an endorse binder bound in the `abstain`/`else`
          // branch (`.committed == abstained`). Settled but NOT committed-narrowed, so its subject cannot
          // reach a sink; performing that binder (or a member of it) launders an un-committed endorsement.
          if (scope.isNonCommittedEndorsement(id)) {
            throw taintViolation(
              `perform ${name}: '${id}' is an Endorsement bound in the abstain/else branch (\`.committed == abstained\`), ` +
              `which is settled but NOT committed-narrowed — an un-committed endorsement cannot reach a consequential sink (§13/§15.3.3)`,
            );
          }
          // (b) a provably-tainted (raw/graded) value: an un-endorsed memory read (recall/select),
          // a raw send reply, or anything contagiously derived from one (a tool result over a tainted input).
          // Such a value carries un-endorsed cognition and is ILL-FORMED at a consequential sink — it must be
          // decided AND endorsed first, and only the resulting committed-narrowed `Endorsement` may reach the
          // sink. Enforcing this statically closes the dynamic-only enforcement hole: a raw value performed in
          // a NON-taken arm (or abstain branch) is rejected at compile time, not merely on the executed path.
          if (scope.isTainted(id)) {
            throw taintViolation(
              `perform ${name}: '${id}' carries un-endorsed cognition (a raw/graded memory read, send reply, or a ` +
              `value derived from one) — a consequential sink admits only a settled value, so decide-and-endorse it ` +
              `first and perform the committed-narrowed Endorsement (§13/§15.3.3, W-Consequential-static)`,
            );
          }
        }
      }
    }
    args.forEach((arg, i) => {
      const ac = this.infer(arg, scope);
      const fc = declClass(fields[i]!.type);
      // only flag scalar↔scalar shape mismatches; gate values (credence/decision/endorsement) and
      // unknowns are left to the runtime consequential-action rule (taint), not the type checker.
      const scalar = (c: Cls) => c === "int" || c === "float" || c === "bool" || c === "text" || c === "null";
      if (scalar(ac) && scalar(fc) && conflicts(ac, fc)) {
        throw typeError(`${kind} ${name}: argument ${i + 1} is ${ac}, expected ${fc}`);
      }
    });
  }

  private checkDispatch(s: A.DispatchStmt, scope: Scope): void {
    this.infer(s.gate, scope);
    if (s.gate.kind === "endorse") { this.checkEndorseScope(s.gate, scope); this.checkEndorseCommitted(s.gate, scope); this.checkDeference(s, scope); }
    const boundCls: Cls = s.gate.kind === "endorse" ? "endorsement" : "decision";
    const enumName = this.gateEnum(s.gate, scope);
    if (enumName) {
      const variants = this.d.enums.get(enumName);
      if (variants) {
        // an arm head must be a variant of the gate enum (§13, §15.3.3); an unknown head is a TypeError.
        for (const arm of s.arms) {
          if (!variants.includes(arm.head)) {
            throw typeError(`gate arm '${arm.head}' is not a variant of ${enumName}`);
          }
        }
        // compile-time exhaustiveness: with no abstain/default, every variant must be covered (§13).
        if (!s.abstain) {
          const covered = new Set(s.arms.map((a) => a.head));
          const missing = variants.filter((v) => !covered.has(v));
          if (missing.length) throw exhaustivenessError(`dispatch over ${enumName} missing arm(s): ${missing.join(", ")}`);
        }
      }
    }
    for (let ai = 0; ai < s.arms.length; ai++) {
      const arm = s.arms[ai]!;
      const inner = scope.child();
      if (arm.binder) inner.set(arm.binder, boundCls);
      // §13: `endorse SUBJ by d` settles the certified judgment ONLY in its MATCHING commit arm — the
      // affirmative outcome (by convention the primary/first variant). There it clears the taint on the whole
      // certified judgment (the endorsed subject AND the decision's dependency scope: the credence and the
      // artifacts that fed its prompt), so a perform of any certified value is admitted. A subsequent
      // (non-affirmative) arm does NOT settle it — performing the raw artifact there is laundering
      // (gov_negative_arm), and the `abstain` arm below likewise never clears it (§20.3).
      if (s.gate.kind === "endorse" && ai === 0) {
        const g = s.gate;
        for (const id of this.freeIdents(g.subject)) inner.clearTaint(id);
        const dScope = g.decision.kind === "ident" ? inner.getScope(g.decision.name)
          : g.decision.kind === "decide" ? this.scopeOfDecision(g.decision, inner) : undefined;
        if (dScope) for (const id of dScope) inner.clearTaint(id);
      }
      this.checkBody(arm.body, inner);
    }
    if (s.abstain) {
      const inner = scope.child();
      if (s.abstain.binder) {
        inner.set(s.abstain.binder, boundCls);
        // §13/§15.3.3: the `abstain`/`else` branch has `.committed == abstained`, so an `endorse` binder
        // bound here is settled but NOT committed-narrowed — the endorsed subject cannot itself reach a
        // consequential sink. Mark it so a `perform` of the binder in this branch is a TaintViolation. (A
        // `decide` binder never settles a subject at all, so it is likewise non-sink-admissible.)
        inner.markNonCommittedEndorsement(s.abstain.binder);
      }
      this.checkBody(s.abstain.body, inner);
    }
  }

  // the enum a gate dispatches over, if statically known (from the decision/credence operand's declared type).
  private gateEnum(g: A.GateExpr, scope: Scope): string | undefined {
    const operand = g.kind === "decide" ? g.credence : g.decision;
    return operand.kind === "ident" ? scope.getEnumName(operand.name) : undefined;
  }

  // ---- §20.3 deference requirement (abstain-safety static guard) ----

  // §20.3: "A consequential path with no `principal` prefix and no compatible mature profile is a compile
  // error unless its policy explicitly declares a non-human cold-start strategy." A CONSEQUENTIAL endorsement
  // path is an endorse arm that reaches a NON-reversible sink (a non-`reversible` `perform`, or a write-tool
  // input). The rule bites specifically on a CONFORMAL (always-abstaining cold-start) basis: a cold conformal
  // gate cannot commit until it has a readiness quorum of labels, so a consequential conformal path that has
  // no way to reach a human — no escalation prefix, no `by <principal>` rule, and no `abstain` fallback that
  // re-decides by a principal — can never legitimately settle its action and is a GateError (§13 cold phase:
  // "ambiguous or high-stakes cases route to the gate's `principal` prefix (or `abstain` if none)"; §20.1:
  // "Non-reversible or ambiguous outcomes route to the gate's `principal` prefix"). A THRESHOLD basis
  // (`confidence θ` / `threshold θ`) MAY commit an obvious cold winner autonomously, so it is NOT subject to
  // the deference requirement — this is exactly the reversible/threshold cold-start allowance (§20.1).
  // Conservative in three ways: fires only over a DEMONSTRABLY conformal endorsing decision, only when a
  // non-reversible sink is DEMONSTRABLY reached from a committed arm, and never when any principal is reachable
  // or a named policy (which may carry a non-human cold-start strategy) governs the decision.
  private checkDeference(s: A.DispatchStmt, scope: Scope): void {
    if (s.gate.kind !== "endorse") return;
    // only a CONFORMAL-based endorsing decision is a cold-start-abstaining consequential gate (§20.1/§20.3).
    if (!this.endorseIsConformal(s.gate, scope)) return;
    // only a consequential endorse (some committed arm reaches a non-reversible sink) is subject to the rule.
    if (!s.arms.some((arm) => this.reachesNonReversibleSink(arm.body, scope))) return;
    // principal-driven endorsing decision → the consequential leg can reach a human; OK.
    if (this.endorseIsPrincipalDriven(s.gate, scope)) return;
    // a policy-governed decision may declare a non-human cold-start strategy (a named `policy` rule). We do
    // not model policy internals here, so a `by <policy-name>` rule (a non-principal named rule) is treated
    // as possibly carrying such a strategy — conservative: never reject a policy-governed decision.
    if (this.endorseUsesNamedPolicy(s.gate, scope)) return;
    // reachable principal fallback in the abstain branch (the bootstrap): an abstain block that re-decides by
    // a principal and endorses drives the same arms through a human, satisfying deference.
    if (s.abstain && this.hasReachablePrincipalEscalation(s.abstain.body, scope)) return;
    throw gateError(
      `a consequential endorsement path (an endorse arm reaching a non-reversible sink) has no reachable ` +
      `principal: the endorsing decision carries no escalation prefix and no \`by <principal>\` rule, and no ` +
      `\`abstain\` fallback defers to one — autonomy on a consequential leg is earned via labels, so a cold ` +
      `gate must escalate. Add a \`principal\` prefix (\`p decide c by r\`) or an abstain principal path (§20.3)`,
    );
  }

  // §13/§20.3 deference requirement for the if-flow (no arm block): a consequential handler that settles on a
  // COLD CONFORMAL, non-principal, non-policy endorsement — reaching a non-reversible sink — with NO reachable
  // principal escalation anywhere in the handler is a GateError. A principal-driven decision, a named policy, a
  // reachable principal fallback (an else branch that re-decides `p decide c by r`), or a non-consequential
  // handler (no non-reversible sink) all satisfy it. Threshold gates are exempt (they may commit a cold winner).
  checkDeferenceFlow(body: A.Stmt[], scope: Scope): void {
    const inner = scope.child();
    const endorses: A.EndorseExpr[] = [];
    const collect = (stmts: A.Stmt[]): void => {
      for (const st of stmts) {
        if (st.kind === "var" && st.init) {
          if (st.init.kind === "decide") inner.setDecide(st.name, st.init); // track decisions for resolution
          if (st.init.kind === "endorse") endorses.push(st.init);
        }
        if (st.kind === "exprstmt" && st.expr.kind === "endorse") endorses.push(st.expr);
        if (st.kind === "if") { collect(st.then); if (st.else) collect(st.else); }
        else if (st.kind === "when") collect(st.body);
        else if (st.kind === "dispatch") { for (const a of st.arms) collect(a.body); if (st.abstain) collect(st.abstain.body); }
      }
    };
    collect(body);
    const cold = endorses.some((g) =>
      this.endorseIsConformal(g, inner) && !this.endorseIsPrincipalDriven(g, inner) && !this.endorseUsesNamedPolicy(g, inner));
    if (!cold) return;
    if (this.hasReachablePrincipalEscalation(body, inner)) return;
    if (!this.reachesNonReversibleSink(body, inner)) return;
    throw gateError(
      `a consequential path settles on a cold conformal gate with no reachable principal: the endorsing ` +
      `decision carries no escalation prefix and no principal fallback, yet reaches a non-reversible sink — ` +
      `autonomy on a consequential leg is earned via labels, so a cold gate must escalate. Add a \`principal\` ` +
      `prefix (\`p decide c by r\`) or a principal fallback in the else branch (§13/§20.3)`,
    );
  }

  // Whether a statement block reaches a NON-reversible consequential sink: a `perform` of a non-`reversible`
  // action, or a write-tool call. Walks nested control flow (if/else, nested dispatch arms + abstain, when).
  private reachesNonReversibleSink(stmts: A.Stmt[], scope: Scope): boolean {
    const sinkExpr = (e: A.Expr): boolean => {
      // a result-bound perform is a consequential sink like any perform (§6b).
      if (e.kind === "performexpr" && this.d.actionReversible.get(e.name) !== true) return true;
      switch (e.kind) {
        case "call": if (sinkExpr(e.callee)) return true; return e.args.some(sinkExpr);
        case "member": return sinkExpr(e.obj);
        case "binary": return sinkExpr(e.left) || sinkExpr(e.right);
        case "unary": return sinkExpr(e.operand);
        case "fstring": return e.parts.some((p) => p.kind === "expr" && sinkExpr(p.expr));
        case "structlit": return e.fields.some((f) => sinkExpr(f.value));
        case "arraylit": return e.items.some(sinkExpr);
        default: return false;
      }
    };
    const walk = (list: A.Stmt[]): boolean => list.some((st) => stmtHas(st));
    const stmtHas = (st: A.Stmt): boolean => {
      switch (st.kind) {
        case "perform": {
          // a non-reversible action IS a consequential sink; a `reversible action` is not (§20.1).
          const name = this.qualify(st.name);
          if (this.d.actionReversible.get(name) !== true) return true;
          return st.args.some(sinkExpr);
        }
        case "var": return st.init ? sinkExpr(st.init) : false;
        case "assign": return sinkExpr(st.value) || sinkExpr(st.target);
        case "say": return sinkExpr(st.arg);
        case "exprstmt": return sinkExpr(st.expr);
        case "return": return st.value ? sinkExpr(st.value) : false;
        case "emit": return st.args.some(sinkExpr);
        case "if": return walk(st.then) || (st.else ? walk(st.else) : false) || sinkExpr(st.cond);
        case "when": return walk(st.body);
        case "retry": return walk(st.body);
        case "dispatch": return st.arms.some((a) => walk(a.body)) || (st.abstain ? walk(st.abstain.body) : false);
        default: return false;
      }
    };
    return walk(stmts);
  }

  // Resolve the action name against nothing (the deference walk sees BARE names as written in source); a
  // qualified name is left as-is. Mirrors the bare/qualified action-reversibility lookup.
  private qualify(name: string): string { return name; }

  // Whether the decision endorsing this gate is principal-driven: an escalation prefix (`p decide …`) or a
  // `by <declared-principal>` rule (the parser records a bare `by NAME` as a {policy} rule; a NAME that is a
  // declared `principal` is the pure principal form). Resolves the decision through its binding when it is an
  // ident (`endorse c by d`), or reads an inline `decide` directly.
  private endorseIsPrincipalDriven(g: A.EndorseExpr, scope: Scope): boolean {
    const d = this.decideOfEndorse(g, scope);
    if (!d) return false;
    return this.decideIsPrincipalDriven(d);
  }
  private decideIsPrincipalDriven(d: A.DecideExpr): boolean {
    if (d.principal !== undefined && this.d.principals.has(d.principal)) return true;
    if (d.rule.kind === "policy" && this.d.principals.has(d.rule.name)) return true;
    return false;
  }
  // Whether the endorsing decision uses a NAMED policy that is not a principal (a `by <policy>` rule). Such a
  // policy may declare a non-human cold-start strategy, so we do not reject it (conservative, §20.3).
  private endorseUsesNamedPolicy(g: A.EndorseExpr, scope: Scope): boolean {
    const d = this.decideOfEndorse(g, scope);
    if (!d) return false;
    return d.rule.kind === "policy" && !this.d.principals.has(d.rule.name);
  }
  // Whether the endorsing decision's rule is CONFORMAL (§20.1/§20.3). A cold conformal gate always abstains
  // until it earns a readiness quorum of labels, so a consequential conformal path with no human route is the
  // deference violation checkDeference guards; a threshold (`confidence`/`threshold`) or named-policy basis is
  // NOT conformal and is exempt (it may commit an obvious cold winner, §20.1).
  private endorseIsConformal(g: A.EndorseExpr, scope: Scope): boolean {
    const d = this.decideOfEndorse(g, scope);
    if (!d) return false;
    return d.rule.kind === "conformal";
  }
  private decideOfEndorse(g: A.EndorseExpr, scope: Scope): A.DecideExpr | undefined {
    if (g.decision.kind === "decide") return g.decision;
    if (g.decision.kind === "ident") return scope.getDecide(g.decision.name);
    return undefined;
  }

  // Whether a block contains a reachable principal escalation (the bootstrap): a principal-driven `decide`
  // whose Decision drives an endorse that reaches a consequential sink. Conservatively, ANY principal-driven
  // `decide` in the abstain block satisfies deference — the abstain leg can reach a human for the hard case.
  private hasReachablePrincipalEscalation(stmts: A.Stmt[], scope: Scope): boolean {
    const inner = scope.child();
    let found = false;
    const exprHas = (e: A.Expr): void => {
      if (e.kind === "decide" && this.decideIsPrincipalDriven(e)) found = true;
    };
    const walk = (list: A.Stmt[]): void => {
      for (const st of list) {
        switch (st.kind) {
          case "var": if (st.init) { exprHas(st.init); if (st.init.kind === "decide") inner.setDecide(st.name, st.init); } break;
          case "assign": exprHas(st.value); break;
          case "exprstmt": exprHas(st.expr); break;
          case "say": exprHas(st.arg); break;
          case "if": walk(st.then); if (st.else) walk(st.else); break;
          case "when": walk(st.body); break;
          case "retry": walk(st.body); break;
          case "dispatch":
            if (st.gate.kind === "decide") exprHas(st.gate);
            else if (st.gate.kind === "endorse" && this.endorseIsPrincipalDriven(st.gate, inner)) found = true;
            for (const a of st.arms) walk(a.body);
            if (st.abstain) walk(st.abstain.body);
            break;
          default: break;
        }
      }
    };
    walk(stmts);
    return found;
  }

  // ---- expression type inference (coarse; default unknown) ----
  // `expected` is the declared/target type of the binding this expression initializes (when known); it
  // lets a `recall` be graded into a `Credence<E>` slot exactly as the interpreter does (§10), so the
  // checker never false-rejects the spec's own re-judging path.
  private infer(e: A.Expr, scope: Scope, expected?: A.TypeRef): Cls {
    switch (e.kind) {
      case "int": return "int";
      case "float": return "float";
      case "bool": return "bool";
      case "string": case "fstring": case "mdimport": return "text";
      case "null": return "null";
      case "self": return "agent";
      case "spawnexpr": {
        // §19.5: a `spawn` of an interface is a TypeError, same as the statement form.
        if (this.d.interfaces.has(e.agentType)) {
          throw typeError(`'${e.agentType}' is an interface, which is not instantiable — a 'spawn' of an interface is a TypeError (§19.5)`);
        }
        for (const a of e.args) this.infer(a, scope);
        return "unknown"; // agent-typed; coarse class left lenient (as the spawn statement does)
      }
      case "ident": {
        const v = scope.get(e.name);
        if (v) return v;
        if (e.name === "abstained") return "enum";
        if (this.isVariant(e.name)) return "enum";
        return "unknown";
      }
      case "send": return "unknown"; // a send is credence (when bound) or raw text — don't over-constrain
      case "recall": {
        // `->` recall requires a `mem` handle on the left (§10): a non-`mem` LHS is a TypeError, and a
        // handle that `forget` has consumed is no longer recallable (also a TypeError).
        this.infer(e.query, scope);
        if (e.mem.kind === "ident") {
          if (scope.isForgotten(e.mem.name)) {
            throw typeError(`'${e.mem.name} ->': the handle was forgotten and is no longer recallable`);
          }
          const c = scope.get(e.mem.name);
          if (c !== undefined && c !== "mem" && c !== "unknown") {
            throw typeError(`'-> ' recall requires a mem handle on the left, not ${c}`);
          }
        } else {
          // `self -> "x"` / any non-ident LHS: the only expression that is a `mem` is an ident handle.
          const c = this.infer(e.mem, scope);
          if (c !== "mem" && c !== "unknown") {
            throw typeError(`'-> ' recall requires a mem handle on the left, not ${c}`);
          }
        }
        // A recall is `raw` `text` by default, but §10 lets it be graded into a `Credence<E>` slot: a
        // recall hit "must be re-judged (fed into a Credence) and gated". The interpreter's
        // evalRecall already yields a credence when the expected slot is Credence, so the checker mirrors
        // it — binding a recall into a Credence is LEGAL, not `cannot assign text to credence`.
        return expected?.kind === "credence" ? "credence" : "text"; // taint stays dynamic
      }
      case "select": return "unknown"; // an array<…> result — taint enforced dynamically
      case "structlit": {
        for (const f of e.fields) this.infer(f.value, scope);
        // a typed struct literal must supply EXACTLY the declared fields (§3, §8): every declared field
        // is required (a missing one is a TypeError) and there is no optional-by-omission or extra field
        // (an undeclared one is a TypeError). Only checked when the struct type is declared (conservative;
        // an unknown/bare literal is left to other passes so an accept test is never false-rejected).
        if (e.typeName) {
          const sdecl = this.d.structs.get(e.typeName);
          if (sdecl) {
            const decl = sdecl.fields;
            const declared = new Set(decl.map((f) => f.name));
            const supplied = new Set(e.fields.map((f) => f.name));
            for (const f of decl) {
              if (!supplied.has(f.name)) {
                throw typeError(`struct ${e.typeName}: missing required field '${f.name}'`);
              }
            }
            for (const f of e.fields) {
              if (!declared.has(f.name)) {
                throw typeError(`struct ${e.typeName}: no such field '${f.name}'`);
              }
            }
          }
        }
        return e.typeName ? "enum" : "unknown";
      }
      case "decide":
        // §3/§13: a principal basis must be a declared `principal`, not a forgeable text claim — a string in
        // the prefix position (`"alice" decide c`) has no text→Principal coercion and is a TypeError.
        if (e.principalStr) throw typeError(`a principal basis must be a declared \`principal\`, not the string ${JSON.stringify(e.principal)} — there is no text→Principal coercion (§3/§13)`);
        this.infer(e.credence, scope);
        return "decision";
      case "endorse": this.checkEndorseScope(e, scope); this.checkEndorseCommitted(e, scope); return "endorsement";
      case "index": this.infer(e.obj, scope); this.infer(e.index, scope); return "unknown"; // element class unknown
      case "member": {
        const obj = this.infer(e.obj, scope);
        // §3/§11: a Credence<E> is consumed ONLY by a gate/combinator; the Decision accessors
        // (`.committed`/`.basis`/`.margin`) do not exist on a Credence — testing one before deciding is a TypeError.
        if (obj === "credence" && (e.field === "committed" || e.field === "basis" || e.field === "margin")) {
          throw typeError(`'.${e.field}' is a Decision accessor; a Credence<E> is consumed only by a gate/combinator, so testing '.${e.field}' before a gate is a TypeError (§3/§11)`);
        }
        if (obj === "decision" || obj === "endorsement") {
          if (e.field === "committed") return "enum";
          if (e.field === "basis") return "enum"; // a value of the built-in `Basis` enum (§20.4)
          if (e.field === "margin") return "float";
          if (e.field === "decision_id") return "int";
          if (e.field === "subject") return "unknown";
        }
        return "unknown";
      }
      case "binary": {
        const cmp = ["==", "!=", "<", ">", "<=", ">=", "&&", "||"];
        // a comparison/logical op is a `bool`, but still INFER both operands so an ill-typed operand (e.g.
        // `.committed` on an ungated Credence, §3/§11) is caught rather than silently skipped.
        if (cmp.includes(e.op)) { this.infer(e.left, scope); this.infer(e.right, scope); return "bool"; }
        if (e.op === "+") {
          const l = this.infer(e.left, scope), r = this.infer(e.right, scope);
          if (l === "text" || r === "text") return "text";
          return "float";
        }
        return "float";
      }
      case "unary": return e.op === "!" ? "bool" : "float";
      case "tasklit": {
        // §6c: objective and acceptance are REQUIRED and must be `text`.
        if (!e.objective || !e.acceptance) {
          throw typeError("a task literal requires BOTH `objective` and `acceptance` (§6c)");
        }
        const oc = this.infer(e.objective, scope);
        if (oc !== "text" && oc !== "unknown") throw typeError(`task \`objective\` must be text, not ${oc} (§6c)`);
        const ac = this.infer(e.acceptance, scope);
        if (ac !== "text" && ac !== "unknown") throw typeError(`task \`acceptance\` must be text, not ${ac} (§6c)`);
        return "unknown"; // a TaskSpec value (scope attenuation + endorsement rules are dynamic, §6c)
      }
      case "call": {
        if (e.callee.kind === "ident") {
          const name = e.callee.name;
          // §4/§8: a bare call to a name that is not a declared/imported function is an
          // unknown-identifier TypeError — functions are declared, not self-declaring. Expressions can
          // never reach the world (§6b): observation arrives as events, acts leave as performs.
          // The kernel builtins are the exception: now() (the kernel clock → text) and the
          // array primitives take/skip/len — a user-declared fn of the same name shadows them.
          if (!this.d.fns.has(name)) {
            if (name === "now") {
              if (e.args.length !== 0) throw typeError("now() takes no arguments");
              return "text";
            }
            if (name === "take" || name === "skip") {
              if (e.args.length !== 2) throw typeError(`${name}(xs, n) takes an array and a count`);
              for (const a of e.args) this.infer(a, scope);
              return "unknown";
            }
            if (name === "len") {
              if (e.args.length !== 1) throw typeError("len(xs) takes one array");
              this.infer(e.args[0]!, scope);
              return "int";
            }
            throw typeError(`call to undeclared function '${name}' — functions are declared, not self-declaring; the world is reached only through wired events and actions (§4/§6b/§8)`);
          }
        }
        return "unknown";
      }
      case "performexpr": {
        // §6b foreground perform binding: `T r = perform A(args) expires N;` — result-bound only,
        // `expires` MANDATORY, args under the uniform consequential-sink rule.
        if (!e.expires) {
          throw typeError("a result-bound `perform` requires `expires` — the reply is a deadline-bound observation (§6b/§6c)");
        }
        this.infer(e.expires, scope);
        this.checkInvoke("perform", e.name, e.args, this.d.actions, scope);
        // the binding is typed from the manifest-named result event (single-field event binds the field).
        const w = this.manifest?.actions?.[e.name];
        const resultEvent = typeof w?.result_event === "string" ? w.result_event : undefined;
        if (resultEvent) {
          const fields = this.d.events.get(resultEvent);
          if (fields && fields.length === 1) return declClass(fields[0]!.type);
        }
        return "unknown";
      }
      case "arraylit": {
        const elemClasses = e.items.map((it) => this.infer(it, scope));
        // narrow: an array literal whose every element is provably a Credence is an `array<Credence<…>>`
        // (a fuseable credence collection). Otherwise the coarse type system has no element class.
        if (e.items.length > 0 && elemClasses.every((c) => c === "credence")) return "credarray";
        return "unknown";
      }
      case "pipe": {
        this.infer(e.source, scope);
        this.infer(e.fn, scope);
        return "unknown";
      }
      case "agg": {
        // `all`/`any` (§12): over plain bool they are ordinary conjunction/disjunction (no dependence
        // check); over two-or-more fused Credences they FUSE and require total dependence coverage.
        const classes = e.operands.map((o) => this.infer(o, scope));
        if (classes.length > 0 && classes.every((c) => c === "bool")) return "bool";
        // collect the Credence UNITS the operands contribute (a bare ident is a nameable/coverable unit;
        // any other credence-producing form — a nested fuse, a send, an array<Credence> — is anonymous).
        const units = this.fusedCredenceUnits(e.operands, scope);
        if (units.length >= 2) this.checkFusionCoverage(units, scope);
        // a fuse over any credence-bearing operand (a credence, a credence array, or a proven unit) yields
        // a Credence<bool>; else stay conservative.
        return units.length >= 1 || classes.some((c) => c === "credence" || c === "credarray")
          ? "credence" : "unknown";
      }
      case "quorum": {
        // `quorum(k, arr)` (§12): the array's Credence elements fuse under the same total-coverage rule.
        // `arr` may be an inline array literal OR any array<Credence<bool>>-typed expression (§15.2 expr).
        const units = this.fusedCredenceUnits([e.source], scope);
        if (units.length >= 2) this.checkFusionCoverage(units, scope);
        // quorum yields a Credence<bool> whenever its source is a credence array; else conservative.
        return units.length >= 1 || this.infer(e.source, scope) === "credarray" ? "credence" : "unknown";
      }
    }
  }

  // The Credence units fused by an `all`/`any`/`quorum`. `name` is the coverable identity for a dependence
  // declaration (present only for a bare Credence identifier — the only form nameable in an
  // `independent`/`dependent` clause); an anonymous unit (`name` undefined) is a credence with no
  // declarable name — an inline `send`, a nested fuse, or an element of an array-typed *variable*/query —
  // so NO `independent`/`dependent` declaration can ever cover it (§12: coverage must be total over pairs).
  private fusedCredenceUnits(operands: A.Expr[], scope: Scope): { name?: string }[] {
    const units: { name?: string }[] = [];
    for (const o of operands) {
      // an inline array literal is transparent: its elements are the fused operands (an ident element is
      // nameable exactly like a top-level ident operand). This is the `quorum(2, [j1, j2, j3])` form —
      // the elements j1/j2/j3 are declarable and are covered by `independent j1, j2, j3`.
      if (o.kind === "arraylit") { units.push(...this.fusedCredenceUnits(o.items, scope)); continue; }
      const cls = this.infer(o, scope);
      // a bare Credence identifier: one nameable, coverable unit.
      if (o.kind === "ident" && cls === "credence") { units.push({ name: o.name }); continue; }
      // an array<Credence<…>>-typed VARIABLE or query result (a non-literal `all(arr)`/`quorum(k, arr)`
      // source): its element count is NOT statically known (0, 1, or many), so we cannot PROVE it fuses
      // two-or-more credences — contribute nothing and defer to the runtime, staying conservative (the
      // checker must never false-reject a length-0/1 array fuse, §15.3). The fused value stays `graded`
      // and is still blocked at any sink until a gate. Only the statically-enumerable forms (array literals
      // and comma-lists, handled above/below) can trigger the coverage TypeError.
      if (cls === "credarray") continue;
      // any other provably-credence-producing operand (a nested `all`/`any`/`quorum`, or a `send` in a fuse
      // position — the only non-bool thing `all`/`any` fuse is a Credence<bool>): one ANONYMOUS unit.
      if (cls === "credence") { units.push({}); continue; }
      if (o.kind === "send") { units.push({}); continue; }
      // otherwise (unknown) contribute nothing — conservative (never a false reject, §15.3).
    }
    return units;
  }

  // T-Fuse coverage (§12, §15.3.2): fusing two-or-more `Credence`s is ILL-FORMED (TypeError) unless every
  // unordered pair is covered by SOME independent- or dependent-declaration in scope. Coverage is total —
  // C(n,2) pairs, not merely "at least one declaration exists." A pair is UNCOVERED when either unit is
  // anonymous (no declaration can name it) or no in-scope group contains both names. Fires only over
  // PROVABLY-credence units (conservative: an unknown operand contributes no unit and cannot trigger it).
  private checkFusionCoverage(units: { name?: string }[], scope: Scope): void {
    const groups = scope.allDepGroups();
    const covered = (a?: string, b?: string): boolean =>
      a !== undefined && b !== undefined && groups.some((g) => g.includes(a) && g.includes(b));
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        const a = units[i]!.name, b = units[j]!.name;
        // NOTE: a name fused with ITSELF (`all(c1, c1)`, two Credence positions) is NOT trivially covered —
        // §12 requires a total declaration over every fused pair, and `c1` self-fused still needs `c1` to
        // appear in SOME independent/dependent group (covered(c1,c1) is true iff c1 is declared). A bare
        // undeclared self-fuse is a §12 TypeError like any other uncovered pair.
        if (!covered(a, b)) {
          const label = (n?: string) => n ?? "an unnameable fused credence (a send/nested-fuse/array element)";
          throw typeError(
            `fusion of Credence values requires a total dependence declaration (§12): the pair ` +
            `(${label(a)}, ${label(b)}) is neither independent- nor dependent-declared — ` +
            `declare every fused pair by name before fusing`,
          );
        }
      }
    }
  }

  private isVariant(name: string): boolean {
    for (const vs of this.d.enums.values()) if (vs.includes(name)) return true;
    return false;
  }

  // ---- §13 dependency-scope provenance ----

  // Record what a `var NAME = init` binding depends on, for the §13 endorse dependency-scope check:
  //  - a memory READ (`->` recall, `select`/`find`, `match`) makes NAME a TAINTED, subjective fact (§10).
  //  - a Credence-producing expr (a send `<-`, or a fusion/aggregation over credences) records NAME's
  //    dependency scope = the free identifiers feeding it (e.g. a `draft` interpolated into the prompt).
  //  - a `decide c by R` records NAME's scope = c's own scope ∪ { c } (the decision inherits the credence's
  //    dependency scope), so endorsing any subject in that scope is in-scope.
  // Taint flows through to any binding derived from a tainted binding (contagious, §15.3.1).
  // Model-A narrowing target: if `cond` is `IDENT.committed == VARIANT` with VARIANT a real (non-`abstained`)
  // enum variant or bool literal, return IDENT so the TRUE branch can mark it committed-narrowed. Any other
  // condition narrows nothing.
  private committedNarrowIdent(cond: A.Expr): string | undefined {
    if (cond.kind !== "binary" || cond.op !== "==") return undefined;
    const committedIdent = (e: A.Expr): string | undefined =>
      e.kind === "member" && e.field === "committed" && e.obj.kind === "ident" ? e.obj.name : undefined;
    const leftName = committedIdent(cond.left);
    const name = leftName ?? committedIdent(cond.right);
    if (!name) return undefined;
    const other = leftName ? cond.right : cond.left;
    const variant = other.kind === "ident" ? other.name : other.kind === "bool" ? String(other.value) : undefined;
    if (!variant || variant === "abstained") return undefined;
    return name;
  }

  private trackProvenance(name: string, init: A.Expr, scope: Scope, declared?: Cls): void {
    const free = this.freeIdents(init);
    // set-or-clear so a reassignment refreshes provenance to the new value (not sticky per name).
    // A `send` bound to a `Credence<E>` slot is the SANCTIONED graded gate path (§13) — not marked here;
    // but a `send` bound to a RAW `text` slot is a raw reply that must be re-decided and endorsed BY A
    // DECISION ABOUT IT (§13). Endorsing it by a decision about something else is laundering, so a raw
    // send-reply binding is tracked as tainted for the endorse dependency-scope check.
    // A send bound to an `Endorsement<T>` slot is a delegated task completed WITH an endorsement — a
    // settled, ledger-backed subject (§6c); it is not a raw reply. The runtime verifies the completed
    // value really is an endorsement (anything else stays raw at the sink).
    const rawSendReply = init.kind === "send" && declared !== "credence" && declared !== "endorsement";
    scope.setTaintedTo(name, this.isTaintedExpr(init, scope) || rawSendReply);
    if (init.kind === "endorse") {
      // Model A (§13/§15.3.3): an endorsement is the SETTLED form of its subject. Construction already
      // required a committed-narrowed Decision, so the binder is sink-admissible immediately. The raw SUBJECT
      // (e.g. `draft`) keeps its own taint, so performing the raw subject directly is still a TaintViolation.
      scope.setTaintedTo(name, false);
      scope.setScope(name, free);
    } else if (init.kind === "decide") {
      scope.setScope(name, this.scopeOfDecision(init, scope));
      // §13: a sealed Decision about a credence puts the ARTIFACTS that fed that credence's prompt UNDER
      // JUDGMENT — the Decision alone does not settle them, so performing the RAW artifact (bypassing an
      // `endorse` of this decision, or in a non-endorsing arm) is a TaintViolation. Mark them tainted so the
      // consequential-sink check catches a raw perform; only the endorsement binder settles the subject.
      if (init.credence.kind === "ident") {
        const credScope = scope.getScope(init.credence.name);
        if (credScope) for (const id of credScope) scope.markTainted(id);
      }
    } else if (init.kind === "send") {
      // a Credence/raw send: its dependency scope is the free identifiers of the message (the prompt).
      scope.setScope(name, free);
    } else {
      // a fusion/aggregation or any other producer: its scope is its free identifiers (best effort).
      scope.setScope(name, free);
    }
  }

  // Whether the VALUE of an expression carries tainted (un-endorsed, subjective) provenance: a direct
  // memory read (recall/select), a raw send reply (a `<-` before it is bound to a Credence
  // slot — see isMemoryRead's note), or anything derived from an already-tainted binding (contagious,
  // §15.3.1). Used for both `var` and `assign`, so `u = t` (t a recall) taints `u` exactly like a `var`.
  private isTaintedExpr(e: A.Expr, scope: Scope): boolean {
    if (this.isMemoryRead(e)) return true;
    for (const id of this.freeIdents(e)) if (scope.isTainted(id)) return true;
    return false;
  }

  // The dependency scope of a `decide c by R`: c's recorded scope ∪ the free idents of c (so `c` itself,
  // and anything that fed c, count as in-scope subjects for a later `endorse subject by d`).
  private scopeOfDecision(d: A.DecideExpr, scope: Scope): Set<string> {
    const out = new Set<string>(this.freeIdents(d.credence));
    if (d.credence.kind === "ident") {
      const cs = scope.getScope(d.credence.name);
      if (cs) for (const id of cs) out.add(id);
    }
    return out;
  }

  // §13: the endorsed subject must lie in the endorsing decision's dependency scope — "a decision about
  // `other_response` cannot endorse `response`". This is enforced CONSERVATIVELY: it fires ONLY when the
  // subject is a provably TAINTED memory-provenance binding (a recall/query result) that is provably
  // OUTSIDE the decision's scope. When the subject is a settled value, the credence itself, in scope, or the
  // scope is unknown, the endorsement is admitted — so no `accept` test is ever false-rejected.
  private checkEndorseScope(e: A.EndorseExpr, scope: Scope): void {
    const subjectIds = [...this.freeIdents(e.subject)].filter((id) => scope.isTainted(id));
    if (subjectIds.length === 0) return; // subject carries no tainted memory provenance — admissible
    // resolve the decision's dependency scope; an inline `(c by R)` decision is its own decide expr.
    let depScope: Set<string> | undefined;
    if (e.decision.kind === "ident") depScope = scope.getScope(e.decision.name);
    else if (e.decision.kind === "decide") depScope = this.scopeOfDecision(e.decision, scope);
    if (depScope === undefined) return; // dynamic/unknown scope — do not false-reject (§13 escape hatch)
    for (const id of subjectIds) {
      if (!depScope.has(id)) {
        throw gateError(
          `endorse: the subject '${id}' is outside the endorsing decision's dependency scope — a decision about ` +
          `something else cannot settle it for a sink (§13/§20.3); re-decide it on its own credence`,
        );
      }
    }
  }

  // Abstinence is a decision outcome, not an endorsement. A subject can be endorsed only after the
  // Decision has been flow-narrowed to a real committed variant (`if (d.committed == V) { endorse ... }`).
  private checkEndorseCommitted(e: A.EndorseExpr, scope: Scope): void {
    if (e.decision.kind === "ident" && scope.isCommittedDecision(e.decision.name)) return;
    throw typeError("endorse requires a Decision narrowed to a committed variant; an abstained Decision has no endorsement to give (§13)");
  }

  // Whether an expression is a direct memory READ that yields a tainted, subjective fact (§10). A raw
  // `send` reply is also tainted, but only when it is NOT bound to a Credence slot — that split is handled
  // in trackProvenance because it needs the declared slot type.
  private isMemoryRead(e: A.Expr): boolean {
    return e.kind === "recall";
  }

  // The free identifiers referenced anywhere in an expression (best-effort; used for dependency scope).
  private freeIdents(e: A.Expr): Set<string> {
    const out = new Set<string>();
    const walk = (x: A.Expr): void => {
      switch (x.kind) {
        case "ident": out.add(x.name); return;
        case "member": walk(x.obj); return;
        case "index": walk(x.obj); walk(x.index); return;
        case "binary": walk(x.left); walk(x.right); return;
        case "unary": walk(x.operand); return;
        case "call": walk(x.callee); for (const a of x.args) walk(a); return;
        case "send": walk(x.dest); walk(x.message); return;
        case "recall": walk(x.mem); walk(x.query); return;
        case "decide": walk(x.credence); return;
        case "endorse": walk(x.subject); walk(x.decision); return;
        case "structlit": for (const f of x.fields) walk(f.value); return;
        case "fstring": for (const p of x.parts) if (p.kind === "expr") walk(p.expr); return;
        case "select": for (const c of x.cond) walk(c.value); return;
        // §12 aggregation surface — walk operands so §13 dependency-scope provenance stays correct
        // if a fused credence is later endorsed.
        case "agg": for (const o of x.operands) walk(o); return;
        case "quorum": walk(x.source); return;
        case "pipe": walk(x.source); walk(x.fn); return;
        case "arraylit": for (const it of x.items) walk(it); return;
        case "tasklit": if (x.objective) walk(x.objective); if (x.acceptance) walk(x.acceptance); return;
        case "performexpr": for (const a of x.args) walk(a); return;
        default: return;
      }
    };
    walk(e);
    return out;
  }
}
