//! Recursive-descent parser: tokens → [`ast`] nodes.
//!
//! Covers the core surface of Agape — types, function and agent declarations,
//! variable declarations, the primary statement forms, and the full expression
//! precedence ladder (send `<-`, pipe `|>`, entail/`~`, comparison, arithmetic,
//! unary, postfix call/member). The reactive/query statements (`when`, `catch`,
//! `case`, `retry`, `find`, `select`, `match`) are the next parser milestone;
//! see `README.md` → Roadmap.

use crate::ast::*;
use crate::token::{Token, TokenKind};

/// A parse failure with a message describing what was expected and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError(pub String);

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "parse error: {}", self.0)
    }
}

impl std::error::Error for ParseError {}

type PResult<T> = Result<T, ParseError>;

/// Scalar/`event` type keywords, used to recognize the start of a declaration.
const TYPE_KEYWORDS: &[&str] = &["int", "float", "bool", "text", "null", "event"];

pub struct Parser {
    toks: Vec<Token>,
    pos: usize,
}

/// Parse a whole program into a list of top-level statements.
pub fn parse(toks: Vec<Token>) -> PResult<Vec<Stmt>> {
    Parser::new(toks).program()
}

impl Parser {
    pub fn new(toks: Vec<Token>) -> Self {
        Parser { toks, pos: 0 }
    }

    // ── cursor helpers ────────────────────────────────────────────────────────

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

    fn err(&self, what: &str) -> ParseError {
        ParseError(format!("{what}, got {}", self.cur()))
    }

    // ── program / statements ──────────────────────────────────────────────────

    fn program(&mut self) -> PResult<Vec<Stmt>> {
        let mut stmts = Vec::new();
        while !self.at_eof() {
            stmts.push(self.stmt()?);
        }
        Ok(stmts)
    }

    fn stmt(&mut self) -> PResult<Stmt> {
        let t = self.cur().clone();

        if t.is_kw("agent") {
            return self.agent_decl();
        }
        if t.is_kw("extend") {
            return self.extend_stmt();
        }
        if t.is_kw("spawn") {
            return self.spawn_stmt();
        }
        if t.is_kw("awake") {
            self.advance();
            let name = self.eat_ident()?;
            self.eat_op(";")?;
            return Ok(Stmt::Awake(name));
        }
        if t.is_kw("sleep") {
            self.advance();
            let name = self.eat_ident()?;
            self.eat_op(";")?;
            return Ok(Stmt::Sleep(name));
        }
        if t.is_kw("verify") {
            return self.verify_stmt();
        }
        if t.is_kw("emit") {
            return self.emit_stmt();
        }
        if t.is_kw("say") {
            return self.say_stmt();
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
        if t.is_kw("retry") {
            let (count, body) = self.parse_retry_tail()?;
            return Ok(Stmt::Retry { count, body, target: None });
        }
        if t.is_kw("find") {
            return self.find_stmt();
        }
        if t.is_kw("select") {
            return self.select_stmt();
        }
        if t.is_kw("match") {
            return self.match_stmt();
        }

        // `sync` or a type keyword begins a declaration (fn or var).
        if t.is_kw("sync") || (t.kind == TokenKind::Keyword && TYPE_KEYWORDS.contains(&t.value.as_str())) {
            return self.decl();
        }

        // A bare identifier that begins `TYPE NAME ...` is a var decl with a
        // named (user/prelude) type; otherwise it is an expression statement.
        if t.kind == TokenKind::Ident && self.peek(1).kind == TokenKind::Ident {
            return self.decl();
        }

        // Fallback: an assignment (`self.x = ...`, `q = q + "...";`) or a bare
        // expression statement (e.g. a send `john <- "..."`).
        let e = self.expr()?;
        if self.check_op("=") {
            self.advance();
            let rhs = self.expr()?;
            self.eat_op(";")?;
            return Ok(Stmt::Assign { target: e, expr: rhs });
        }
        self.eat_op(";")?;
        Ok(Stmt::ExprStmt(e))
    }

    /// A declaration that begins with an optional `sync`, a type, and a name.
    /// Disambiguates function (`name(`) from variable (`name =`/`;`).
    fn decl(&mut self) -> PResult<Stmt> {
        let is_sync = if self.check_kw("sync") {
            self.advance();
            true
        } else {
            false
        };

        let ty = self.parse_type()?;
        let name = self.eat_ident()?;

        if self.check_op("(") {
            // function declaration
            let params = self.parse_params()?;
            let body = self.block()?;
            return Ok(Stmt::FnDecl { is_sync, ret: ty, name, params, body });
        }

        if is_sync {
            return Err(self.err("`sync` may only mark a function declaration"));
        }

        // variable declaration
        if self.check_op(";") {
            self.advance();
            return Ok(Stmt::VarDecl { ty, name, expr: None });
        }
        self.eat_op("=")?;
        let e = self.expr()?;

        // Trailing-send retry form: `X = dest <- msg retry(n) { ... };`
        if self.check_kw("retry") {
            let (count, body) = self.parse_retry_tail()?;
            self.eat_op(";")?;
            let vd = Stmt::VarDecl { ty, name, expr: Some(e) };
            return Ok(Stmt::Retry { count, body, target: Some(Box::new(vd)) });
        }

        self.eat_op(";")?;
        Ok(Stmt::VarDecl { ty, name, expr: Some(e) })
    }

    fn agent_decl(&mut self) -> PResult<Stmt> {
        self.eat_kw("agent")?;
        let name = self.eat_ident()?;
        let params = self.parse_params()?;
        let body = self.block()?;
        Ok(Stmt::AgentDecl { name, params, body })
    }

    fn extend_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("extend")?;
        let parent = self.eat_ident()?;
        let args = self.parse_args()?;
        self.eat_op(";")?;
        Ok(Stmt::Extend { parent, args })
    }

    fn spawn_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("spawn")?;
        let agent_type = self.eat_ident()?;
        let name = self.eat_ident()?;
        let args = self.parse_args()?;
        self.eat_op(";")?;
        Ok(Stmt::Spawn { agent_type, name, args })
    }

    fn verify_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("verify")?;
        // Parse the operand up to comparison level so `~`/`==` stay for verify.
        let left = self.addsub()?;
        let mut op = None;
        let mut right = None;
        if self.check_op("~") || self.check_op("==") {
            let o = self.advance().value;
            op = BinOp::from_str(&o);
            right = Some(self.addsub()?);
        }
        self.eat_op(";")?;
        Ok(Stmt::Verify { left, op, right })
    }

    fn emit_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("emit")?;
        let event_type = self.eat_ident()?;
        self.eat_op("(")?;
        let payload = self.expr()?;
        self.eat_op(")")?;
        self.eat_op(";")?;
        Ok(Stmt::Emit { event_type, payload })
    }

    fn say_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("say")?;
        self.eat_op("(")?;
        let e = self.expr()?;
        self.eat_op(")")?;
        self.eat_op(";")?;
        Ok(Stmt::Say(e))
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
        // `awake` / `sleep` are keywords here.
        let event = self.advance().value;
        let body = self.block()?;
        Ok(Stmt::On { event, body })
    }

    fn when_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("when")?;
        self.eat_op("(")?;
        let subject = self.expr()?;
        self.eat_op(")")?;
        let body = self.block()?;
        Ok(Stmt::When { subject, body })
    }

    fn catch_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("catch")?;
        let mut event_type = None;
        let mut subject = None;

        if self.check_op("(") {
            // `catch (SUBJECT) as b` — parenthesized subject, no event type.
            self.advance();
            subject = Some(self.expr()?);
            self.eat_op(")")?;
        } else {
            // `catch EventType[(SUBJECT)] as b`
            event_type = Some(self.eat_ident()?);
            if self.check_op("(") {
                self.advance();
                subject = Some(self.expr()?);
                self.eat_op(")")?;
            }
        }

        self.eat_as()?;
        let binding = self.eat_ident()?;
        let body = self.block()?;
        Ok(Stmt::Catch { event_type, subject, binding, body })
    }

    fn case_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("case")?;
        self.eat_op("(")?;
        let expr = self.expr()?;
        self.eat_op(")")?;
        self.eat_as()?;
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

    /// Parse `retry ( INT ) { body }` and return the count and body.
    fn parse_retry_tail(&mut self) -> PResult<(i64, Vec<Stmt>)> {
        self.eat_kw("retry")?;
        self.eat_op("(")?;
        let count = if self.cur().kind == TokenKind::Int {
            self.advance().value.parse::<i64>().map_err(|_| self.err("bad retry count"))?
        } else {
            return Err(self.err("expected retry count"));
        };
        self.eat_op(")")?;
        let body = self.block()?;
        Ok((count, body))
    }

    fn find_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("find")?;
        let binding = self.eat_ident()?;
        self.eat_kw("where")?;
        self.eat_op("{")?;
        let mut pattern = Vec::new();
        while !self.check_op("}") && !self.at_eof() {
            let subj = self.eat_ident()?;
            let pred = self.eat_ident()?;
            let obj = self.eat_ident()?;
            pattern.push((subj, pred, obj));
            if self.check_op(";") {
                self.advance();
            }
        }
        self.eat_op("}")?;
        self.eat_op(";")?;
        Ok(Stmt::Find { binding, pattern })
    }

    fn select_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("select")?;
        let mut cols = vec![self.eat_ident()?];
        while self.check_op(",") {
            self.advance();
            cols.push(self.eat_ident()?);
        }
        self.eat_kw("from")?;
        let agent = self.eat_ident()?;
        self.eat_kw("where")?;
        self.eat_op("{")?;
        let mut conds = Vec::new();
        while !self.check_op("}") && !self.at_eof() {
            let col = self.eat_ident()?;
            let op = self.advance().value; // ==, !=, <, >, <=, >=
            let val = self.expr()?;
            conds.push((col, op, val));
            if self.check_op(",") || self.check_op(";") {
                self.advance();
            }
        }
        self.eat_op("}")?;
        self.eat_op(";")?;
        Ok(Stmt::Select { cols, agent, conds })
    }

    fn match_stmt(&mut self) -> PResult<Stmt> {
        self.eat_kw("match")?;
        self.eat_op("{")?;
        let binding = self.eat_ident()?;
        self.eat_op(":")?;
        let query = self.expr()?;
        self.eat_op("}")?;
        self.eat_op(">")?;
        let threshold = match self.cur().kind {
            TokenKind::Float | TokenKind::Int => self
                .advance()
                .value
                .parse::<f64>()
                .map_err(|_| self.err("bad threshold"))?,
            _ => return Err(self.err("expected threshold number")),
        };
        self.eat_op(";")?;
        Ok(Stmt::Match { binding, query, threshold })
    }

    /// Consume the soft keyword `as` (it lexes as an identifier).
    fn eat_as(&mut self) -> PResult<()> {
        if self.cur().kind == TokenKind::Ident && self.cur().value == "as" {
            self.advance();
            Ok(())
        } else {
            Err(self.err("expected 'as'"))
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

    // ── types and params ──────────────────────────────────────────────────────

    fn parse_type(&mut self) -> PResult<Type> {
        let t = self.cur().clone();
        if t.is_kw("event") {
            self.advance();
            self.eat_op("<")?;
            let inner = self.parse_type()?;
            self.eat_op(">")?;
            return Ok(Type::Event(Box::new(inner)));
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

    /// A parenthesized, comma-separated argument list.
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

    // ── expressions (precedence climbing) ─────────────────────────────────────

    fn expr(&mut self) -> PResult<Expr> {
        // `verify` may stand as an expression that binds an event<Verification>.
        if self.check_kw("verify") {
            self.advance();
            let left = self.addsub()?;
            let mut op = None;
            let mut right = None;
            if self.check_op("~") || self.check_op("==") {
                op = BinOp::from_str(&self.advance().value);
                right = Some(Box::new(self.addsub()?));
            }
            return Ok(Expr::Verify { left: Box::new(left), op, right });
        }
        self.send()
    }

    /// `dest <- payload` — lowest precedence, right-associative.
    fn send(&mut self) -> PResult<Expr> {
        let left = self.pipe()?;
        if self.check_op("<-") {
            self.advance();
            let payload = self.send()?;
            return Ok(Expr::Send { dest: Box::new(left), payload: Box::new(payload) });
        }
        Ok(left)
    }

    /// `source |> func` — left-associative concurrent fan-out.
    fn pipe(&mut self) -> PResult<Expr> {
        let mut left = self.entail()?;
        while self.check_op("|>") {
            self.advance();
            let func = self.entail()?;
            left = Expr::Pipe { source: Box::new(left), func: Box::new(func) };
        }
        Ok(left)
    }

    /// `a ~ b` (similarity) or `a entail b` (entailment) — non-associative.
    fn entail(&mut self) -> PResult<Expr> {
        let left = self.compare()?;
        if self.check_op("~") {
            self.advance();
            let right = self.compare()?;
            return Ok(Expr::Binary {
                op: BinOp::Similar,
                left: Box::new(left),
                right: Box::new(right),
            });
        }
        if self.check_kw("entail") {
            self.advance();
            let claim = self.compare()?;
            return Ok(Expr::Entail { expr: Box::new(left), claim: Box::new(claim) });
        }
        Ok(left)
    }

    fn compare(&mut self) -> PResult<Expr> {
        let mut left = self.addsub()?;
        while self.cur().kind == TokenKind::Op
            && matches!(self.cur().value.as_str(), "==" | "!=" | "<" | ">" | "<=" | ">=")
        {
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

    /// Postfix call `(...)` and member access `.field`, left-associative.
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
                // Aggregators read like calls: all(...), any(...)
                "all" | "any" => {
                    self.advance();
                    Ok(Expr::Name(t.value))
                }
                _ => Err(self.err("unexpected keyword in expression")),
            },
            TokenKind::Op if t.value == "(" => {
                self.advance();
                let e = self.expr()?;
                self.eat_op(")")?;
                Ok(e)
            }
            _ => Err(self.err("expected an expression")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::lex;

    fn parse_src(src: &str) -> Vec<Stmt> {
        parse(lex(src).unwrap()).unwrap()
    }

    #[test]
    fn var_decl_with_arith() {
        let stmts = parse_src("int a = 2 + 3;");
        match &stmts[0] {
            Stmt::VarDecl { ty, name, expr } => {
                assert_eq!(*ty, Type::Int);
                assert_eq!(name, "a");
                assert!(matches!(expr, Some(Expr::Binary { op: BinOp::Add, .. })));
            }
            other => panic!("expected VarDecl, got {other:?}"),
        }
    }

    #[test]
    fn event_type_and_send() {
        let stmts = parse_src("event<null> taught = john <- \"A flush beats a straight.\";");
        match &stmts[0] {
            Stmt::VarDecl { ty, expr, .. } => {
                assert_eq!(*ty, Type::Event(Box::new(Type::Null)));
                assert!(matches!(expr, Some(Expr::Send { .. })));
            }
            other => panic!("expected VarDecl, got {other:?}"),
        }
    }

    #[test]
    fn sync_function_decl() {
        let stmts = parse_src("sync int double(int x) { return x * 2; }");
        match &stmts[0] {
            Stmt::FnDecl { is_sync, ret, name, params, body } => {
                assert!(*is_sync);
                assert_eq!(*ret, Type::Int);
                assert_eq!(name, "double");
                assert_eq!(params.len(), 1);
                assert!(matches!(body[0], Stmt::Return(Some(_))));
            }
            other => panic!("expected FnDecl, got {other:?}"),
        }
    }

    #[test]
    fn spawn_awake_sleep() {
        let stmts = parse_src("spawn Coach john(\"John\"); awake john; sleep john;");
        assert!(matches!(stmts[0], Stmt::Spawn { .. }));
        assert!(matches!(stmts[1], Stmt::Awake(_)));
        assert!(matches!(stmts[2], Stmt::Sleep(_)));
    }

    #[test]
    fn verify_similarity() {
        let stmts = parse_src("verify Name ~ \"John\";");
        match &stmts[0] {
            Stmt::Verify { op, right, .. } => {
                assert_eq!(*op, Some(BinOp::Similar));
                assert!(right.is_some());
            }
            other => panic!("expected Verify, got {other:?}"),
        }
    }

    #[test]
    fn entail_expression() {
        let stmts = parse_src("event<null> x = answer entail \"A flush beats a straight.\";");
        match &stmts[0] {
            Stmt::VarDecl { expr: Some(Expr::Entail { .. }), .. } => {}
            other => panic!("expected Entail, got {other:?}"),
        }
    }

    #[test]
    fn pipe_and_aggregator() {
        let stmts = parse_src("bool everyone = all(names |> is_it_john);");
        match &stmts[0] {
            Stmt::VarDecl { expr: Some(Expr::Call { func, args }), .. } => {
                assert!(matches!(**func, Expr::Name(ref n) if n == "all"));
                assert!(matches!(args[0], Expr::Pipe { .. }));
            }
            other => panic!("expected Call(all, [Pipe]), got {other:?}"),
        }
    }

    #[test]
    fn member_access_and_emit() {
        let stmts = parse_src("emit Event(f\"NamedAgent {n} validated.\");");
        assert!(matches!(stmts[0], Stmt::Emit { .. }));
    }

    #[test]
    fn catch_forms() {
        // type only
        let s = parse_src("catch Error as e { say(e); }");
        assert!(matches!(&s[0], Stmt::Catch { event_type: Some(t), subject: None, .. } if t == "Error"));
        // type + subject
        let s = parse_src("catch FailedVerification(Name) as e { say(e); }");
        assert!(matches!(&s[0], Stmt::Catch { event_type: Some(_), subject: Some(_), .. }));
        // parenthesized subject, no type
        let s = parse_src("catch (ve) as err { say(err); }");
        assert!(matches!(&s[0], Stmt::Catch { event_type: None, subject: Some(_), .. }));
    }

    #[test]
    fn when_and_on_hooks() {
        let s = parse_src("when (init) { emit Event(\"x\"); }");
        assert!(matches!(s[0], Stmt::When { .. }));
        let s = parse_src("on awake { emit Event(\"up\"); }");
        assert!(matches!(&s[0], Stmt::On { event, .. } if event == "awake"));
    }

    #[test]
    fn case_with_default() {
        let s = parse_src(
            "case (f()) as e { Entailment: { say(\"a\"); } Contradiction: { say(\"b\"); } default: { say(\"c\"); } }",
        );
        match &s[0] {
            Stmt::Case { arms, default, .. } => {
                assert_eq!(arms.len(), 2);
                assert_eq!(arms[0].0, "Entailment");
                assert!(default.is_some());
            }
            other => panic!("expected Case, got {other:?}"),
        }
    }

    #[test]
    fn retry_block_and_trailing() {
        let s = parse_src("retry(3) { verify x == true; }");
        assert!(matches!(&s[0], Stmt::Retry { count: 3, target: None, .. }));

        let s = parse_src("event<text> r = john <- q retry(3) { q = q + \"!\"; };");
        match &s[0] {
            Stmt::Retry { count: 3, target: Some(inner), .. } => {
                assert!(matches!(**inner, Stmt::VarDecl { .. }));
            }
            other => panic!("expected trailing Retry, got {other:?}"),
        }
    }

    #[test]
    fn query_statements() {
        let s = parse_src("find n where { Coach is_named n };");
        assert!(matches!(&s[0], Stmt::Find { pattern, .. } if pattern == &vec![("Coach".into(), "is_named".into(), "n".into())]));

        let s = parse_src("select first_name, source_timestamp from john where { type == \"identity\" };");
        match &s[0] {
            Stmt::Select { cols, agent, conds } => {
                assert_eq!(cols, &vec!["first_name".to_string(), "source_timestamp".to_string()]);
                assert_eq!(agent, "john");
                assert_eq!(conds.len(), 1);
                assert_eq!(conds[0].1, "==");
            }
            other => panic!("expected Select, got {other:?}"),
        }

        let s = parse_src("match { m: \"poker strategy\" } > 0.8;");
        assert!(matches!(&s[0], Stmt::Match { binding, threshold, .. } if binding == "m" && (*threshold - 0.8).abs() < 1e-9));
    }

    #[test]
    fn member_assignment() {
        let s = parse_src("self.name_verification = Verification(reply);");
        assert!(matches!(&s[0], Stmt::Assign { target: Expr::Member { .. }, .. }));
    }
}
