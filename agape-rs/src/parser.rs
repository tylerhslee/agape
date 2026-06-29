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
    matches!(
        e,
        Expr::Name(_) | Expr::Member { .. } | Expr::Index { .. } | Expr::SelfRef
    )
}

pub struct Parser {
    toks: Vec<Token>,
    pos: usize,
    /// While true, a bare `Name {` is NOT a struct literal — the `{` opens a block
    /// (used for the gate scrutinee `decide c { … }`, §20).
    no_struct_lit: bool,
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
        Parser {
            toks,
            pos: 0,
            no_struct_lit: false,
        }
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
            || (t.kind == TokenKind::Keyword
                && matches!(t.value.as_str(), "find" | "select" | "match"))
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
        let span = if t.kind == TokenKind::Eof {
            Span::new(t.span.start, t.span.end)
        } else {
            t.span
        };
        AgapeError::at(
            ErrorClass::Parse,
            span,
            format!("{what}, got {} ({:?})", t.value, t.kind),
        )
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
        if t.is_kw("module") {
            self.advance();
            let path = self.parse_modpath()?;
            self.eat_op(";")?;
            return Ok(Stmt::ModuleDecl { path });
        }
        if t.is_kw("import") {
            return self.import_stmt(false);
        }
        if t.is_kw("pub") {
            return self.pub_decl();
        }
        if t.is_kw("interface") {
            return self.interface_decl();
        }
        if t.is_kw("reversible") {
            return self.reversible_decl();
        }
        // File-level `conformal α;` declaration (§20). `conformal` is a contextual
        // identifier, so only treat it as the declaration when followed by a number.
        if t.is_ident("conformal") && matches!(self.peek(1).kind, TokenKind::Int | TokenKind::Float)
        {
            self.advance();
            let alpha = self.parse_number()?;
            self.eat_op(";")?;
            return Ok(Stmt::ConformalDecl(alpha));
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
        if t.is_kw("action") {
            return self.action_decl(false);
        }
        if t.is_kw("read") || t.is_kw("write") {
            return self.tool_decl(false);
        }
        if t.is_kw("tool") {
            // The effect class (`read`/`write`) is mandatory and leads the declaration (§6b).
            return Err(self.err("a tool declaration must begin with `read` or `write` — the effect class is mandatory (§6b)"));
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
            let agent_type = self.parse_modpath()?;
            // Optional generic type args (erased; agents are not generic, but the
            // grammar permits the form so the checker can rule on it).
            if self.check_op("<") {
                self.skip_typeargs()?;
            }
            let name = self.eat_ident()?;
            // Constructor args may be bound here (`spawn TYPE name(args)`) or deferred
            // to `awake name(args)`; both forms are accepted (§5, §15.2).
            let args = if self.check_op("(") {
                self.parse_args()?
            } else {
                Vec::new()
            };
            self.eat_op(";")?;
            return Ok(Stmt::Spawn {
                agent_type,
                name,
                args,
            });
        }
        if t.is_kw("awake") {
            self.advance();
            let name = self.eat_ident()?;
            let args = if self.check_op("(") {
                self.parse_args()?
            } else {
                Vec::new()
            };
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
        if t.is_kw("instruction") {
            // `instruction STRING;` — a compile-time system prompt (§5).
            self.advance();
            let tok = self.cur().clone();
            if tok.kind != TokenKind::Str {
                return Err(self
                    .err("`instruction` takes a string literal — the agent's system prompt (§5)"));
            }
            self.advance();
            self.eat_op(";")?;
            return Ok(Stmt::Instruction(tok.value));
        }
        if t.is_kw("mem") {
            // `mem NAME [<- EXPR];` — declare a private-memory handle (§10).
            self.advance();
            let name = self.eat_ident()?;
            let init = if self.check_op("<-") {
                self.advance();
                Some(self.pipe()?)
            } else {
                None
            };
            self.eat_op(";")?;
            return Ok(Stmt::MemDecl { name, init });
        }
        if t.is_kw("forget") {
            self.advance();
            let name = self.eat_ident()?;
            self.eat_op(";")?;
            return Ok(Stmt::Forget(name));
        }
        if t.is_kw("verify") {
            self.advance();
            let (arg, by) = self.verify_core()?;
            self.eat_op(";")?;
            return Ok(Stmt::Verify { arg, by });
        }
        if t.is_kw("emit") {
            self.advance();
            let event_type = self.parse_modpath()?;
            let args = self.parse_args()?;
            self.eat_op(";")?;
            return Ok(Stmt::Emit { event_type, args });
        }
        if t.is_kw("perform") {
            self.advance();
            let action_type = self.parse_modpath()?;
            let args = self.parse_args()?;
            self.eat_op(";")?;
            return Ok(Stmt::Perform { action_type, args });
        }
        // The readable gate (§20): `decide c { … }` (no paren — the `decide(e, rule)`
        // form is expression-only). Also `p decide c { … }` with a principal subject
        // (handled in the fallback below).
        if t.is_kw("decide") && !self.peek(1).is_op("(") {
            return self.decide_stmt(None);
        }
        if t.is_kw("endorse") {
            return self.endorse_stmt();
        }
        if t.is_kw("attest") {
            return self.attest_stmt();
        }
        if t.is_kw("certify") {
            return self.certify_stmt();
        }
        if t.is_kw("policy") {
            return self.policy_decl();
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
            let kind = if t.is_kw("independent") {
                Dep::Independent
            } else {
                Dep::Dependent
            };
            self.advance();
            let mut names = vec![self.eat_ident()?];
            while self.check_op(",") {
                self.advance();
                names.push(self.eat_ident()?);
            }
            self.eat_op(";")?;
            return Ok(Stmt::DepDecl { kind, names });
        }

        // A bare lexical block `{ ... }`, optionally a bounded loop `{ ... } retry(N)`
        // — the only loop in v1.0 (§11, §15.2).
        if self.check_op("{") {
            let body = self.block()?;
            if self.check_kw("retry") {
                self.advance();
                self.eat_op("(")?;
                let count = self.parse_int()?;
                self.eat_op(")")?;
                return Ok(Stmt::Retry(RetryTail::Bounded { count, body }));
            }
            return Ok(Stmt::Block(body));
        }

        // A principal-subject gate: `p decide c { … }` (§20).
        if t.kind == TokenKind::Ident && self.peek(1).is_kw("decide") {
            let subject = self.eat_ident()?;
            return self.decide_stmt(Some(subject));
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
                return Err(self
                    .err("invalid assignment target (assign to a name, a field, or an element)"));
            }
            return Ok(Stmt::Assign {
                target: e,
                expr: rhs,
            });
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
        // `Credence<…>` / `Decision<…>` / `Endorsement<…>` (prelude types spelled as identifiers).
        if (t.is_ident("Credence") || t.is_ident("Decision") || t.is_ident("Endorsement"))
            && self.peek(1).is_op("<")
        {
            return true;
        }
        // `NamedType name …` — a user/prelude nominal type followed by a binder.
        if t.kind == TokenKind::Ident && self.peek(1).kind == TokenKind::Ident {
            return true;
        }
        // A qualified type `m.Name binder` — `Ident . Ident … Ident binder`.
        if t.kind == TokenKind::Ident && self.peek(1).is_op(".") {
            // Find the end of the dotted path, then check it is followed by a binder
            // (or a generic instantiation followed by a binder).
            if let Some(after) = self.modpath_end(self.pos) {
                if self.toks.get(after).map(|x| x.kind) == Some(TokenKind::Ident) {
                    return true; // `m.Name binder`
                }
                if self.toks.get(after).map(|x| x.is_op("<")).unwrap_or(false) {
                    if let Some(close) = self.typeargs_end(after) {
                        if self.toks.get(close).map(|x| x.kind) == Some(TokenKind::Ident) {
                            return true; // `m.Box<int> binder`
                        }
                    }
                }
            }
        }
        // A generic-instantiation var decl `Name<args> binder` (vs the comparison
        // `a < b`): a balanced `<…>` whose closing `>` is immediately followed by a
        // binder name.
        if t.kind == TokenKind::Ident && self.peek(1).is_op("<") {
            if let Some(close) = self.typeargs_end(self.pos + 1) {
                if self.toks.get(close).map(|x| x.kind) == Some(TokenKind::Ident) {
                    return true;
                }
            }
        }
        false
    }

    /// The token index just past a dotted modpath beginning at `start` (an `Ident`
    /// followed by `(. Ident)*`). `None` if `start` is not an identifier.
    fn modpath_end(&self, start: usize) -> Option<usize> {
        if self.toks.get(start)?.kind != TokenKind::Ident {
            return None;
        }
        let mut i = start + 1;
        while self.toks.get(i).map(|x| x.is_op(".")).unwrap_or(false)
            && self
                .toks
                .get(i + 1)
                .map(|x| x.kind == TokenKind::Ident)
                .unwrap_or(false)
        {
            i += 2;
        }
        Some(i)
    }

    /// Given the index of an opening `<`, the index just past the matching `>` of a
    /// balanced type-argument list (counting nested `<>`). `None` if it never closes
    /// before a statement terminator (`;`/`{`/`}`/`(`) — in which case it is not a
    /// type-arg list but a comparison.
    fn typeargs_end(&self, open: usize) -> Option<usize> {
        if !self.toks.get(open)?.is_op("<") {
            return None;
        }
        let mut depth = 0usize;
        let mut i = open;
        while let Some(tok) = self.toks.get(i) {
            if tok.is_op("<") {
                depth += 1;
            } else if tok.is_op(">") {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            } else if tok.is_op(";")
                || tok.is_op("{")
                || tok.is_op("}")
                || tok.is_op("(")
                || tok.is_op(")")
                || tok.kind == TokenKind::Eof
            {
                return None; // a comparison, not a type-arg list
            }
            i += 1;
        }
        None
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
        // Optional generic type parameters on a function (`fn id<T>(…)`, §19.5).
        let typarams = if self.check_op("<") {
            self.parse_typarams()?
        } else {
            Vec::new()
        };

        if self.check_op("(") {
            let params = self.parse_params()?;
            let body = self.block()?;
            return Ok(Stmt::FnDecl {
                is_sync,
                ret: ty,
                name,
                typarams,
                params,
                body,
            });
        }
        if !typarams.is_empty() {
            return Err(self.err("type parameters are only valid on a function declaration"));
        }
        if is_sync {
            return Err(self.err("`sync` may only mark a function declaration"));
        }
        if self.check_op(";") {
            self.advance();
            return Ok(Stmt::VarDecl {
                ty,
                name,
                expr: None,
            });
        }
        self.eat_op("=")?;
        let e = self.expr()?;
        self.eat_op(";")?;
        Ok(Stmt::VarDecl {
            ty,
            name,
            expr: Some(e),
        })
    }

    fn struct_decl(&mut self) -> PResult<Stmt> {
        self.eat_kw("struct")?;
        let name = self.eat_ident()?;
        let typarams = self.parse_typarams()?;
        self.eat_op("{")?;
        let fields = self.parse_fields("}")?;
        self.eat_op("}")?;
        Ok(Stmt::StructDecl {
            name,
            typarams,
            fields,
        })
    }

    /// `<A, B, ...>` type parameters on a `struct`/`fn` (§19.5). Empty if absent.
    fn parse_typarams(&mut self) -> PResult<Vec<String>> {
        if !self.check_op("<") {
            return Ok(Vec::new());
        }
        self.advance();
        let mut params = vec![self.eat_ident()?];
        while self.check_op(",") {
            self.advance();
            params.push(self.eat_ident()?);
        }
        self.eat_op(">")?;
        Ok(params)
    }

    /// Consume and discard a `<T, ...>` type-argument list (the args are erased at
    /// monomorphization; the runtime never sees them).
    fn skip_typeargs(&mut self) -> PResult<()> {
        self.eat_op("<")?;
        loop {
            let _ = self.parse_type()?;
            if self.check_op(",") {
                self.advance();
            } else {
                break;
            }
        }
        self.eat_op(">")?;
        Ok(())
    }

    /// A dotted module / qualified-name path (`a`, `a.b`, `m.Name`) → a single
    /// `.`-joined string (§19.2).
    fn parse_modpath(&mut self) -> PResult<String> {
        let mut path = self.eat_ident()?;
        while self.check_op(".") {
            self.advance();
            path.push('.');
            path.push_str(&self.eat_ident()?);
        }
        Ok(path)
    }

    /// `[pub] import m [as x];` / `[pub] import { A, B } from m;` (§19.2, §19.2a).
    fn import_stmt(&mut self, is_pub: bool) -> PResult<Stmt> {
        self.eat_kw("import")?;
        if self.check_op("{") {
            self.advance();
            let mut names = vec![self.eat_ident()?];
            while self.check_op(",") {
                self.advance();
                names.push(self.eat_ident()?);
            }
            self.eat_op("}")?;
            self.eat_kw("from")?;
            let module = self.parse_modpath()?;
            self.eat_op(";")?;
            return Ok(Stmt::Import {
                module,
                alias: None,
                names,
                is_pub,
            });
        }
        let module = self.parse_modpath()?;
        let alias = if self.cur().is_ident("as") {
            self.advance();
            Some(self.eat_ident()?)
        } else {
            None
        };
        self.eat_op(";")?;
        Ok(Stmt::Import {
            module,
            alias,
            names: Vec::new(),
            is_pub,
        })
    }

    /// A `pub`-prefixed top-level declaration / re-export (§19.4, §19.2a).
    fn pub_decl(&mut self) -> PResult<Stmt> {
        self.eat_kw("pub")?;
        if self.check_kw("import") {
            return self.import_stmt(true);
        }
        let inner = if self.check_kw("interface") {
            self.interface_decl()?
        } else if self.check_kw("reversible") {
            self.reversible_decl()?
        } else if self.check_kw("struct")
            || self.check_kw("enum")
            || self.check_kw("event")
            || self.check_kw("action")
            || self.check_kw("agent")
            || self.check_kw("read")
            || self.check_kw("write")
            || self.check_kw("sync")
            || self.starts_type_decl()
        {
            self.stmt()?
        } else {
            return Err(self.err("`pub` may only prefix a top-level declaration or `import`"));
        };
        Ok(Stmt::Pub(Box::new(inner)))
    }

    /// `interface NAME { (when EVENT decide RESULT | requires CAP);* }` (§19.5).
    /// A generic interface (`interface I<T>`) is a `ParseError`.
    fn interface_decl(&mut self) -> PResult<Stmt> {
        self.eat_kw("interface")?;
        let name = self.eat_ident()?;
        if self.check_op("<") {
            return Err(self.err("an interface may not be generic (§19.5)"));
        }
        self.eat_op("{")?;
        let mut members = Vec::new();
        while !self.check_op("}") && !self.at_eof() {
            if self.check_kw("when") {
                self.advance();
                let event = self.parse_modpath()?;
                // `decide` is the contract verb (no `->`, which is a LexError, §2).
                self.eat_kw("decide")?;
                let result = self.parse_modpath()?;
                members.push(IfaceMember::When { event, result });
            } else if self.cur().is_ident("requires") || self.check_kw("requires") {
                self.advance();
                let cap = self.parse_cap()?;
                members.push(IfaceMember::Requires(cap));
            } else {
                return Err(self
                    .err("expected `when EVENT decide RESULT` or `requires CAP` in an interface"));
            }
            if self.check_op(";") {
                self.advance();
            }
        }
        self.eat_op("}")?;
        Ok(Stmt::InterfaceDecl { name, members })
    }

    /// One capability `perform X` / `reach X` / `use X` (§13), for `requires`/`grants`.
    fn parse_cap(&mut self) -> PResult<Capability> {
        let kind = if self.check_kw("perform") {
            self.advance();
            CapKind::Perform
        } else if self.check_kw("emit") {
            self.advance();
            CapKind::Emit
        } else if self.cur().is_ident("reach") {
            self.advance();
            CapKind::Reach
        } else if self.cur().is_ident("use") {
            self.advance();
            CapKind::Use
        } else {
            return Err(self.err("expected a capability (`perform`/`reach`/`use`)"));
        };
        let target = self.parse_modpath()?;
        Ok(Capability { kind, target })
    }

    /// `[p] decide EXPR [conformal α] { Variant: (block|stmt) … [default: …] } [defer to p];`
    /// — the readable gate (§20). `subject` is the optional principal subject.
    fn decide_stmt(&mut self, subject: Option<String>) -> PResult<Stmt> {
        self.eat_kw("decide")?;
        self.no_struct_lit = true;
        let expr = self.compare()?;
        self.no_struct_lit = false;
        let conformal = if self.cur().is_ident("conformal") {
            self.advance();
            Some(self.parse_number()?)
        } else {
            None
        };
        self.eat_op("{")?;
        let mut arms = Vec::new();
        let mut default = None;
        while !self.check_op("}") && !self.at_eof() {
            if self.check_kw("default") {
                self.advance();
                self.eat_op(":")?;
                default = Some(self.decide_arm_body()?);
            } else {
                let label = if self.check_kw("true") {
                    self.advance();
                    "true".to_string()
                } else if self.check_kw("false") {
                    self.advance();
                    "false".to_string()
                } else {
                    self.eat_ident()?
                };
                self.eat_op(":")?;
                arms.push((label, self.decide_arm_body()?));
            }
        }
        self.eat_op("}")?;
        let defer_to = if self.check_kw("defer") {
            self.advance();
            self.eat_ctx("to")?;
            Some(self.eat_ident()?)
        } else {
            None
        };
        if self.check_op(";") {
            self.advance();
        }
        Ok(Stmt::Decide {
            expr,
            subject,
            conformal,
            arms,
            default,
            defer_to,
        })
    }

    /// A `decide` arm body: a `{ block }` or a single statement (§20 grammar).
    fn decide_arm_body(&mut self) -> PResult<Vec<Stmt>> {
        if self.check_op("{") {
            self.block()
        } else {
            Ok(vec![self.stmt()?])
        }
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
        // An optional single supertype (§19.5). Only `Error` is permitted; the
        // checker rejects any other (a `TypeError`), but it parses here so that
        // diagnosis lands as a TypeError, not a ParseError.
        let mut error_super = false;
        let mut super_name: Option<String> = None;
        if self.check_op(":") {
            self.advance();
            let s = self.parse_modpath()?;
            error_super = s == "Error";
            super_name = Some(s);
        }
        self.eat_op(";")?;
        Ok(Stmt::EventDecl {
            name,
            fields,
            error_super,
            super_name,
        })
    }

    /// `action NAME(field, ...);` — a performative event type (§3, §13). An `action`
    /// may NOT carry a supertype (only `event` may extend `Error`) — a `ParseError`.
    fn action_decl(&mut self, reversible: bool) -> PResult<Stmt> {
        self.eat_kw("action")?;
        let name = self.eat_ident()?;
        self.eat_op("(")?;
        let fields = self.parse_fields(")")?;
        self.eat_op(")")?;
        if self.check_op(":") {
            return Err(self.err(
                "an `action` may not declare a supertype — only `event` may extend `Error` (§19.5)",
            ));
        }
        // The trailing `;` is optional on a sink declaration (§15.2, §20).
        if self.check_op(";") {
            self.advance();
        }
        Ok(Stmt::ActionDecl {
            name,
            fields,
            reversible,
        })
    }

    /// `endorse (arg by rule) { variant: stmts ... } [abstain { ... }]` (§13).
    fn endorse_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("endorse")?;
        self.eat_op("(")?;
        let (arg, rule) = self.collapse_inner()?;
        self.eat_op(")")?;
        let arms = self.gate_arms()?;
        let abstain = if self.check_kw("abstain") {
            self.advance();
            Some(self.block()?)
        } else {
            None
        };
        Ok(Stmt::Endorse {
            arg,
            rule,
            arms,
            abstain,
        })
    }

    /// `attest e by p (arms | ;)` — the recorded identity-seam gate (§13). The
    /// `by` target is parsed as an expression so `by "alice"` is a checker
    /// `TypeError` (no text→Principal), not a `ParseError`.
    fn attest_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("attest")?;
        let arg = self.send()?;
        self.eat_ctx("by")?;
        self.no_struct_lit = true;
        let by = self.compare()?;
        self.no_struct_lit = false;
        let arms = if self.check_op("{") {
            self.gate_arms()?
        } else {
            self.eat_op(";")?;
            Vec::new()
        };
        Ok(Stmt::Attest { arg, by, arms })
    }

    /// `certify ARTIFACT by (JUDGMENT by RULE) { arms } [abstain { ... }]`
    /// or `certify ARTIFACT by ENDORSEMENT { arms } ...` (§13).
    /// The positive verifier arm treats ARTIFACT as settled + endorsed.
    fn certify_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("certify")?;
        self.no_struct_lit = true;
        let artifact = self.compare()?;
        self.no_struct_lit = false;
        self.eat_ctx("by")?;
        let certifier = if self.check_op("(") {
            self.eat_op("(")?;
            let (arg, rule) = self.collapse_inner()?;
            self.eat_op(")")?;
            Certifier::Gate { arg, rule }
        } else {
            self.no_struct_lit = true;
            let decision = self.compare()?;
            self.no_struct_lit = false;
            Certifier::Endorsement(decision)
        };
        let arms = self.gate_arms()?;
        let abstain = if self.check_kw("abstain") {
            self.advance();
            Some(self.block()?)
        } else {
            None
        };
        Ok(Stmt::Certify {
            artifact,
            certifier,
            arms,
            abstain,
        })
    }

    /// `policy NAME { directive* }` — a named decision-policy bundle (§13). Each
    /// directive is `keyword operand` (colon-free); unknown keys are tolerated.
    fn policy_decl(&mut self) -> PResult<Stmt> {
        self.eat_kw("policy")?;
        let name = self.eat_ident()?;
        self.eat_op("{")?;
        let mut p = Stmt::PolicyDecl {
            name,
            threshold: None,
            margin: None,
            floor: None,
            conformal: None,
            readiness: None,
            fallback: None,
        };
        let Stmt::PolicyDecl {
            threshold,
            margin,
            floor,
            conformal,
            readiness,
            fallback,
            ..
        } = &mut p
        else {
            unreachable!()
        };
        while !self.check_op("}") && !self.at_eof() {
            let key = self.advance().value; // a contextual directive keyword
            match key.as_str() {
                "threshold" => *threshold = Some(self.parse_number()?),
                "margin" => *margin = Some(self.parse_number()?),
                "floor" => *floor = Some(self.parse_number()?),
                "conformal" => *conformal = Some(self.parse_number()?),
                "readiness" => *readiness = Some(self.parse_int()?),
                "fallback" => *fallback = Some(self.eat_ident()?),
                _ => {
                    // unknown directive: consume a single literal/ident operand if present.
                    if matches!(
                        self.cur().kind,
                        TokenKind::Int | TokenKind::Float | TokenKind::Str | TokenKind::Ident
                    ) {
                        self.advance();
                    }
                }
            }
        }
        self.eat_op("}")?;
        Ok(p)
    }

    /// Gate dispatch arms: `{ (true|false|Variant): stmts ... }` (no braces per
    /// arm; `;` is an empty body). Shared by `endorse` and `attest`.
    fn gate_arms(&mut self) -> PResult<Vec<(String, Vec<Stmt>)>> {
        self.eat_op("{")?;
        let mut arms = Vec::new();
        while !self.check_op("}") && !self.at_eof() {
            let label = if self.check_kw("true") {
                self.advance();
                "true".to_string()
            } else if self.check_kw("false") {
                self.advance();
                "false".to_string()
            } else {
                self.eat_ident()?
            };
            self.eat_op(":")?;
            let mut body = Vec::new();
            while !self.check_op("}") && !self.label_ahead() && !self.at_eof() {
                if self.check_op(";") {
                    self.advance(); // an empty arm body, e.g. `false: ;`
                    continue;
                }
                body.push(self.stmt()?);
            }
            arms.push((label, body));
        }
        self.eat_op("}")?;
        Ok(arms)
    }

    /// Parse `expr by rule` and return `(expr, rule)` — the collapse used inside
    /// `endorse(...)`/`attest`-free gate parens.
    fn collapse_inner(&mut self) -> PResult<(Expr, GateBasis)> {
        let arg = self.send()?;
        self.eat_ctx("by")?;
        let rule = self.parse_rule()?;
        Ok((arg, rule))
    }

    /// Lookahead: is the cursor at an arm label (`true`/`false`/ident followed by `:`)?
    fn label_ahead(&self) -> bool {
        let t = self.cur();
        let is_label = t.is_kw("true") || t.is_kw("false") || t.kind == TokenKind::Ident;
        is_label && self.peek(1).is_op(":")
    }

    /// A gate rule after `by`: `confidence θ [margin δ]`, `conformal α`, or a policy
    /// name / `Rule` value (§3, §13). `rule` in §15.2.
    fn parse_rule(&mut self) -> PResult<GateBasis> {
        if self.cur().is_ident("confidence") {
            self.advance();
            let value = self.parse_number()?;
            let margin = if self.cur().is_ident("margin") {
                self.advance();
                self.parse_number()?
            } else {
                0.0
            };
            Ok(GateBasis::Threshold {
                op: BinOp::from_str(">").unwrap(),
                value,
                margin,
            })
        } else if self.cur().is_ident("conformal") {
            self.advance();
            let alpha = self.parse_number()?;
            Ok(GateBasis::Conformal { alpha })
        } else {
            // a named `policy` or a `Rule` value (parsed below `by`/send so a trailing
            // `)` is not consumed).
            Ok(GateBasis::Value(Box::new(self.compare()?)))
        }
    }

    fn tool_decl(&mut self, reversible: bool) -> PResult<Stmt> {
        // Mandatory effect class (§6b): `read` observes the world, `write` is a
        // consequential sink. The decl dispatcher only enters here on `read`/`write`.
        let effect = if self.check_kw("write") {
            self.advance();
            ToolEffect::Write
        } else {
            self.eat_kw("read")?;
            ToolEffect::Read
        };
        self.eat_kw("tool")?;
        // Prefix return type, like a function signature (`read tool text search(text q);`).
        // `->` is retired (§2); use `null` for a tool with no meaningful return.
        let ret = Some(self.parse_type()?);
        let name = self.eat_ident()?;
        let params = self.parse_params()?;
        // The trailing `;` is optional on a tool declaration (§15.2, §20).
        if self.check_op(";") {
            self.advance();
        }
        Ok(Stmt::ToolDecl {
            name,
            params,
            ret,
            effect,
            reversible,
        })
    }

    /// `reversible action …` / `reversible (read|write) tool …` (§20). A
    /// `reversible` prefix marks a low-stakes consequential sink.
    fn reversible_decl(&mut self) -> PResult<Stmt> {
        self.eat_kw("reversible")?;
        if self.check_kw("action") {
            return self.action_decl(true);
        }
        if self.check_kw("read") || self.check_kw("write") {
            return self.tool_decl(true);
        }
        Err(self.err("`reversible` may only mark an `action` or a `(read|write) tool` (§20)"))
    }

    fn agent_decl(&mut self) -> PResult<Stmt> {
        self.eat_kw("agent")?;
        let name = self.eat_ident()?;
        // Agents are not generic (§19.5): a type-parameter list is a ParseError.
        if self.check_op("<") {
            return Err(self.err("an agent may not be generic (§19.5) — its parameterization lives in its `when`-handlers' event types"));
        }
        let params = if self.check_op("(") {
            self.parse_params()?
        } else {
            Vec::new()
        };
        // Optional implemented interfaces (`: I, J`), nominal conformance (§19.5).
        let mut ifaces = Vec::new();
        if self.check_op(":") {
            self.advance();
            ifaces.push(self.parse_modpath()?);
            while self.check_op(",") {
                self.advance();
                ifaces.push(self.parse_modpath()?);
            }
        }
        let (grants, has_grants, unconstrained) = self.grants_clause()?;
        let body = self.block()?;
        Ok(Stmt::AgentDecl {
            name,
            params,
            ifaces,
            grants,
            has_grants,
            unconstrained,
            body,
        })
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
            } else if self.check_kw("perform") {
                self.advance();
                CapKind::Perform
            } else if self.cur().is_ident("reach") {
                self.advance();
                CapKind::Reach
            } else if self.cur().is_ident("use") {
                self.advance();
                CapKind::Use
            } else {
                return Err(
                    self.err("expected 'perform', 'emit', 'reach', 'use', or '*' in grants")
                );
            };
            let target = self.parse_modpath()?;
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
        let parent = self.parse_modpath()?;
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
        Ok(Stmt::If {
            cond,
            then_body,
            else_body,
        })
    }

    fn on_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("on")?;
        let event = self.advance().value; // `awake` / `sleep`
        let body = self.block()?;
        Ok(Stmt::On { event, body })
    }

    /// `when (Type binder? (about subj)?) (if (guard))? block` (§7, §15.2).
    fn when_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("when")?;
        self.eat_op("(")?;
        let ty = self.parse_type()?;
        // An optional binder name (the matched event, evaluating to its payload).
        let binder = if self.cur().kind == TokenKind::Ident && !self.cur().is_ident("about") {
            Some(self.eat_ident()?)
        } else {
            None
        };
        let about = if self.cur().is_ident("about") {
            self.advance();
            Some(self.expr()?)
        } else {
            None
        };
        self.eat_op(")")?;
        let guard = if self.check_kw("if") {
            self.advance();
            self.eat_op("(")?;
            let g = self.expr()?;
            self.eat_op(")")?;
            Some(g)
        } else {
            None
        };
        let body = self.block()?;
        Ok(Stmt::When {
            ty,
            binder,
            about,
            guard,
            body,
        })
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
        Ok(Stmt::Catch {
            event_type,
            subject,
            binding,
            body,
        })
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
                // A variant label is an enum variant ident or a `bool` decision's
                // `true`/`false` (which lex as keywords).
                let variant = if self.check_kw("true") {
                    self.advance();
                    "true".to_string()
                } else if self.check_kw("false") {
                    self.advance();
                    "false".to_string()
                } else {
                    self.eat_ident()?
                };
                self.eat_op(":")?;
                arms.push((variant, self.block()?));
            }
        }
        self.eat_op("}")?;
        Ok(Stmt::Case {
            expr,
            binding,
            arms,
            default,
        })
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
            let body = if self.check_op("{") {
                self.block()?
            } else {
                Vec::new()
            };
            Ok(RetryTail::Predicate {
                ty,
                bind,
                pred,
                body,
            })
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
        if t.is_ident("Decision") {
            self.advance();
            self.eat_op("<")?;
            let inner = self.parse_type()?;
            self.eat_op(">")?;
            return Ok(Type::Decision(Box::new(inner)));
        }
        if t.is_ident("Endorsement") {
            self.advance();
            self.eat_op("<")?;
            let inner = self.parse_type()?;
            self.eat_op(">")?;
            return Ok(Type::Endorsement(Box::new(inner)));
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
            // A (possibly qualified) nominal type, optionally generic (`m.Box<int>`).
            let name = self.parse_modpath()?;
            if self.check_op("<") {
                self.advance();
                let mut args = vec![self.parse_type()?];
                while self.check_op(",") {
                    self.advance();
                    args.push(self.parse_type()?);
                }
                self.eat_op(">")?;
                return Ok(Type::Generic(name, args));
            }
            return Ok(Type::Named(name));
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
            self.advance()
                .value
                .parse::<i64>()
                .map_err(|_| self.err("bad integer literal"))
        } else {
            Err(self.err("expected an integer"))
        }
    }

    fn parse_number(&mut self) -> PResult<f64> {
        match self.cur().kind {
            TokenKind::Int | TokenKind::Float => self
                .advance()
                .value
                .parse::<f64>()
                .map_err(|_| self.err("bad number")),
            _ => Err(self.err("expected a number")),
        }
    }

    /// A triple operand (§15.2 `operand`): a variable/name or a literal
    /// (`String`/`Int`/`Float`). Returns its surface spelling.
    fn eat_operand(&mut self) -> PResult<String> {
        match self.cur().kind {
            TokenKind::Ident | TokenKind::Str | TokenKind::Int | TokenKind::Float => {
                Ok(self.advance().value)
            }
            _ => Err(self.err("expected a triple operand (a name or a literal)")),
        }
    }

    /// A query source: an agent name or the reserved `self` / `ledger`.
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
            return Ok(Expr::Verify {
                arg: Box::new(arg),
                by,
            });
        }
        if self.check_kw("endorse") {
            return self.endorse_expr();
        }
        self.collapse()
    }

    /// `endorse(e by rule)` in expression position → an `Endorsement` (§13).
    fn endorse_expr(&mut self) -> PResult<Expr> {
        self.eat_kw("endorse")?;
        self.eat_op("(")?;
        let (arg, rule) = self.collapse_inner()?;
        self.eat_op(")")?;
        Ok(Expr::EndorseExpr {
            arg: Box::new(arg),
            rule,
        })
    }

    /// `send by rule` — collapse a `Credence` to a `Decision` (§13). The lowest
    /// expression level: `by` binds looser than `<-`/`|>`.
    fn collapse(&mut self) -> PResult<Expr> {
        let left = self.send()?;
        if self.cur().is_ident("by") {
            self.advance();
            let rule = self.parse_rule()?;
            return Ok(Expr::Collapse {
                expr: Box::new(left),
                rule,
            });
        }
        Ok(left)
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
            return Ok(Expr::Send {
                dest: Box::new(left),
                payload: Box::new(payload),
                expires,
                retry,
            });
        }
        if self.check_op("->") {
            // `mem -> query` — memory recall (§10); the checker rejects a non-`mem` LHS.
            self.advance();
            let query = self.pipe()?;
            return Ok(Expr::Recall {
                mem: Box::new(left),
                query: Box::new(query),
            });
        }
        Ok(left)
    }

    /// `source |> func` — left-associative.
    fn pipe(&mut self) -> PResult<Expr> {
        let mut left = self.compare()?;
        while self.check_op("|>") {
            self.advance();
            let func = self.compare()?;
            left = Expr::Pipe {
                source: Box::new(left),
                func: Box::new(func),
            };
        }
        Ok(left)
    }

    fn compare(&mut self) -> PResult<Expr> {
        let mut left = self.addsub()?;
        while self.cur().kind == TokenKind::Op && BinOp::is_comparison(&self.cur().value) {
            let op = BinOp::from_str(&self.advance().value).unwrap();
            let right = self.addsub()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn addsub(&mut self) -> PResult<Expr> {
        let mut left = self.muldiv()?;
        while self.check_op("+") || self.check_op("-") {
            let op = BinOp::from_str(&self.advance().value).unwrap();
            let right = self.muldiv()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn muldiv(&mut self) -> PResult<Expr> {
        let mut left = self.unary()?;
        while self.check_op("*") || self.check_op("/") {
            let op = BinOp::from_str(&self.advance().value).unwrap();
            let right = self.unary()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
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
            // A generic call `f<T>(args)`: type args are erased; skip them when a
            // balanced `<…>` is immediately followed by a call `(`.
            if self.check_op("<") {
                if let Some(close) = self.typeargs_end(self.pos) {
                    if self.toks.get(close).map(|x| x.is_op("(")).unwrap_or(false) {
                        self.skip_typeargs()?;
                        let args = self.parse_args()?;
                        e = Expr::Call {
                            func: Box::new(e),
                            args,
                        };
                        continue;
                    }
                }
            }
            if self.check_op("(") {
                let args = self.parse_args()?;
                e = Expr::Call {
                    func: Box::new(e),
                    args,
                };
            } else if self.check_op(".") {
                self.advance();
                let prop = self.eat_ident()?;
                e = Expr::Member {
                    obj: Box::new(e),
                    prop,
                };
            } else if self.check_op("[") {
                self.advance();
                let index = self.expr()?;
                self.eat_op("]")?;
                e = Expr::Index {
                    obj: Box::new(e),
                    index: Box::new(index),
                };
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
                t.value
                    .parse::<i64>()
                    .map(Expr::Int)
                    .map_err(|_| self.err("bad int literal"))
            }
            TokenKind::Float => {
                self.advance();
                t.value
                    .parse::<f64>()
                    .map(Expr::Float)
                    .map_err(|_| self.err("bad float literal"))
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
                // A struct literal `Name { … }`, `Name<args> { … }`, or `m.Name { … }`
                // (only in expression position; suppressed for a gate scrutinee).
                if !self.no_struct_lit && self.peek(1).is_op("{") {
                    return self.struct_lit();
                }
                // `Name<args> { … }` — a generic struct literal.
                if self.peek(1).is_op("<") {
                    if let Some(close) = self.typeargs_end(self.pos + 1) {
                        if self.toks.get(close).map(|x| x.is_op("{")).unwrap_or(false) {
                            return self.struct_lit();
                        }
                    }
                }
                // `m.Name { … }` — a qualified struct literal (a dotted path then `{`).
                if self.peek(1).is_op(".") {
                    if let Some(after) = self.modpath_end(self.pos) {
                        if self.toks.get(after).map(|x| x.is_op("{")).unwrap_or(false) {
                            return self.struct_lit();
                        }
                        // `m.Box<int> { … }`
                        if self.toks.get(after).map(|x| x.is_op("<")).unwrap_or(false) {
                            if let Some(close) = self.typeargs_end(after) {
                                if self.toks.get(close).map(|x| x.is_op("{")).unwrap_or(false) {
                                    return self.struct_lit();
                                }
                            }
                        }
                    }
                }
                // A bare name; postfix handles any `.member` access / qualified path.
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
                    Ok(Expr::Verify {
                        arg: Box::new(arg),
                        by,
                    })
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
        let name = self.parse_modpath()?;
        // Generic type args are erased (monomorphization); skip them for the literal.
        if self.check_op("<") {
            self.skip_typeargs()?;
        }
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
        Ok(Expr::Decide {
            expr: Box::new(e),
            rule,
        })
    }

    /// `quorum(k, [c1, …, cn])` — fuse an `array<Credence<bool>>` (§12, §15.2).
    fn quorum_expr(&mut self) -> PResult<Expr> {
        self.eat_kw("quorum")?;
        self.eat_op("(")?;
        let k = self.parse_int()?;
        self.eat_op(",")?;
        let arg = self.expr()?;
        self.eat_op(")")?;
        // An array literal exposes its judges to the dependence check; any other
        // expression is the single source (a bound `array<Credence>`).
        let judges = match arg {
            Expr::Array(es) => es,
            other => vec![other],
        };
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
                let s = self.eat_operand()?;
                let p = self.eat_operand()?;
                let o = self.eat_operand()?;
                pattern.push((s, p, o));
                if self.check_op(";") {
                    self.advance();
                }
            }
            self.eat_op("}")?;
            return Ok(Query::Find {
                binding,
                origin,
                pattern,
            });
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
                } else if self.cur().kind == TokenKind::Op
                    && BinOp::is_comparison(&self.cur().value)
                {
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
            return Ok(Query::Select {
                cols,
                source,
                star,
                conds,
            });
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
            return Ok(Query::Match {
                binding,
                query: Box::new(query),
                threshold,
            });
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
        let s =
            p("Credence<bool> c = self <- \"is this an approval?\"; bool b = decide(c, > 0.9);");
        assert!(matches!(
            &s[0],
            Stmt::VarDecl {
                ty: Type::Credence(_),
                ..
            }
        ));
        assert!(matches!(
            &s[1],
            Stmt::VarDecl {
                expr: Some(Expr::Decide { .. }),
                ..
            }
        ));
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
        assert_eq!(
            perr("principal alice; calibrate memo by alice;").class,
            ErrorClass::Parse
        );
    }

    #[test]
    fn struct_decl_and_literal() {
        let s =
            p("struct Memo { amount: int, to: text } Memo m = Memo { amount: 100, to: \"bob\" };");
        assert!(matches!(&s[0], Stmt::StructDecl { fields, .. } if fields.len() == 2));
        assert!(matches!(
            &s[1],
            Stmt::VarDecl {
                expr: Some(Expr::StructLit { .. }),
                ..
            }
        ));
    }

    #[test]
    fn event_and_tool_and_authority() {
        let s = p("event Transfer(memo: Memo); read tool text search(text q); authority Transfer;");
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
        let s = p("independent j1, j2, j3; Credence<bool> a = quorum(2, [j1, j2, j3]);");
        assert!(matches!(
            &s[0],
            Stmt::DepDecl {
                kind: Dep::Independent,
                ..
            }
        ));
        assert!(matches!(
            &s[1],
            Stmt::VarDecl {
                expr: Some(Expr::Quorum { k: 2, .. }),
                ..
            }
        ));
    }

    #[test]
    fn verify_by_principal_and_threshold() {
        let s = p("verify memo by alice; verify c by > 0.9 margin 0.2; verify c;");
        assert!(matches!(
            &s[0],
            Stmt::Verify {
                by: Some(GateBasis::Value(_)),
                ..
            }
        ));
        assert!(matches!(
            &s[1],
            Stmt::Verify {
                by: Some(GateBasis::Threshold { .. }),
                ..
            }
        ));
        assert!(matches!(&s[2], Stmt::Verify { by: None, .. }));
    }

    #[test]
    fn query_stmt_and_expr_forms() {
        let s = p("select * from ledger where { etype: \"Spawned\" };");
        assert!(matches!(
            &s[0],
            Stmt::QueryStmt(Query::Select { star: true, .. })
        ));
        let s = p("Memo m = select amount, to from self where { kind: \"pending\" };");
        assert!(matches!(
            &s[0],
            Stmt::VarDecl {
                expr: Some(Expr::Query(_)),
                ..
            }
        ));
        let s = p("find n, origin(n) where { Coach is_named n };");
        assert!(matches!(
            &s[0],
            Stmt::QueryStmt(Query::Find {
                origin: Some(_),
                ..
            })
        ));
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
        assert!(matches!(
            &s[0],
            Stmt::VarDecl {
                expr: Some(Expr::Send { retry: Some(_), .. }),
                ..
            }
        ));
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
        let s = p("read tool text search(text q); agent R grants { use search } { text hits = search(\"q\"); }");
        assert!(matches!(&s[1], Stmt::AgentDecl { params, .. } if params.is_empty()));
    }
}
