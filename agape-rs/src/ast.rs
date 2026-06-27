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
    /// `Rule`, `Verification`, `Entailment`, ...).
    Named(String),
    /// `event<T>` — present (or to be present) on the spine.
    Event(Box<Type>),
    /// `array<T>` — the one primitive aggregate.
    Array(Box<Type>),
    /// `Credence<E>` — a graded distribution over enum `E`'s variants (§3).
    Credence(Box<Type>),
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
    /// `> 0.8` / `> 0.8 margin 0.1` — a threshold/margin `Rule` written as sugar.
    Threshold { op: BinOp, value: f64, margin: f64 },
    /// A `Rule` value, or (for `verify … by p`) a `Principal`.
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
    Reach,
    Use,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capability {
    pub kind: CapKind,
    pub target: String,
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

/// Statements (and declarations — both are `decl`/`stmt` in §15.2).
#[derive(Debug, Clone, PartialEq)]
pub enum Stmt {
    /// `TYPE NAME [= EXPR];`
    VarDecl { ty: Type, name: String, expr: Option<Expr> },
    /// `[sync] RET NAME(params) { body }`.
    FnDecl { is_sync: bool, ret: Type, name: String, params: Vec<Param>, body: Vec<Stmt> },
    /// `agent NAME [(params)] [grants {...}] { body }`.
    AgentDecl {
        name: String,
        params: Vec<Param>,
        grants: Vec<Capability>,
        has_grants: bool,
        /// `grants { * }` — the explicit unconstrained opt-out (lattice top).
        unconstrained: bool,
        body: Vec<Stmt>,
    },
    /// `struct NAME { field, ... }`.
    StructDecl { name: String, fields: Vec<Field> },
    /// `enum NAME { A, B, ... }` — a closed variant set (no payloads in v1.0).
    EnumDecl { name: String, variants: Vec<String> },
    /// `event NAME(field, ...);` — a custom spine-event type with typed payload.
    EventDecl { name: String, fields: Vec<Field> },
    /// `tool RET NAME(params);` — a tool-seam capability (§6b).
    ToolDecl { name: String, params: Vec<Param>, ret: Option<Type> },
    /// `authority EventType;` — marks an event type consequential (§13).
    Authority(String),
    /// `principal NAME;` — an identity-seam principal binding (§13).
    Principal(String),
    /// `extend PARENT(args);` — composition/inheritance (first stmt of an agent).
    Extend { parent: String, args: Vec<Expr> },
    /// `spawn TYPE name;` — allocate only (args bound at awake).
    Spawn { agent_type: String, name: String },
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
    /// `say(EXPR);`
    Say(Expr),
    /// `return [EXPR];`
    Return(Option<Expr>),
    /// `if (cond) { then } [else { else }]`
    If { cond: Expr, then_body: Vec<Stmt>, else_body: Vec<Stmt> },
    /// `TARGET = EXPR;`
    Assign { target: Expr, expr: Expr },
    /// `on awake { ... }` / `on sleep { ... }`
    On { event: String, body: Vec<Stmt> },
    /// `when [EventType](SUBJECT) { ... }`
    When { event_type: Option<String>, subject: Expr, body: Vec<Stmt> },
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
    /// `import "path";` — file = module.
    Import { path: String },
    /// `#!somatic` / `#!cognitive` — a module attribute.
    ModuleAttr { name: String },
    /// A bare expression statement (e.g. a send, a tool call, a query expr).
    ExprStmt(Expr),
}
