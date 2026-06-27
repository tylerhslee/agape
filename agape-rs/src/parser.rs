//! Recursive-descent parser (M2): tokens → [`ast`] nodes, per SPEC-1.0 §15.2.
//!
//! Errors are `AgapeError` of class `Parse`. Notable v1.0 surface: the gates
//! `decide(e, rule)` / `verify gatearg [by basis]`, `quorum(k of …)`, user
//! `struct`/`enum`/`event` and `tool` declarations, `Credence<E>`, the three
//! grant kinds (`emit`/`reach`/`use`), `spawn TYPE name;` (args bound at
//! `awake`), and the retired `~`/`entail`/`calibrate` (which now fail to parse).

use crate::ast::*;
use crate::diag::{AgapeError, ErrorClass, Span};
use crate::lexer::{Token, TokenKind};

type PResult<T> = Result<T, AgapeError>;

/// Scalar/aggregate type keywords that begin a declaration. (`event` is handled
/// separately because `event Name(...)` is a type *declaration*, not a vardecl.)
const TYPE_KEYWORDS: &[&str] = &["int", "float", "bool", "text", "null", "array"];

fn is_lvalue(e: &Expr) -> bool {
    matches!(e, Expr::Name(_) | Expr::Member { .. } | Expr::Index { .. } | Expr::SelfRef)
}

pub struct Parser {
    toks: Vec<Token>,
    pos: usize,
}

/// Parse a token stream into a list of top-level statements.
pub fn parse(toks: Vec<Token>) -> PResult<Vec<Stmt>> {
    Parser::new(toks).program()
}

/// Parse a single expression (used by the f-string interpolator at runtime).
pub fn parse_expr(toks: Vec<Token>) -> PResult<Expr> {
    let mut p = Parser::new(toks);
    let e = p.expr()?;
    if !p.at_eof() {
        return Err(p.err("trailing tokens after expression"));
    }
    Ok(e)
}

impl Parser {
    pub fn new(toks: Vec<Token>) -> Self {
        Parser { toks, pos: 0 }
    }

    // ── cursor helpers ─────────────────────────────────────────────────────────

    fn cur(&self) -> &Token {
        &self.toks[self.pos]
    }
    fn peek(&self, k: usize) -> &Token {
        let idx = (self.pos + k).min(self.toks.len() - 1);
        &self.toks[idx]
    }
    fn at_eof(&self) -> bool {
        self.cur().kind == TokenKind::Eof
    }
    fn advance(&mut self) -> Token {
        let t = self.toks[self.pos].clone();
        if self.pos < self.toks.len() - 1 {
            self.pos += 1;
        }
        t
    }
    fn check_op(&self, op: &str) -> bool {
        self.cur().is_op(op)
    }
    fn check_kw(&self, kw: &str) -> bool {
        self.cur().is_kw(kw)
    }
    fn eat_op(&mut self, op: &str) -> PResult<()> {
        if self.check_op(op) {
            self.advance();
            Ok(())
        } else {
            Err(self.err(&format!("expected '{op}'")))
        }
    }
    fn eat_kw(&mut self, kw: &str) -> PResult<()> {
        if self.check_kw(kw) {
            self.advance();
            Ok(())
        } else {
            Err(self.err(&format!("expected keyword '{kw}'")))
        }
    }
    fn eat_ident(&mut self) -> PResult<String> {
        if self.cur().kind == TokenKind::Ident {
            Ok(self.advance().value)
        } else {
            Err(self.err("expected identifier"))
        }
    }
    /// A binder name (function/variable). The query verbs `find`/`select`/`match`
    /// are statement-leading keywords but harmless as ordinary names elsewhere, so
    /// they may shadow as binders (a contextual-keyword accommodation: e.g. a
    /// function may be named `find`). The call site disambiguates a query verb
    /// followed by `(` as a call (see `primary`).
    fn eat_binder(&mut self) -> PResult<String> {
        let t = self.cur();
        if t.kind == TokenKind::Ident
            || (t.kind == TokenKind::Keyword && matches!(t.value.as_str(), "find" | "select" | "match"))
        {
            Ok(self.advance().value)
        } else {
            Err(self.err("expected a name"))
        }
    }
    /// Consume a contextual word (an identifier with a specific spelling).
    fn eat_ctx(&mut self, word: &str) -> PResult<()> {
        if self.cur().is_ident(word) {
            self.advance();
            Ok(())
        } else {
            Err(self.err(&format!("expected '{word}'")))
        }
    }
    fn err(&self, what: &str) -> AgapeError {
        let t = self.cur();
        let span = if t.kind == TokenKind::Eof { Span::new(t.span.start, t.span.end) } else { t.span };
        AgapeError::at(ErrorClass::Parse, span, format!("{what}, got {} ({:?})", t.value, t.kind))
    }

    // ── program / statements ───────────────────────────────────────────────────

    fn program(&mut self) -> PResult<Vec<Stmt>> {
        let mut stmts = Vec::new();
        while !self.at_eof() {
            stmts.push(self.stmt()?);
        }
        Ok(stmts)
    }

    fn stmt(&mut self) -> PResult<Stmt> {
        let t = self.cur().clone();

        if t.kind == TokenKind::Pragma {
            self.advance();
            return Ok(Stmt::ModuleAttr { name: t.value });
        }
        if t.is_kw("import") {
            self.advance();
            if self.cur().kind != TokenKind::Str {
                return Err(self.err("expected a string path after `import`"));
            }
            let path = self.advance().value;
            self.eat_op(";")?;
            return Ok(Stmt::Import { path });
        }
        if t.is_kw("struct") {
            return self.struct_decl();
        }
        if t.is_kw("enum") {
            return self.enum_decl();
        }
        if t.is_kw("event") {
            // `event<T> …` is a type (vardecl/fn); `event Name(...)` is a decl.
            if self.peek(1).is_op("<") {
                return self.decl();
            }
            return self.event_decl();
        }
        if t.is_kw("tool") {
            return self.tool_decl();
        }
        if t.is_kw("authority") {
            self.advance();
            let name = self.eat_ident()?;
            self.eat_op(";")?;
            return Ok(Stmt::Authority(name));
        }
        if t.is_kw("principal") {
            self.advance();
            let name = self.eat_ident()?;
            self.eat_op(";")?;
            return Ok(Stmt::Principal(name));
        }
        if t.is_kw("agent") {
            return self.agent_decl();
        }
        if t.is_kw("extend") {
            return self.extend_stmt();
        }
        if t.is_kw("spawn") {
            self.advance();
            let agent_type = self.eat_ident()?;
            let name = self.eat_ident()?;
            self.eat_op(";")?;
            return Ok(Stmt::Spawn { agent_type, name });
        }
        if t.is_kw("awake") {
            self.advance();
            let name = self.eat_ident()?;
            let args = if self.check_op("(") { self.parse_args()? } else { Vec::new() };
            self.eat_op(";")?;
            return Ok(Stmt::Awake { name, args });
        }
        if t.is_kw("sleep") {
            self.advance();
            let name = self.eat_ident()?;
            self.eat_op(";")?;
            return Ok(Stmt::Sleep(name));
        }
        if t.is_kw("prompt") {
            self.advance();
            let ty = self.parse_type()?;
            let name = self.eat_ident()?;
            self.eat_op(";")?;
            return Ok(Stmt::Prompt { ty, name });
        }
        if t.is_kw("verify") {
            self.advance();
            let (arg, by) = self.verify_core()?;
            self.eat_op(";")?;
            return Ok(Stmt::Verify { arg, by });
        }
        if t.is_kw("emit") {
            self.advance();
            let event_type = self.eat_ident()?;
            self.eat_op("(")?;
            let payload = self.expr()?;
            self.eat_op(")")?;
            self.eat_op(";")?;
            return Ok(Stmt::Emit { event_type, payload });
        }
        if t.is_kw("return") {
            self.advance();
            if self.check_op(";") {
                self.advance();
                return Ok(Stmt::Return(None));
            }
            let e = self.expr()?;
            self.eat_op(";")?;
            return Ok(Stmt::Return(Some(e)));
        }
        if t.is_kw("if") {
            return self.if_stmt();
        }
        if t.is_kw("on") {
            return self.on_stmt();
        }
        if t.is_kw("when") {
            return self.when_stmt();
        }
        if t.is_kw("catch") {
            return self.catch_stmt();
        }
        if t.is_kw("case") {
            return self.case_stmt();
        }
        if t.is_kw("while") {
            self.advance();
            self.eat_op("(")?;
            let cond = self.expr()?;
            self.eat_op(")")?;
            let body = self.block()?;
            return Ok(Stmt::While { cond, body });
        }
        if t.is_kw("break") {
            self.advance();
            self.eat_op(";")?;
            return Ok(Stmt::Break);
        }
        if t.is_kw("retry") {
            return Ok(Stmt::Retry(self.retry_tail()?));
        }
        // Query statements. A query verb followed by `(` is instead a call to a
        // function that shadows the verb (see `eat_binder`), handled by the fallback.
        if (t.is_kw("find") || t.is_kw("select") || t.is_kw("match")) && !self.peek(1).is_op("(") {
            let q = self.parse_query()?;
            self.eat_op(";")?;
            return Ok(Stmt::QueryStmt(q));
        }
        if t.is_kw("independent") || t.is_kw("dependent") {
            let kind = if t.is_kw("independent") { Dep::Independent } else { Dep::Dependent };
            self.advance();
            let mut names = vec![self.eat_ident()?];
            while self.check_op(",") {
                self.advance();
                names.push(self.eat_ident()?);
            }
            self.eat_op(";")?;
            return Ok(Stmt::DepDecl { kind, names });
        }

        // A type-led declaration (var or fn).
        if self.starts_type_decl() {
            return self.decl();
        }

        // Fallback: an assignment or a bare expression statement.
        let e = self.expr()?;
        if self.check_op("=") {
            self.advance();
            let rhs = self.expr()?;
            self.eat_op(";")?;
            if !is_lvalue(&e) {
                return Err(self.err("invalid assignment target (assign to a name, a field, or an element)"));
            }
            return Ok(Stmt::Assign { target: e, expr: rhs });
        }
        self.eat_op(";")?;
        Ok(Stmt::ExprStmt(e))
    }

    /// True if the cursor begins a type-led declaration (a var or fn).
    fn starts_type_decl(&self) -> bool {
        let t = self.cur();
        if t.is_kw("sync") {
            return true;
        }
        if t.kind == TokenKind::Keyword && TYPE_KEYWORDS.contains(&t.value.as_str()) {
            return true;
        }
        // `Credence<…>` (a prelude type spelled as an identifier).
        if t.is_ident("Credence") && self.peek(1).is_op("<") {
            return true;
        }
        // `NamedType name …` — a user/prelude nominal type followed by a binder.
        if t.kind == TokenKind::Ident && self.peek(1).kind == TokenKind::Ident {
            return true;
        }
        false
    }

    /// A declaration beginning with an optional `sync`, a type, and a name.
    fn decl(&mut self) -> PResult<Stmt> {
        let is_sync = if self.check_kw("sync") {
            self.advance();
            true
        } else {
            false
        };
        let ty = self.parse_type()?;
        let name = self.eat_binder()?;

        if self.check_op("(") {
            let params = self.parse_params()?;
            let body = self.block()?;
            return Ok(Stmt::FnDecl { is_sync, ret: ty, name, params, body });
        }
        if is_sync {
            return Err(self.err("`sync` may only mark a function declaration"));
        }
        if self.check_op(";") {
            self.advance();
            return Ok(Stmt::VarDecl { ty, name, expr: None });
        }
        self.eat_op("=")?;
        let e = self.expr()?;
        self.eat_op(";")?;
        Ok(Stmt::VarDecl { ty, name, expr: Some(e) })
    }

    fn struct_decl(&mut self) -> PResult<Stmt> {
        self.eat_kw("struct")?;
        let name = self.eat_ident()?;
        self.eat_op("{")?;
        let fields = self.parse_fields("}")?;
        self.eat_op("}")?;
        Ok(Stmt::StructDecl { name, fields })
    }

    fn enum_decl(&mut self) -> PResult<Stmt> {
        self.eat_kw("enum")?;
        let name = self.eat_ident()?;
        self.eat_op("{")?;
        let mut variants = Vec::new();
        while !self.check_op("}") && !self.at_eof() {
            variants.push(self.eat_ident()?);
            if self.check_op(",") {
                self.advance();
            }
        }
        self.eat_op("}")?;
        Ok(Stmt::EnumDecl { name, variants })
    }

    fn event_decl(&mut self) -> PResult<Stmt> {
        self.eat_kw("event")?;
        let name = self.eat_ident()?;
        self.eat_op("(")?;
        let fields = self.parse_fields(")")?;
        self.eat_op(")")?;
        self.eat_op(";")?;
        Ok(Stmt::EventDecl { name, fields })
    }

    fn tool_decl(&mut self) -> PResult<Stmt> {
        self.eat_kw("tool")?;
        // Prefix return type, like a function signature (`tool text search(text q);`).
        // `->` is retired (§2); use `null` for a tool with no meaningful return.
        let ret = Some(self.parse_type()?);
        let name = self.eat_ident()?;
        let params = self.parse_params()?;
        self.eat_op(";")?;
        Ok(Stmt::ToolDecl { name, params, ret })
    }

    fn agent_decl(&mut self) -> PResult<Stmt> {
        self.eat_kw("agent")?;
        let name = self.eat_ident()?;
        let params = if self.check_op("(") { self.parse_params()? } else { Vec::new() };
        let (grants, has_grants, unconstrained) = self.grants_clause()?;
        let body = self.block()?;
        Ok(Stmt::AgentDecl { name, params, grants, has_grants, unconstrained, body })
    }

    /// Optional `grants { emit X, reach Y, use Z }` / `grants { * }`. No clause ⇒
    /// default-deny (§13). Returns (caps, has_clause, unconstrained).
    fn grants_clause(&mut self) -> PResult<(Vec<Capability>, bool, bool)> {
        if !self.check_kw("grants") {
            return Ok((Vec::new(), false, false));
        }
        self.advance();
        self.eat_op("{")?;
        if self.check_op("*") {
            self.advance();
            self.eat_op("}")?;
            return Ok((Vec::new(), true, true));
        }
        let mut caps = Vec::new();
        while !self.check_op("}") && !self.at_eof() {
            let kind = if self.check_kw("emit") {
                self.advance();
                CapKind::Emit
            } else if self.cur().is_ident("reach") {
                self.advance();
                CapKind::Reach
            } else if self.cur().is_ident("use") {
                self.advance();
                CapKind::Use
            } else {
                return Err(self.err("expected 'emit', 'reach', 'use', or '*' in grants"));
            };
            let target = self.eat_ident()?;
            caps.push(Capability { kind, target });
            if self.check_op(",") {
                self.advance();
            }
        }
        self.eat_op("}")?;
        Ok((caps, true, false))
    }

    fn extend_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("extend")?;
        let parent = self.eat_ident()?;
        let args = self.parse_args()?;
        self.eat_op(";")?;
        Ok(Stmt::Extend { parent, args })
    }

    fn if_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("if")?;
        self.eat_op("(")?;
        let cond = self.expr()?;
        self.eat_op(")")?;
        let then_body = self.block()?;
        let mut else_body = Vec::new();
        if self.check_kw("else") {
            self.advance();
            else_body = self.block()?;
        }
        Ok(Stmt::If { cond, then_body, else_body })
    }

    fn on_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("on")?;
        let event = self.advance().value; // `awake` / `sleep`
        let body = self.block()?;
        Ok(Stmt::On { event, body })
    }

    fn when_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("when")?;
        let event_type = if self.check_op("(") { None } else { Some(self.eat_ident()?) };
        self.eat_op("(")?;
        let subject = self.expr()?;
        self.eat_op(")")?;
        let body = self.block()?;
        Ok(Stmt::When { event_type, subject, body })
    }

    fn catch_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("catch")?;
        let mut event_type = None;
        let mut subject = None;
        if self.check_op("(") {
            self.advance();
            subject = Some(self.expr()?);
            self.eat_op(")")?;
        } else {
            event_type = Some(self.eat_ident()?);
            if self.check_op("(") {
                self.advance();
                subject = Some(self.expr()?);
                self.eat_op(")")?;
            }
        }
        self.eat_ctx("as")?;
        let binding = self.eat_ident()?;
        let body = self.block()?;
        Ok(Stmt::Catch { event_type, subject, binding, body })
    }

    fn case_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("case")?;
        self.eat_op("(")?;
        let expr = self.expr()?;
        self.eat_op(")")?;
        self.eat_ctx("as")?;
        let binding = self.eat_ident()?;
        self.eat_op("{")?;
        let mut arms = Vec::new();
        let mut default = None;
        while !self.check_op("}") && !self.at_eof() {
            if self.check_kw("default") {
                self.advance();
                self.eat_op(":")?;
                default = Some(self.block()?);
            } else {
                let variant = self.eat_ident()?;
                self.eat_op(":")?;
                arms.push((variant, self.block()?));
            }
        }
        self.eat_op("}")?;
        Ok(Stmt::Case { expr, binding, arms, default })
    }

    /// `retry(N) { body }` or `retry(TYPE x: PRED) { body }`.
    fn retry_tail(&mut self) -> PResult<RetryTail> {
        self.eat_kw("retry")?;
        self.eat_op("(")?;
        if self.cur().kind == TokenKind::Int {
            let count = self.parse_int()?;
            self.eat_op(")")?;
            let body = self.block()?;
            Ok(RetryTail::Bounded { count, body })
        } else {
            let ty = self.parse_type()?;
            let bind = self.eat_ident()?;
            self.eat_op(":")?;
            let pred = self.expr()?;
            self.eat_op(")")?;
            let body = if self.check_op("{") { self.block()? } else { Vec::new() };
            Ok(RetryTail::Predicate { ty, bind, pred, body })
        }
    }

    fn block(&mut self) -> PResult<Vec<Stmt>> {
        self.eat_op("{")?;
        let mut stmts = Vec::new();
        while !self.check_op("}") && !self.at_eof() {
            stmts.push(self.stmt()?);
        }
        self.eat_op("}")?;
        Ok(stmts)
    }

    // ── types, params, fields ──────────────────────────────────────────────────

    fn parse_type(&mut self) -> PResult<Type> {
        let t = self.cur().clone();
        if t.is_kw("event") {
            self.advance();
            self.eat_op("<")?;
            let inner = self.parse_type()?;
            self.eat_op(">")?;
            return Ok(Type::Event(Box::new(inner)));
        }
        if t.is_kw("array") {
            self.advance();
            self.eat_op("<")?;
            let inner = self.parse_type()?;
            self.eat_op(">")?;
            return Ok(Type::Array(Box::new(inner)));
        }
        if t.is_ident("Credence") {
            self.advance();
            self.eat_op("<")?;
            let inner = self.parse_type()?;
            self.eat_op(">")?;
            return Ok(Type::Credence(Box::new(inner)));
        }
        if t.kind == TokenKind::Keyword {
            let ty = match t.value.as_str() {
                "int" => Type::Int,
                "float" => Type::Float,
                "bool" => Type::Bool,
                "text" => Type::Text,
                "null" => Type::Null,
                _ => return Err(self.err("expected a type")),
            };
            self.advance();
            return Ok(ty);
        }
        if t.kind == TokenKind::Ident {
            self.advance();
            return Ok(Type::Named(t.value));
        }
        Err(self.err("expected a type"))
    }

    fn parse_params(&mut self) -> PResult<Vec<Param>> {
        self.eat_op("(")?;
        let mut params = Vec::new();
        if !self.check_op(")") {
            loop {
                let ty = self.parse_type()?;
                let name = self.eat_ident()?;
                params.push(Param { ty, name });
                if self.check_op(",") {
                    self.advance();
                } else {
                    break;
                }
            }
        }
        self.eat_op(")")?;
        Ok(params)
    }

    /// Fields for struct/event decls; each is `name: T` or `T name`.
    fn parse_fields(&mut self, close: &str) -> PResult<Vec<Field>> {
        let mut fields = Vec::new();
        while !self.check_op(close) && !self.at_eof() {
            let field = if self.cur().kind == TokenKind::Ident && self.peek(1).is_op(":") {
                let name = self.eat_ident()?;
                self.eat_op(":")?;
                let ty = self.parse_type()?;
                Field { name, ty }
            } else {
                let ty = self.parse_type()?;
                let name = self.eat_ident()?;
                Field { name, ty }
            };
            fields.push(field);
            if self.check_op(",") {
                self.advance();
            }
        }
        Ok(fields)
    }

    fn parse_args(&mut self) -> PResult<Vec<Expr>> {
        self.eat_op("(")?;
        let mut args = Vec::new();
        if !self.check_op(")") {
            loop {
                args.push(self.expr()?);
                if self.check_op(",") {
                    self.advance();
                } else {
                    break;
                }
            }
        }
        self.eat_op(")")?;
        Ok(args)
    }

    fn parse_int(&mut self) -> PResult<i64> {
        if self.cur().kind == TokenKind::Int {
            self.advance().value.parse::<i64>().map_err(|_| self.err("bad integer literal"))
        } else {
            Err(self.err("expected an integer"))
        }
    }

    fn parse_number(&mut self) -> PResult<f64> {
        match self.cur().kind {
            TokenKind::Int | TokenKind::Float => {
                self.advance().value.parse::<f64>().map_err(|_| self.err("bad number"))
            }
            _ => Err(self.err("expected a number")),
        }
    }

    /// A query source: an agent name or the reserved `self` / `spine`.
    fn eat_source(&mut self) -> PResult<String> {
        if self.check_kw("self") {
            self.advance();
            Ok("self".to_string())
        } else {
            self.eat_ident()
        }
    }

    // ── expressions (precedence climbing) ──────────────────────────────────────

    fn expr(&mut self) -> PResult<Expr> {
        if self.check_kw("verify") {
            self.advance();
            let (arg, by) = self.verify_core()?;
            return Ok(Expr::Verify { arg: Box::new(arg), by });
        }
        self.send()
    }

    /// The shared core of statement- and expression-form `verify`:
    /// `gatearg ("by" basis)?`, with `gatearg` parsed at comparison level.
    fn verify_core(&mut self) -> PResult<(Expr, Option<GateBasis>)> {
        let arg = self.compare()?;
        let by = if self.cur().is_ident("by") {
            self.advance();
            Some(self.gate_basis()?)
        } else {
            None
        };
        Ok((arg, by))
    }

    /// A gate rule: `cmpop Number ("margin" Number)?`, or an expr (a `Rule` value
    /// or, for `verify … by p`, a `Principal`).
    fn gate_basis(&mut self) -> PResult<GateBasis> {
        if self.cur().kind == TokenKind::Op && BinOp::is_comparison(&self.cur().value) {
            let op = BinOp::from_str(&self.advance().value).unwrap();
            let value = self.parse_number()?;
            let margin = if self.cur().is_ident("margin") {
                self.advance();
                self.parse_number()?
            } else {
                0.0
            };
            Ok(GateBasis::Threshold { op, value, margin })
        } else {
            Ok(GateBasis::Value(Box::new(self.expr()?)))
        }
    }

    /// `dest <- payload [expires N] [retry…]` — lowest precedence.
    fn send(&mut self) -> PResult<Expr> {
        let left = self.pipe()?;
        if self.check_op("<-") {
            self.advance();
            let payload = self.pipe()?;
            let expires = if self.cur().is_ident("expires") {
                self.advance();
                Some(self.parse_number()?)
            } else {
                None
            };
            let retry = if self.check_kw("retry") {
                Some(Box::new(self.retry_tail()?))
            } else {
                None
            };
            return Ok(Expr::Send { dest: Box::new(left), payload: Box::new(payload), expires, retry });
        }
        Ok(left)
    }

    /// `source |> func` — left-associative.
    fn pipe(&mut self) -> PResult<Expr> {
        let mut left = self.compare()?;
        while self.check_op("|>") {
            self.advance();
            let func = self.compare()?;
            left = Expr::Pipe { source: Box::new(left), func: Box::new(func) };
        }
        Ok(left)
    }

    fn compare(&mut self) -> PResult<Expr> {
        let mut left = self.addsub()?;
        while self.cur().kind == TokenKind::Op && BinOp::is_comparison(&self.cur().value) {
            let op = BinOp::from_str(&self.advance().value).unwrap();
            let right = self.addsub()?;
            left = Expr::Binary { op, left: Box::new(left), right: Box::new(right) };
        }
        Ok(left)
    }

    fn addsub(&mut self) -> PResult<Expr> {
        let mut left = self.muldiv()?;
        while self.check_op("+") || self.check_op("-") {
            let op = BinOp::from_str(&self.advance().value).unwrap();
            let right = self.muldiv()?;
            left = Expr::Binary { op, left: Box::new(left), right: Box::new(right) };
        }
        Ok(left)
    }

    fn muldiv(&mut self) -> PResult<Expr> {
        let mut left = self.unary()?;
        while self.check_op("*") || self.check_op("/") {
            let op = BinOp::from_str(&self.advance().value).unwrap();
            let right = self.unary()?;
            left = Expr::Binary { op, left: Box::new(left), right: Box::new(right) };
        }
        Ok(left)
    }

    fn unary(&mut self) -> PResult<Expr> {
        if self.check_op("!") {
            self.advance();
            let e = self.unary()?;
            return Ok(Expr::Not(Box::new(e)));
        }
        self.postfix()
    }

    fn postfix(&mut self) -> PResult<Expr> {
        let mut e = self.primary()?;
        loop {
            if self.check_op("(") {
                let args = self.parse_args()?;
                e = Expr::Call { func: Box::new(e), args };
            } else if self.check_op(".") {
                self.advance();
                let prop = self.eat_ident()?;
                e = Expr::Member { obj: Box::new(e), prop };
            } else if self.check_op("[") {
                self.advance();
                let index = self.expr()?;
                self.eat_op("]")?;
                e = Expr::Index { obj: Box::new(e), index: Box::new(index) };
            } else {
                break;
            }
        }
        Ok(e)
    }

    fn primary(&mut self) -> PResult<Expr> {
        let t = self.cur().clone();
        match t.kind {
            TokenKind::Int => {
                self.advance();
                t.value.parse::<i64>().map(Expr::Int).map_err(|_| self.err("bad int literal"))
            }
            TokenKind::Float => {
                self.advance();
                t.value.parse::<f64>().map(Expr::Float).map_err(|_| self.err("bad float literal"))
            }
            TokenKind::Str => {
                self.advance();
                Ok(Expr::Str(t.value))
            }
            TokenKind::FStr => {
                self.advance();
                Ok(Expr::FStr(t.value))
            }
            TokenKind::Ident => {
                // A struct literal `Name { f: v, ... }` (only in expression position).
                if self.peek(1).is_op("{") {
                    return self.struct_lit();
                }
                self.advance();
                Ok(Expr::Name(t.value))
            }
            TokenKind::Keyword => match t.value.as_str() {
                "true" => {
                    self.advance();
                    Ok(Expr::Bool(true))
                }
                "false" => {
                    self.advance();
                    Ok(Expr::Bool(false))
                }
                "null" => {
                    self.advance();
                    Ok(Expr::Null)
                }
                "self" => {
                    self.advance();
                    Ok(Expr::SelfRef)
                }
                "decide" => self.decide_expr(),
                "quorum" => self.quorum_expr(),
                "all" | "any" => {
                    self.advance();
                    Ok(Expr::Name(t.value)) // postfix turns `all(...)` into a Call
                }
                "find" | "select" | "match" => {
                    // A query verb followed by `(` is a call to a shadowing function.
                    if self.peek(1).is_op("(") {
                        self.advance();
                        Ok(Expr::Name(t.value))
                    } else {
                        Ok(Expr::Query(Box::new(self.parse_query()?)))
                    }
                }
                "verify" => {
                    self.advance();
                    let (arg, by) = self.verify_core()?;
                    Ok(Expr::Verify { arg: Box::new(arg), by })
                }
                _ => Err(self.err("unexpected keyword in expression")),
            },
            TokenKind::Op if t.value == "(" => {
                self.advance();
                let e = self.expr()?;
                self.eat_op(")")?;
                Ok(e)
            }
            TokenKind::Op if t.value == "[" => {
                self.advance();
                let mut elements = Vec::new();
                if !self.check_op("]") {
                    loop {
                        elements.push(self.expr()?);
                        if self.check_op(",") {
                            self.advance();
                        } else {
                            break;
                        }
                    }
                }
                self.eat_op("]")?;
                Ok(Expr::Array(elements))
            }
            _ => Err(self.err("expected an expression")),
        }
    }

    fn struct_lit(&mut self) -> PResult<Expr> {
        let name = self.eat_ident()?;
        self.eat_op("{")?;
        let mut fields = Vec::new();
        while !self.check_op("}") && !self.at_eof() {
            let fname = self.eat_ident()?;
            self.eat_op(":")?;
            let val = self.expr()?;
            fields.push((fname, val));
            if self.check_op(",") {
                self.advance();
            }
        }
        self.eat_op("}")?;
        Ok(Expr::StructLit { name, fields })
    }

    fn decide_expr(&mut self) -> PResult<Expr> {
        self.eat_kw("decide")?;
        self.eat_op("(")?;
        let e = self.expr()?;
        if !self.check_op(",") {
            // `decide(e)` with no rule is a ParseError (§3, AMB-7).
            return Err(self.err("decide requires a rule, e.g. decide(c, > 0.8)"));
        }
        self.advance();
        let rule = self.gate_basis()?;
        self.eat_op(")")?;
        Ok(Expr::Decide { expr: Box::new(e), rule })
    }

    fn quorum_expr(&mut self) -> PResult<Expr> {
        self.eat_kw("quorum")?;
        self.eat_op("(")?;
        let k = self.parse_int()?;
        self.eat_ctx("of")?;
        let mut judges = vec![self.expr()?];
        while self.check_op(",") {
            self.advance();
            judges.push(self.expr()?);
        }
        self.eat_op(")")?;
        Ok(Expr::Quorum { k, judges })
    }

    fn parse_query(&mut self) -> PResult<Query> {
        if self.check_kw("find") {
            self.advance();
            let binding = self.eat_ident()?;
            let mut origin = None;
            if self.check_op(",") {
                self.advance();
                self.eat_ctx("origin")?;
                self.eat_op("(")?;
                origin = Some(self.eat_ident()?);
                self.eat_op(")")?;
            }
            self.eat_kw("where")?;
            self.eat_op("{")?;
            let mut pattern = Vec::new();
            while !self.check_op("}") && !self.at_eof() {
                let s = self.eat_ident()?;
                let p = self.eat_ident()?;
                let o = self.eat_ident()?;
                pattern.push((s, p, o));
                if self.check_op(";") {
                    self.advance();
                }
            }
            self.eat_op("}")?;
            return Ok(Query::Find { binding, origin, pattern });
        }
        if self.check_kw("select") {
            self.advance();
            let mut cols = Vec::new();
            let star = self.check_op("*");
            if star {
                self.advance();
            } else {
                cols.push(self.eat_ident()?);
                while self.check_op(",") {
                    self.advance();
                    cols.push(self.eat_ident()?);
                }
            }
            self.eat_kw("from")?;
            let source = self.eat_source()?;
            self.eat_kw("where")?;
            self.eat_op("{")?;
            let mut conds = Vec::new();
            while !self.check_op("}") && !self.at_eof() {
                let col = self.eat_ident()?;
                let op = if self.check_op(":") {
                    self.advance();
                    ":".to_string()
                } else if self.cur().kind == TokenKind::Op && BinOp::is_comparison(&self.cur().value) {
                    self.advance().value
                } else {
                    return Err(self.err("expected a comparison op or ':' in where-clause"));
                };
                let value = self.expr()?;
                conds.push(Cond { col, op, value });
                if self.check_op(",") || self.check_op(";") {
                    self.advance();
                }
            }
            self.eat_op("}")?;
            return Ok(Query::Select { cols, source, star, conds });
        }
        if self.check_kw("match") {
            self.advance();
            self.eat_op("{")?;
            let binding = self.eat_ident()?;
            self.eat_op(":")?;
            let query = self.expr()?;
            self.eat_op("}")?;
            self.eat_op(">")?;
            let threshold = self.parse_number()?;
            return Ok(Query::Match { binding, query: Box::new(query), threshold });
        }
        Err(self.err("expected a query (find/select/match)"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::lex;

    fn p(src: &str) -> Vec<Stmt> {
        parse(lex(src).unwrap()).unwrap()
    }
    fn perr(src: &str) -> AgapeError {
        parse(lex(src).unwrap()).unwrap_err()
    }

    #[test]
    fn credence_decl_and_decide() {
        let s = p("Credence<bool> c = self <- \"is this an approval?\"; bool b = decide(c, > 0.9);");
        assert!(matches!(&s[0], Stmt::VarDecl { ty: Type::Credence(_), .. }));
        assert!(matches!(&s[1], Stmt::VarDecl { expr: Some(Expr::Decide { .. }), .. }));
    }

    #[test]
    fn decide_without_rule_is_parse_error() {
        assert_eq!(perr("bool b = decide(c);").class, ErrorClass::Parse);
    }

    #[test]
    fn tilde_is_parse_error() {
        assert_eq!(perr("bool b = \"a\" ~ \"b\";").class, ErrorClass::Parse);
    }

    #[test]
    fn calibrate_is_parse_error() {
        assert_eq!(perr("principal alice; calibrate memo by alice;").class, ErrorClass::Parse);
    }

    #[test]
    fn struct_decl_and_literal() {
        let s = p("struct Memo { amount: int, to: text } Memo m = Memo { amount: 100, to: \"bob\" };");
        assert!(matches!(&s[0], Stmt::StructDecl { fields, .. } if fields.len() == 2));
        assert!(matches!(&s[1], Stmt::VarDecl { expr: Some(Expr::StructLit { .. }), .. }));
    }

    #[test]
    fn event_and_tool_and_authority() {
        let s = p("event Transfer(memo: Memo); tool text search(text q); authority Transfer;");
        assert!(matches!(&s[0], Stmt::EventDecl { .. }));
        assert!(matches!(&s[1], Stmt::ToolDecl { ret: Some(_), .. }));
        assert!(matches!(&s[2], Stmt::Authority(_)));
    }

    #[test]
    fn grants_emit_reach_use() {
        let s = p("agent A grants { emit E, reach W, use search } { }");
        match &s[0] {
            Stmt::AgentDecl { grants, .. } => {
                assert_eq!(grants[0].kind, CapKind::Emit);
                assert_eq!(grants[1].kind, CapKind::Reach);
                assert_eq!(grants[2].kind, CapKind::Use);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn spawn_has_no_args_awake_may() {
        let s = p("spawn W w; awake w; sleep w; awake w;");
        assert!(matches!(&s[0], Stmt::Spawn { .. }));
        assert!(matches!(&s[1], Stmt::Awake { args, .. } if args.is_empty()));
    }

    #[test]
    fn quorum_and_dep_decl() {
        let s = p("independent j1, j2, j3; Credence<bool> a = quorum(2 of j1, j2, j3);");
        assert!(matches!(&s[0], Stmt::DepDecl { kind: Dep::Independent, .. }));
        assert!(matches!(&s[1], Stmt::VarDecl { expr: Some(Expr::Quorum { k: 2, .. }), .. }));
    }

    #[test]
    fn verify_by_principal_and_threshold() {
        let s = p("verify memo by alice; verify c by > 0.9 margin 0.2; verify c;");
        assert!(matches!(&s[0], Stmt::Verify { by: Some(GateBasis::Value(_)), .. }));
        assert!(matches!(&s[1], Stmt::Verify { by: Some(GateBasis::Threshold { .. }), .. }));
        assert!(matches!(&s[2], Stmt::Verify { by: None, .. }));
    }

    #[test]
    fn query_stmt_and_expr_forms() {
        let s = p("select * from spine where { etype: \"Spawned\" };");
        assert!(matches!(&s[0], Stmt::QueryStmt(Query::Select { star: true, .. })));
        let s = p("Memo m = select amount, to from self where { kind: \"pending\" };");
        assert!(matches!(&s[0], Stmt::VarDecl { expr: Some(Expr::Query(_)), .. }));
        let s = p("find n, origin(n) where { Coach is_named n };");
        assert!(matches!(&s[0], Stmt::QueryStmt(Query::Find { origin: Some(_), .. })));
    }

    #[test]
    fn case_arms_no_payload() {
        let s = p("case (k) as v { Billing: { say(\"b\"); } Bug: { say(\"g\"); } default: { say(\"d\"); } }");
        match &s[0] {
            Stmt::Case { arms, default, .. } => {
                assert_eq!(arms.len(), 2);
                assert!(default.is_some());
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn send_retry_form() {
        let s = p("event<text> r = a <- q retry(3) { q = q + \"!\"; };");
        assert!(matches!(&s[0], Stmt::VarDecl { expr: Some(Expr::Send { retry: Some(_), .. }), .. }));
    }

    #[test]
    fn missing_semicolon_is_parse_error() {
        assert_eq!(perr("int a = 5\nint b = 6;").class, ErrorClass::Parse);
    }

    #[test]
    fn keyword_as_ident_is_parse_error() {
        assert_eq!(perr("int agent = 5;").class, ErrorClass::Parse);
    }

    #[test]
    fn tool_call_and_agent_no_parens() {
        let s = p("tool text search(text q); agent R grants { use search } { text hits = search(\"q\"); }");
        assert!(matches!(&s[1], Stmt::AgentDecl { params, .. } if params.is_empty()));
    }
}
