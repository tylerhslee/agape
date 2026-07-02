// AST — the abstract syntax produced by the parser (a v0 subset of SPEC.md §15.2).

import type { Pos } from "./lexer.js";

export interface Node {
  pos: Pos;
}

// ---- Types ----
export type TypeRef =
  | { kind: "scalar"; name: "int" | "float" | "bool" | "text" | "null" }
  | { kind: "mem" } // a private-memory handle (§10)
  | { kind: "event"; inner: TypeRef } // legacy/deprecated: surface `event<T>` is rejected by the parser
  | { kind: "array"; inner: TypeRef }
  | { kind: "credence"; enumName: string }
  | { kind: "decision"; enumName: string }
  | { kind: "endorsement"; inner: TypeRef }
  | { kind: "named"; name: string; typeArgs?: TypeRef[] }; // enum/struct/agent/action/Principal/LedgerEntry; typeArgs at a generic-instantiation site (§19.5)

// ---- Program & declarations ----
export interface Program extends Node {
  kind: "program";
  // an optional leading `module modpath;` header (§19.2). A dotted name (e.g. "explicit.root");
  // undefined = the implicit root module (a file with no header and no import). Backward-compatible:
  // an unmodified single-module program leaves it undefined and is byte-identical to before.
  module?: string;
  // the header `import*` block (§19.2/§19.2a). Absent/empty for a program with no imports.
  imports?: ImportDecl[];
  decls: Decl[];
  stmts: Stmt[]; // top-level statements (spawn/awake/...)
}

// An `import` header (§19.2/§19.2a). `pub import` re-exports (whole prefix or selective). `selective`
// present (a name list) = `import { A, B } from M`; absent = a whole-module import `import M (as X)?`.
export interface ImportDecl extends Node {
  kind: "import";
  pub: boolean; // `pub import …` re-exports into this module's public surface (§19.2a)
  module: string; // the imported module's (possibly dotted) modpath
  selective?: string[]; // the selectively-imported bare names, when `import { … } from M`
  alias?: string; // the rebound prefix, when `import M as X` (whole-module only)
}

export type Decl = EnumDecl | StructDecl | ActionDecl | EventDecl | AgentDecl | InstructionDecl | ToolDecl | FnDecl | InterfaceDecl | PrincipalDecl | PromptDecl | ConfDecl | PolicyDecl;

// `principal NAME config?;` (§3, grammar §15.2 line 1463) — declares an accountable identity, a
// declared dependency bound to an identity backend by config (§17.1). Opaque, unforgeable,
// declared-not-constructed; used at a `decide c by NAME` (or the prefix `NAME decide …`) site (§13).
export interface PrincipalDecl extends Node {
  kind: "principal";
  name: string;
}
// `prompt TYPE NAME;` (§5b, grammar §15.2 line 1459) — opens a standing external input sensor. Its
// arrivals land `Prompt` events subjected `NAME`; `when (Prompt p about NAME)` subscribes. TYPE-first.
export interface PromptDecl extends Node {
  kind: "prompt";
  type: TypeRef;
  name: string;
}
// `conformal Number;` (grammar §15.2 line 1416 confdecl) — the file-level default conformal α (§20).
// Parse-only in v0: it carries the default α but drives no runtime effect (per-gate `by conformal α`
// still overrides it at the gate).
export interface ConfDecl extends Node {
  kind: "conformal";
  alpha: number;
}
// `policy NAME { threshold θ | margin δ | floor m }` (§13) — a named, reusable decision rule bundle in
// SOURCE (never the manifest, §17.2). `decide c by NAME` applies it: commit iff score ≥ threshold AND margin
// ≥ δ AND margin ≥ floor; a margin below `floor` abstains (the typed trigger for escalation, §13).
export interface PolicyDecl extends Node {
  kind: "policydecl";
  name: string;
  threshold?: number;
  margin?: number;
  floor?: number;
}

export interface EnumDecl extends Node {
  kind: "enum";
  name: string;
  variants: string[];
  pub?: boolean;
}
export interface StructDecl extends Node {
  kind: "struct";
  name: string;
  fields: Field[];
  typarams?: string[]; // type parameters `<A, B, …>` — empty/absent when non-generic (§19.5)
  pub?: boolean;
}
export interface Field {
  type: TypeRef;
  name: string;
}
export interface ActionDecl extends Node {
  kind: "action";
  name: string;
  fields: Field[];
  reversible: boolean;
  pub?: boolean;
}
export interface EventDecl extends Node {
  kind: "event";
  name: string;
  fields: Field[];
  errorSuper: boolean; // `: Error` — a valid Error-supertype leaf (§19.5)
  superName?: string;  // the raw supertype ident as written, when a supertype was declared (`: X`).
                       // A non-`Error` supertype is a TypeError diagnosed in the checker (§19.5/§19.6),
                       // NOT a ParseError — the parser only records the name.
  pub?: boolean;
}
export interface InstructionDecl extends Node {
  kind: "instruction";
  text: string;
}
// A tool — the world dependency (§6b). The effect class is mandatory.
export interface ToolDecl extends Node {
  kind: "tool";
  effect: "read" | "write";
  reversible: boolean;
  ret: TypeRef;
  name: string;
  params: Field[];
  pub?: boolean;
}
// A minimal function declaration (§15.2). Only `sync`-color checking is modeled here.
export interface FnDecl extends Node {
  kind: "fn";
  sync: boolean;
  ret: TypeRef;
  name: string;
  params: Field[];
  body: Stmt[];
  typarams?: string[]; // type parameters `<A, …>` — empty/absent when non-generic (§19.5)
  pub?: boolean;
}
// An interface names an agent's external surface (§19.5): the events it handles and the outcome each
// produces, plus the powers it `requires`. A TYPE (usable as a binding/param/reach target) but NOT
// instantiable. Not generic. Erases after checking.
export interface InterfaceDecl extends Node {
  kind: "interface";
  name: string;
  members: IfMember[];
  pub?: boolean;
}
export type IfMember =
  | { kind: "handler"; event: TypeRef; outcome: TypeRef } // `when EVENT decide RESULT`
  | { kind: "requires"; cap: "perform" | "reach" | "use"; name: string }; // `requires cap NAME`
export interface AgentDecl extends Node {
  kind: "agent";
  name: string;
  grants: Grant[] | "all"; // [] = default-deny; "all" = grants { * }
  params: Field[]; // constructor params `agent Boss(Worker hand)` — bound at spawn (E-Spawn §15.4.2)
  fields: Field[];
  hooks: OnHook[];
  whens: WhenStmt[];
  instructions: string[];
  ctor: Stmt[]; // the agent-body constructor statements (run at spawn, E-Spawn §15.4.2)
  extends?: { name: string; args: Expr[] }; // `extend NAME(args);` — subtractive inheritance (§5, §13)
  ifaces?: string[]; // implemented interfaces (`: Iface, …`) — nominal conformance (§19.5)
  pub?: boolean;
}
export type Grant =
  | { cap: "perform"; name: string }
  | { cap: "reach"; name: string }
  | { cap: "use"; name: string };

// ---- Statements ----
export type Stmt =
  | VarDecl
  | AssignStmt
  | SpawnStmt
  | AwakeStmt
  | SleepStmt
  | EmitStmt
  | PerformStmt
  | SayStmt
  | ReturnStmt
  | IfStmt
  | DispatchStmt
  | WhenStmt
  | MemDecl
  | ForgetStmt
  | DepDeclStmt
  | RetryStmt
  | ExprStmt;

// `{ block } retry(N)` (§11, §15.2) — the ONLY loop, bounded: re-attempt the block up to N times on a fault
// (an `Error`, e.g. a `TypeMismatch` from a malformed reply); on exhaustion, emit `RetryExhausted` and the
// fault propagates. Every Agape program terminates because this is the sole loop and N is a literal bound.
export interface RetryStmt extends Node {
  kind: "retry";
  body: Stmt[];
  n: number;
}

// `("independent"|"dependent") Ident ("," Ident)* ";"` — declare the dependence structure of the
// values fused by `all`/`any`/`quorum` (§12, §15.2 depdecl). A static assertion consumed by the
// T-Fuse coverage check; it produces no runtime effect and no ledger event of its own.
export interface DepDeclStmt extends Node {
  kind: "depdecl";
  relation: "independent" | "dependent";
  names: string[];
}

// `mem NAME [<- EXPR];` — declare a private-memory handle, optionally initialized (§10).
export interface MemDecl extends Node {
  kind: "memdecl";
  name: string;
  init?: Expr;
}
// `forget NAME;` — tombstone a `mem` handle; consumes it (§10).
export interface ForgetStmt extends Node {
  kind: "forget";
  name: string;
}

export interface VarDecl extends Node {
  kind: "var";
  type: TypeRef;
  name: string;
  init?: Expr;
}
export interface AssignStmt extends Node {
  kind: "assign";
  target: Expr; // postfix lvalue
  value: Expr;
}
export interface SpawnStmt extends Node {
  kind: "spawn";
  agentType: string;
  name: string;
  args: Expr[];
}
export interface AwakeStmt extends Node {
  kind: "awake";
  name: string;
}
export interface SleepStmt extends Node {
  kind: "sleep";
  name: string;
}
export interface EmitStmt extends Node {
  kind: "emit";
  name: string;
  args: Expr[];
}
export interface PerformStmt extends Node {
  kind: "perform";
  name: string;
  args: Expr[];
}
export interface SayStmt extends Node {
  kind: "say";
  arg: Expr;
}
export interface ReturnStmt extends Node {
  kind: "return";
  value?: Expr;
}
export interface IfStmt extends Node {
  kind: "if";
  cond: Expr;
  then: Stmt[];
  else?: Stmt[];
}
export interface OnHook extends Node {
  kind: "on";
  event: "awake" | "sleep" | "crash";
  body: Stmt[];
}
export interface WhenStmt extends Node {
  kind: "when";
  etype: string;
  binder?: string;
  about?: Expr;
  guard?: Expr;
  body: Stmt[];
}

// gate sugar: `gate armblock (abstain block)?`
export interface DispatchStmt extends Node {
  kind: "dispatch";
  gate: GateExpr;
  arms: Arm[];
  abstain?: { binder?: string; body: Stmt[] };
}
export interface Arm {
  head: string; // a variant name, or "true"/"false"
  binder?: string; // `as e`
  body: Stmt[];
}
export interface ExprStmt extends Node {
  kind: "exprstmt";
  expr: Expr;
}

// ---- Expressions ----
export type Expr =
  | GateExpr
  | SendExpr
  | RecallExpr
  | SelectExpr
  | FindExpr
  | MatchExpr
  | StructLit
  | FStringExpr
  | StringLit
  | IntLit
  | FloatLit
  | BoolLit
  | NullLit
  | SelfExpr
  | IdentExpr
  | CallExpr
  | MemberExpr
  | IndexExpr
  | BinaryExpr
  | UnaryExpr
  | AggExpr
  | QuorumExpr
  | PipeExpr
  | ArrayLit;

// `("all"|"any") "(" expr ("," expr)* ")"` — reduce a comma-list of operands OR a single
// `array<Credence<bool>>` (§12, §15.2). Over plain `bool` it is ordinary conjunction/disjunction;
// over `Credence<bool>` it fuses evidence into a single `Credence<bool>` under the declared structure.
export interface AggExpr extends Node {
  kind: "agg";
  op: "all" | "any";
  operands: Expr[];
}
// `"quorum" "(" Int "," expr ")"` — "at least k of n commit," a thresholded reduction over the same
// fusion algebra as all/any (§12, §15.2).
export interface QuorumExpr extends Node {
  kind: "quorum";
  k: number;
  source: Expr;
}
// `expr "|>" expr` — pipe each element of a collection through `fn` (§12, §15.2).
export interface PipeExpr extends Node {
  kind: "pipe";
  source: Expr;
  fn: Expr;
}
// `"[" (expr ("," expr)*)? "]"` — an array literal (§15.2 primary), consumed by |>/all/any/quorum.
export interface ArrayLit extends Node {
  kind: "arraylit";
  items: Expr[];
}

// `MEM -> "query"` — recall from a private-memory handle (§10); always tainted.
export interface RecallExpr extends Node {
  kind: "recall";
  mem: Expr;
  query: Expr;
}
// `select COLS from TARGET where { COND }`, or `select Event as e from ledger where { e.field ... }`
// — a facts/ledger query (§10).
export interface SelectExpr extends Node {
  kind: "select";
  cols: string[] | "*";
  target: string; // an agent instance name, or `ledger`/`self`
  eventType?: string; // new ledger-row form: `select Held as h from ledger ...`
  alias?: string;
  cond: QueryCond[];
}
// `find x [, origin(x)] where { TRIPLE+ }` — a relationship-graph query (§10).
export interface FindExpr extends Node {
  kind: "find";
  binder: string;
  origin: boolean;
  triples: Triple[];
}
// `match VECTOR > θ` — a vector-store similarity query; a gate (§10).
export interface MatchExpr extends Node {
  kind: "match";
  vector: Expr;
  theta: number;
}
export interface StructLit extends Node {
  kind: "structlit";
  typeName?: string;
  typeArgs?: TypeRef[]; // `Box<int> { value: 7 }` — parsed for the non-generic check, erased past it (§19.5)
  fields: { name: string; value: Expr }[];
}
export interface QueryCond {
  field: string;
  op: string; // ==, !=, <, >, <=, >=  (a `:` desugars to ==)
  value: Expr;
  connective?: "&&" | "||"; // the connective JOINING this cond to the previous one
}
export interface Triple {
  subject: string;
  predicate: string;
  object: string;
}

export type GateExpr = DecideExpr | EndorseExpr;

export type Rule =
  // inline rules carry their optional consequential `floor m` (the runtime margin floor, §13) and,
  // for conformal, an optional `readiness N` (the labelled-case minimum before autonomous commit).
  | { kind: "confidence"; theta: number; margin?: number; floor?: number }
  | { kind: "conformal"; alpha?: number; readiness?: number; floor?: number }
  | { kind: "policy"; name: string }
  | { kind: "expr"; expr: Expr };

export interface DecideExpr extends Node {
  kind: "decide";
  principal?: string; // optional escalation prefix (a declared `principal` NAME)
  principalStr?: boolean; // the prefix was a STRING literal, not an ident — a TypeError (§3, §13): a principal
  //                         basis must be a declared `principal`, not a forgeable text claim.
  credence: Expr;
  rule: Rule;
}
export interface EndorseExpr extends Node {
  kind: "endorse";
  subject: Expr;
  decision: Expr;
}
export interface SendExpr extends Node {
  kind: "send";
  dest: Expr;
  message: Expr;
  expires?: number;
}
export interface FStringExpr extends Node {
  kind: "fstring";
  parts: ({ kind: "text"; text: string } | { kind: "expr"; expr: Expr })[];
}
export interface StringLit extends Node { kind: "string"; value: string; }
export interface IntLit extends Node { kind: "int"; value: number; }
export interface FloatLit extends Node { kind: "float"; value: number; }
export interface BoolLit extends Node { kind: "bool"; value: boolean; }
export interface NullLit extends Node { kind: "null"; }
export interface SelfExpr extends Node { kind: "self"; }
export interface IdentExpr extends Node { kind: "ident"; name: string; }
export interface CallExpr extends Node { kind: "call"; callee: Expr; args: Expr[]; }
export interface MemberExpr extends Node { kind: "member"; obj: Expr; field: string; }
export interface IndexExpr extends Node { kind: "index"; obj: Expr; index: Expr; } // `a[i]` element access (§10)
export interface BinaryExpr extends Node { kind: "binary"; op: string; left: Expr; right: Expr; }
export interface UnaryExpr extends Node { kind: "unary"; op: string; operand: Expr; }
