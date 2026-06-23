//! The Agape abstract syntax tree.
//!
//! This is the shape the parser produces. It covers the language's core surface;
//! the remaining reactive/query constructs (`when`, `catch`, `case`, `retry`,
//! `find`, `select`, `match`) have node types reserved here and are on the
//! parser roadmap (see `README.md`).

/// A type annotation. `event<T>` marks spine presence (SPEC §1), orthogonal to
/// the sync/async color of functions.
#[derive(Debug, Clone, PartialEq)]
pub enum Type {
    Int,
    Float,
    Bool,
    Text,
    Null,
    /// A user-defined / prelude type referenced by name (e.g. `Verification`).
    Named(String),
    /// `event<T>` — a value that is (or will be) present on the spine.
    Event(Box<Type>),
}

/// Binary operators, including the semantic similarity operator `~`.
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
    /// Semantic similarity (`~`) — returns bool; reaches the seam (async).
    Similar,
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
            "~" => BinOp::Similar,
            _ => return None,
        })
    }
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
    /// `dest <- payload` — the one send operator.
    Send { dest: Box<Expr>, payload: Box<Expr> },
    /// `answer entail claim` — three-valued entailment (async, spine-emitting).
    Entail { expr: Box<Expr>, claim: Box<Expr> },
    /// `source |> func` — concurrent fan-out over a collection.
    Pipe { source: Box<Expr>, func: Box<Expr> },
}

/// A formal parameter: a type and a name.
#[derive(Debug, Clone, PartialEq)]
pub struct Param {
    pub ty: Type,
    pub name: String,
}

/// Statements.
#[derive(Debug, Clone, PartialEq)]
pub enum Stmt {
    /// `TYPE NAME = EXPR;` (EXPR optional for a bare slot declaration).
    VarDecl { ty: Type, name: String, expr: Option<Expr> },
    /// `[sync] RET NAME(params) { body }`. `sync` asserts cognition-freedom.
    FnDecl {
        is_sync: bool,
        ret: Type,
        name: String,
        params: Vec<Param>,
        body: Vec<Stmt>,
    },
    /// `agent NAME(params) { body }`.
    AgentDecl { name: String, params: Vec<Param>, body: Vec<Stmt> },
    /// `extend PARENT(args);` — composition/inheritance inside an agent.
    Extend { parent: String, args: Vec<Expr> },
    /// `spawn TYPE name(args);`
    Spawn { agent_type: String, name: String, args: Vec<Expr> },
    /// `awake NAME;`
    Awake(String),
    /// `sleep NAME;`
    Sleep(String),
    /// `verify LEFT [op RIGHT];` — `op` is `~` or `==`, or absent (bool check).
    Verify { left: Expr, op: Option<BinOp>, right: Option<Expr> },
    /// `emit EventType(payload);`
    Emit { event_type: String, payload: Expr },
    /// `say(EXPR);`
    Say(Expr),
    /// `return EXPR;`
    Return(Option<Expr>),
    /// `if (cond) { then } [else { else }]`
    If { cond: Expr, then_body: Vec<Stmt>, else_body: Vec<Stmt> },
    /// A bare expression used as a statement (e.g. a send).
    ExprStmt(Expr),
}
