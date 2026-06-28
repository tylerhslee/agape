//! The Agape abstract syntax tree (SPEC-1.0 §15.2).
//!
//! The shape the parser produces. It covers the whole v1.0 surface: the three
//! seams (cognition `<-`, tool calls, identity `verify … by p`), the graded
//! judgment type `Credence<E>`, the gates `decide`/`verify`, `quorum`/fusion
//! with `independent`/`dependent` declarations, user nominal types
//! (`struct`/`enum`/`event`), capabilities (`grants { emit/reach/use }`), the
//! reactive/query constructs, and the somatic kernel (`while`/`array`).

/// A type annotation. `event<T>` marks spine presence; `Credence<E>` is a graded
/// judgment over enum `E` (§3); `array<T>` is the somatic aggregate.
#[derive(Debug, Clone, PartialEq)]
pub enum Type {
    Int,
    Float,
    Bool,
    Text,
    Null,
    /// A user/prelude type referenced by name (enum, struct, agent, `Principal`,
    /// `Rule`, `Verification`, `Entailment`, ...). The name may be qualified
    /// (`m.Name`) or a generic type parameter (§19.2, §19.5).
    Named(String),
    /// A generic instantiation `Name<T, ...>` (a monomorphized struct, §19.5).
    Generic(String, Vec<Type>),
    /// `event<T>` — present (or to be present) on the spine.
    Event(Box<Type>),
    /// `array<T>` — the one primitive aggregate.
    Array(Box<Type>),
    /// `Credence<E>` — a graded distribution over enum `E`'s variants (§3).
    Credence(Box<Type>),
    /// `Decision<E>` — a gate's committed outcome over enum `E` (§3, settled).
    Decision(Box<Type>),
}

/// Binary operators. There is no similarity operator in v1.0 (§2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
}

impl BinOp {
    pub fn from_str(s: &str) -> Option<BinOp> {
        Some(match s {
            "+" => BinOp::Add,
            "-" => BinOp::Sub,
            "*" => BinOp::Mul,
            "/" => BinOp::Div,
            "==" => BinOp::Eq,
            "!=" => BinOp::Ne,
            "<" => BinOp::Lt,
            ">" => BinOp::Gt,
            "<=" => BinOp::Le,
            ">=" => BinOp::Ge,
            _ => return None,
        })
    }
    pub fn is_comparison(s: &str) -> bool {
        matches!(s, "==" | "!=" | "<" | ">" | "<=" | ">=")
    }
}

/// The parameter a gate decides by (`by` clause / `decide` rule, §3, §13).
/// `rule ::= cmpop Number ("margin" Number)? | expr`.
#[derive(Debug, Clone, PartialEq)]
pub enum GateBasis {
    /// `> 0.8` / `> 0.8 margin 0.1` / `confidence 0.8 margin 0.1` — a
    /// threshold/margin `Rule` written as sugar.
    Threshold { op: BinOp, value: f64, margin: f64 },
    /// `conformal α` — the conformal basis; calibrates from the spine, abstains
    /// below its readiness floor (§13).
    Conformal { alpha: f64 },
    /// A named `policy`, a `Rule` value, or (for `verify`/`attest … by p`) a `Principal`.
    Value(Box<Expr>),
}

/// Expressions.
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Int(i64),
    Float(f64),
    Bool(bool),
    Null,
    Str(String),
    /// An f-string template (raw text incl. `{expr}` placeholders).
    FStr(String),
    Name(String),
    /// `self` — an agent's reference to itself.
    SelfRef,
    Binary { op: BinOp, left: Box<Expr>, right: Box<Expr> },
    /// Logical negation `!e`.
    Not(Box<Expr>),
    Call { func: Box<Expr>, args: Vec<Expr> },
    Member { obj: Box<Expr>, prop: String },
    Index { obj: Box<Expr>, index: Box<Expr> },
    /// `[a, b, c]` — array literal.
    Array(Vec<Expr>),
    /// `Name { field: v, ... }` — a struct literal (all fields required, §3).
    StructLit { name: String, fields: Vec<(String, Expr)> },
    /// `dest <- payload [expires N] [retry…]` — the one send operator (§6).
    Send {
        dest: Box<Expr>,
        payload: Box<Expr>,
        expires: Option<f64>,
        retry: Option<Box<RetryTail>>,
    },
    /// `source |> func` — concurrent fan-out over a collection (§12).
    Pipe { source: Box<Expr>, func: Box<Expr> },
    /// `decide(e, rule)` — the somatic gate-collapse `P → U` (§13). Rule mandatory.
    Decide { expr: Box<Expr>, rule: GateBasis },
    /// `e by rule` — collapse a `Credence<E>` to a `Decision<E>` (§13): settled,
    /// off-spine, in hand, *unendorsed* (not recorded). Rule mandatory.
    Collapse { expr: Box<Expr>, rule: GateBasis },
    /// `endorse(e by rule)` — the recorded gate in expression position (§13):
    /// collapse + record, yielding an *endorsed* `Decision<E>`.
    EndorseExpr { arg: Box<Expr>, rule: GateBasis },
    /// `verify gatearg [by basis]` — the recorded gate (§13): `decide` + emit.
    /// `by` absent ⇒ default `Rule`; `by` a `Principal` ⇒ identity-seam attest.
    Verify { arg: Box<Expr>, by: Option<GateBasis> },
    /// `quorum(k of c1, …, cn)` — graded "at least k of n commit" (§12).
    Quorum { k: i64, judges: Vec<Expr> },
    /// A query used in expression position (yields its result set; lands nothing).
    Query(Box<Query>),
}

/// The three memory/spine query forms (§10).
#[derive(Debug, Clone, PartialEq)]
pub enum Query {
    /// `find BINDING [, origin(BINDING)] where { S P O; ... }` — graph query.
    Find { binding: String, origin: Option<String>, pattern: Vec<(String, String, String)> },
    /// `select COLS from SOURCE where { col op value, ... }` — fact/spine scan.
    Select { cols: Vec<String>, source: String, star: bool, conds: Vec<Cond> },
    /// `match { BINDING: QUERY } > THRESHOLD` — vector store; a gate (§10).
    Match { binding: String, query: Box<Expr>, threshold: f64 },
}

/// A `where`-clause condition: `col op value` or `col : value` (op == ":").
#[derive(Debug, Clone, PartialEq)]
pub struct Cond {
    pub col: String,
    pub op: String,
    pub value: Expr,
}

/// A grant entry kind (§13): emit an event, reach an agent, or use a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapKind {
    Emit,
    Perform,
    Reach,
    Use,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capability {
    pub kind: CapKind,
    pub target: String,
}

/// An `interface` member (§19.5): a handled-event→decision contract, or a
/// required capability.
#[derive(Debug, Clone, PartialEq)]
pub enum IfaceMember {
    /// `when EVENT decide RESULT` — the agent must have a `when (EVENT …)` handler.
    When { event: String, result: String },
    /// `requires CAP` — the capability must be in the implementor's `grants`.
    Requires(Capability),
}

/// A formal parameter (always `type name`).
#[derive(Debug, Clone, PartialEq)]
pub struct Param {
    pub ty: Type,
    pub name: String,
}

/// A struct/event field (`name: T` or `T name`).
#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub name: String,
    pub ty: Type,
}

/// Fusion dependence declaration (§12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dep {
    Independent,
    Dependent,
}

/// The tail of a send-retry, or a standalone `retry` block (§11).
#[derive(Debug, Clone, PartialEq)]
pub enum RetryTail {
    /// `retry(N) { body }` — bounded; a handler runs before each re-attempt.
    Bounded { count: i64, body: Vec<Stmt> },
    /// `retry(TYPE x: PRED) { body }` — unbounded predicate form (Turing complete).
    Predicate { ty: Type, bind: String, pred: Expr, body: Vec<Stmt> },
}

/// A tool's effect class (§6b): `read` observes the world (its result carries its
/// inputs' trust); `write` changes the world (a consequential sink whose inputs must
/// be settled). The class is mandatory on every `tool` declaration — never defaulted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolEffect {
    Read,
    Write,
}

/// Statements (and declarations — both are `decl`/`stmt` in §15.2).
#[derive(Debug, Clone, PartialEq)]
pub enum Stmt {
    /// `TYPE NAME [= EXPR];`
    VarDecl { ty: Type, name: String, expr: Option<Expr> },
    /// `[sync] RET NAME[<typarams>](params) { body }`.
    FnDecl { is_sync: bool, ret: Type, name: String, typarams: Vec<String>, params: Vec<Param>, body: Vec<Stmt> },
    /// `[pub] agent NAME [(params)] [: Iface, ...] [grants {...}] { body }`.
    AgentDecl {
        name: String,
        params: Vec<Param>,
        /// Implemented interfaces, nominal (`agent A : I, J`, §19.5).
        ifaces: Vec<String>,
        grants: Vec<Capability>,
        has_grants: bool,
        /// `grants { * }` — the explicit unconstrained opt-out (lattice top).
        unconstrained: bool,
        body: Vec<Stmt>,
    },
    /// `[pub] struct NAME[<typarams>] { field, ... }`.
    StructDecl { name: String, typarams: Vec<String>, fields: Vec<Field> },
    /// `enum NAME { A, B, ... }` — a closed variant set (no payloads in v1.0).
    EnumDecl { name: String, variants: Vec<String> },
    /// `event NAME(field, ...) [: Super];` — a custom spine-event type with typed
    /// payload; `error_super` ⇒ a leaf under the built-in `Error` root (§19.5).
    /// `super_name` carries any declared supertype spelling (for the non-`Error`
    /// rejection); `None` if no supertype.
    EventDecl { name: String, fields: Vec<Field>, error_super: bool, super_name: Option<String> },
    /// `interface NAME { (when EVENT decide RESULT | requires CAP);* }` (§19.5).
    InterfaceDecl { name: String, members: Vec<IfaceMember> },
    /// `[reversible] action NAME(field, ...);` — a performative event type (§3, §13);
    /// `perform`ing it is a consequential act needing the `perform NAME` power and a
    /// settled value. `reversible` marks a low-stakes sink (§20).
    ActionDecl { name: String, fields: Vec<Field>, reversible: bool },
    /// `[reversible] read|write tool RET NAME(params);` — a tool-seam capability (§6b).
    /// The effect class is mandatory; `reversible` marks a low-stakes write sink (§20).
    ToolDecl { name: String, params: Vec<Param>, ret: Option<Type>, effect: ToolEffect, reversible: bool },
    /// `conformal α;` — a file-level default conformal guarantee (§20).
    ConformalDecl(f64),
    /// `authority EventType;` — marks an event type consequential (§13).
    Authority(String),
    /// `principal NAME;` — an identity-seam principal binding (§13).
    Principal(String),
    /// `extend PARENT(args);` — composition/inheritance (first stmt of an agent).
    Extend { parent: String, args: Vec<Expr> },
    /// `spawn TYPE name (args)?;` — allocate + construct (args bound here, §5).
    Spawn { agent_type: String, name: String, args: Vec<Expr> },
    /// `awake NAME [(args)];`
    Awake { name: String, args: Vec<Expr> },
    /// `sleep NAME;`
    Sleep(String),
    /// `prompt TYPE name;` — an external input sensor (§5b).
    Prompt { ty: Type, name: String },
    /// `verify gatearg [by basis];` — the recorded gate (§13).
    Verify { arg: Expr, by: Option<GateBasis> },
    /// `emit EventType(payload);`
    Emit { event_type: String, payload: Expr },
    /// `endorse (arg by rule) { arms } [abstain { ... }]` — the recorded gate (§13):
    /// collapse the `Credence`, append `Decided`/`Abstained`, dispatch the arms.
    Endorse { arg: Expr, rule: GateBasis, arms: Vec<(String, Vec<Stmt>)>, abstain: Option<Vec<Stmt>> },
    /// `perform ActionType(payload);` — a consequential act (§13).
    Perform { action_type: String, payload: Expr },
    /// `attest e by PRINCIPAL (arms | ;)` — the recorded identity-seam gate (§13):
    /// reach the principal, record an `Attestation`/`FailedAttestation`. `by` is an
    /// expression so `by "alice"` parses (the checker rejects text→Principal, §3).
    Attest { arg: Expr, by: Expr, arms: Vec<(String, Vec<Stmt>)> },
    /// `policy NAME { threshold θ  margin δ  floor m  conformal α  readiness N  fallback p }`
    /// — a named decision-policy bundle (§13), source-level, not config.
    PolicyDecl {
        name: String,
        threshold: Option<f64>,
        margin: Option<f64>,
        floor: Option<f64>,
        conformal: Option<f64>,
        readiness: Option<i64>,
        fallback: Option<String>,
    },
    /// `{ ... }` — a bare lexical block (the body of a `{ block } retry(N)`, or a
    /// nested scope). Carries no looping by itself; `retry` wraps it.
    Block(Vec<Stmt>),
    /// `say(EXPR);`
    Say(Expr),
    /// `return [EXPR];`
    Return(Option<Expr>),
    /// `if (cond) { then } [else { else }]`
    If { cond: Expr, then_body: Vec<Stmt>, else_body: Vec<Stmt> },
    /// `TARGET = EXPR;`
    Assign { target: Expr, expr: Expr },
    /// `on awake { ... }` / `on sleep { ... }` / `on crash { ... }`
    On { event: String, body: Vec<Stmt> },
    /// `when (Type binder? [about subj]) [if (guard)] { ... }` — a prospective,
    /// typed subscription (§7). `binder` evaluates to the matched event's payload.
    When { ty: Type, binder: Option<String>, about: Option<Expr>, guard: Option<Expr>, body: Vec<Stmt> },
    /// `catch [EventType][(SUBJECT)] as BINDING { ... }`
    Catch { event_type: Option<String>, subject: Option<Expr>, binding: String, body: Vec<Stmt> },
    /// `case (EXPR) as BINDING { Variant: {..} ... [default: {..}] }`.
    Case { expr: Expr, binding: String, arms: Vec<(String, Vec<Stmt>)>, default: Option<Vec<Stmt>> },
    /// `retry(N) { ... }` / `retry(TYPE x: PRED) { ... }` — standalone block form.
    Retry(RetryTail),
    /// `independent a, b, c;` / `dependent a, b;` — fusion dependence (§12).
    DepDecl { kind: Dep, names: Vec<String> },
    /// A query in statement position (lands `QueryResult(subject)`, §10).
    QueryStmt(Query),
    /// `while (COND) { BODY }` — the imperative loop (somatic kernel).
    While { cond: Expr, body: Vec<Stmt> },
    /// `break;`
    Break,
    /// `module a.b;` — the module-path header (§19.2).
    ModuleDecl { path: String },
    /// `[pub] import m [as x];` / `[pub] import { A, B } from m;` (§19.2, §19.2a).
    Import {
        /// The module path imported from.
        module: String,
        /// `Some(alias)` for `import m as x;` (whole-module prefix rebind); `None`
        /// for a plain whole-module import or a selective import.
        alias: Option<String>,
        /// Selective names for `import { A, B } from m;`; empty ⇒ whole-module.
        names: Vec<String>,
        /// `pub import …` re-exports (§19.2a).
        is_pub: bool,
    },
    /// `[principal] decide EXPR [conformal α] { Variant: … default: … } [defer to p];`
    /// — the readable gate (§20). Desugars to the §13 engine.
    Decide {
        /// The collapsed `Credence` expression.
        expr: Expr,
        /// A principal subject (`p decide …`), if present.
        subject: Option<String>,
        /// A per-gate conformal α override.
        conformal: Option<f64>,
        /// The commit arms.
        arms: Vec<(String, Vec<Stmt>)>,
        /// The optional `default:` arm.
        default: Option<Vec<Stmt>>,
        /// A trailing `defer to p` principal, if present.
        defer_to: Option<String>,
    },
    /// `#!somatic` / `#!cognitive` — a module attribute.
    ModuleAttr { name: String },
    /// A `pub`-prefixed declaration (§19.4) — exports the wrapped decl's name. The
    /// inner statement is the actual declaration; `pub` only affects cross-module
    /// name visibility, never runtime behavior.
    Pub(Box<Stmt>),
    /// A bare expression statement (e.g. a send, a tool call, a query expr).
    ExprStmt(Expr),
}

impl Stmt {
    /// The declared name of a top-level declaration, if it has one (for module
    /// resolution / visibility, §19). Unwraps a `pub` wrapper.
    pub fn decl_name(&self) -> Option<&str> {
        match self {
            Stmt::Pub(inner) => inner.decl_name(),
            Stmt::FnDecl { name, .. }
            | Stmt::AgentDecl { name, .. }
            | Stmt::StructDecl { name, .. }
            | Stmt::EnumDecl { name, .. }
            | Stmt::EventDecl { name, .. }
            | Stmt::ActionDecl { name, .. }
            | Stmt::ToolDecl { name, .. }
            | Stmt::InterfaceDecl { name, .. } => Some(name),
            _ => None,
        }
    }
}
