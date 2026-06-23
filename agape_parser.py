"""agape_parser.py — recursive-descent parser: token stream → AST."""
from __future__ import annotations
from lexer import lex, Token
import agape_ast as A


class ParseError(Exception):
    pass


class Parser:
    def __init__(self, tokens: list[Token]):
        self.toks = tokens
        self.pos = 0

    # ── token helpers ────────────────────────────────────────────────────────

    def _cur(self) -> Token:
        return self.toks[self.pos]

    def _peek(self, n: int = 0) -> Token:
        idx = self.pos + n
        return self.toks[idx] if idx < len(self.toks) else self.toks[-1]

    def _advance(self) -> Token:
        t = self.toks[self.pos]
        self.pos += 1
        return t

    def _eat(self, kind: str, value: str | None = None) -> Token:
        t = self._cur()
        if t.kind != kind or (value is not None and t.value != value):
            raise ParseError(
                f"expected {kind}({value!r}) but got {t.kind}({t.value!r}) "
                f"at {t.line}:{t.col}"
            )
        return self._advance()

    def _check(self, kind: str, value: str | None = None) -> bool:
        t = self._cur()
        return t.kind == kind and (value is None or t.value == value)

    def _check_peek(self, n: int, kind: str, value: str | None = None) -> bool:
        t = self._peek(n)
        return t.kind == kind and (value is None or t.value == value)

    # ── entry point ──────────────────────────────────────────────────────────

    def parse(self) -> list:
        stmts = []
        while not self._check("EOF"):
            stmts.append(self._stmt())
        return stmts

    # ── type parsing ─────────────────────────────────────────────────────────

    def _parse_type(self) -> A.SimpleType | A.EventType:
        if self._check("KW", "event"):
            self._advance()
            self._eat("OP", "<")
            inner = self._parse_type()
            self._eat("OP", ">")
            return A.EventType(inner)
        t = self._cur()
        if t.kind == "KW" and t.value in ("int", "float", "bool", "text", "null"):
            return A.SimpleType(self._advance().value)
        if t.kind == "ID":
            return A.SimpleType(self._advance().value)
        raise ParseError(f"expected type at {t.line}:{t.col}, got {t.kind}({t.value!r})")

    # ── statement dispatch ───────────────────────────────────────────────────

    def _stmt(self) -> object:
        t = self._cur()

        if t.kind == "KW":
            match t.value:
                case "agent":   return self._agent_decl()
                case "spawn":   return self._spawn_stmt()
                case "awake":   return self._awake_stmt()
                case "sleep":   return self._sleep_stmt()
                case "when":    return self._when_stmt()
                case "catch":   return self._catch_stmt()
                case "case":    return self._case_stmt()
                case "if":      return self._if_stmt()
                case "retry":   return self._retry_block_stmt()
                case "return":  return self._return_stmt()
                case "emit":    return self._emit_stmt()
                case "verify":  return self._verify_as_stmt()
                case "find":    return self._find_stmt()
                case "select":  return self._select_stmt()
                case "match":   return self._match_stmt()
                case "say":
                    self._advance()
                    self._eat("OP", "(")
                    arg = self._expr()
                    self._eat("OP", ")")
                    self._eat("OP", ";")
                    return A.SayStmt(arg)
                case "sync":
                    # sync fn: sync TYPE NAME(PARAMS) { BODY }
                    self._advance()
                    type_node = self._parse_type()
                    return self._fn_rest(type_node, is_async=False)
                case "self":
                    # self.prop = expr;
                    self._advance()
                    self._eat("OP", ".")
                    prop = self._eat("ID").value
                    self._eat("OP", "=")
                    expr = self._expr()
                    self._eat("OP", ";")
                    return A.AssignStmt(A.MemberAccess(A.Name("self"), prop), expr)
                case "event" | "int" | "float" | "bool" | "text" | "null":
                    return self._type_led_stmt()

        if t.kind == "ID":
            return self._id_led_stmt()

        # Fallback: expression statement
        expr = self._expr()
        self._eat("OP", ";")
        return A.ExprStmt(expr)

    def _type_led_stmt(self):
        type_node = self._parse_type()
        return self._type_led_after(type_node)

    def _type_led_after(self, type_node):
        """After parsing a return/variable type, determine fn decl vs var decl."""
        # async fn: TYPE async NAME(PARAMS) { BODY }
        if (self._check("ID") and self._peek(0).value == "async"
                and self._check_peek(1, "ID")
                and self._check_peek(2, "OP", "(")):
            self._advance()  # consume "async"
            return self._fn_rest(type_node, is_async=True)

        # sync fn: TYPE NAME(PARAMS) { BODY }
        if self._check("ID") and self._check_peek(1, "OP", "("):
            return self._fn_rest(type_node, is_async=False)

        # captured verify: TYPE NAME = verify EXPR [op EXPR];
        if (self._check("ID") and self._check_peek(1, "OP", "=")
                and self._check_peek(2, "KW", "verify")):
            name = self._eat("ID").value
            self._advance()  # "="
            self._advance()  # "verify"
            left = self._postfix_expr()
            op = None
            right = None
            if self._check("OP", "~") or self._check("OP", "=="):
                op = self._advance().value
                right = self._postfix_expr()
            self._eat("OP", ";")
            return A.VarDecl(type_node=type_node, name=name,
                             expr=A.VerifyExpr(left, op, right))

        # var decl: TYPE NAME [= EXPR] ;
        name = self._eat("ID").value
        expr = None
        if self._check("OP", "="):
            self._advance()
            expr = self._expr()
        self._eat("OP", ";")
        return A.VarDecl(type_node=type_node, name=name, expr=expr)

    def _fn_rest(self, type_node, is_async: bool):
        name = self._eat("ID").value
        params = self._parse_params()
        body = self._block()
        return A.FnDecl(is_async=is_async, ret_type=type_node,
                        name=name, params=params, body=body)

    def _id_led_stmt(self):
        """ID-led statement: user type decl, assignment, or expression."""
        # UserType async NAME(PARAMS) { BODY }
        if (self._check_peek(1, "ID") and self._peek(1).value == "async"
                and self._check_peek(2, "ID")
                and self._check_peek(3, "OP", "(")):
            type_node = A.SimpleType(self._advance().value)
            self._advance()  # "async"
            return self._fn_rest(type_node, is_async=True)

        # UserType NAME(PARAMS) { BODY }
        if self._check_peek(1, "ID") and self._check_peek(2, "OP", "("):
            type_node = A.SimpleType(self._advance().value)
            return self._fn_rest(type_node, is_async=False)

        # UserType NAME = EXPR;
        if self._check_peek(1, "ID") and self._check_peek(2, "OP", "="):
            type_node = A.SimpleType(self._advance().value)
            name = self._eat("ID").value
            self._advance()  # "="
            expr = self._expr()
            self._eat("OP", ";")
            return A.VarDecl(type_node=type_node, name=name, expr=expr)

        # NAME = EXPR;  (simple assignment)
        if self._check_peek(1, "OP", "="):
            name = self._advance().value
            self._advance()  # "="
            expr = self._expr()
            self._eat("OP", ";")
            return A.AssignStmt(A.Name(name), expr)

        # Expression statement (send, call, …)
        expr = self._expr()
        self._eat("OP", ";")
        return A.ExprStmt(expr)

    # ── specific statement parsers ────────────────────────────────────────────

    def _agent_decl(self):
        self._eat("KW", "agent")
        name = self._eat("ID").value
        params = self._parse_params()
        body = self._agent_body()
        return A.AgentDecl(name, params, body)

    def _agent_body(self):
        self._eat("OP", "{")
        stmts = []
        while not self._check("OP", "}"):
            stmts.append(self._agent_body_stmt())
        self._eat("OP", "}")
        return stmts

    def _agent_body_stmt(self):
        t = self._cur()
        if t.kind == "KW" and t.value == "extend":
            return self._extend_stmt()
        if t.kind == "KW" and t.value == "on":
            return self._on_hook()
        return self._stmt()

    def _extend_stmt(self):
        self._eat("KW", "extend")
        parent = self._eat("ID").value
        self._eat("OP", "(")
        args = []
        if not self._check("OP", ")"):
            args.append(self._expr())
            while self._check("OP", ","):
                self._advance()
                args.append(self._expr())
        self._eat("OP", ")")
        self._eat("OP", ";")
        return A.ExtendStmt(parent, args)

    def _on_hook(self):
        self._eat("KW", "on")
        hook = self._cur().value
        if hook not in ("awake", "sleep"):
            raise ParseError(f"expected 'awake' or 'sleep' after 'on', got {hook!r}")
        self._advance()
        body = self._block()
        return A.OnAwake(body) if hook == "awake" else A.OnSleep(body)

    def _spawn_stmt(self):
        self._eat("KW", "spawn")
        agent_type = self._eat("ID").value
        name = self._eat("ID").value
        self._eat("OP", "(")
        args = []
        if not self._check("OP", ")"):
            args.append(self._expr())
            while self._check("OP", ","):
                self._advance()
                args.append(self._expr())
        self._eat("OP", ")")
        self._eat("OP", ";")
        return A.SpawnStmt(agent_type, name, args)

    def _awake_stmt(self):
        self._eat("KW", "awake")
        name = self._eat("ID").value
        self._eat("OP", ";")
        return A.AwakeStmt(name)

    def _sleep_stmt(self):
        self._eat("KW", "sleep")
        name = self._eat("ID").value
        self._eat("OP", ";")
        return A.SleepStmt(name)

    def _when_stmt(self):
        self._eat("KW", "when")
        self._eat("OP", "(")
        subject = self._expr()
        self._eat("OP", ")")
        body = self._block()
        return A.WhenStmt(subject, body)

    def _catch_stmt(self):
        self._eat("KW", "catch")
        if self._check("OP", "("):
            # Inferred type: catch (EXPR) as BINDING { BODY }
            self._advance()
            subject = self._expr()
            self._eat("OP", ")")
            self._eat("ID", "as")
            binding = self._eat("ID").value
            body = self._block()
            return A.CatchStmt(event_type=None, subject=subject,
                               binding=binding, body=body)
        else:
            # Explicit type: catch TYPE [(EXPR)] as BINDING { BODY }
            event_type = self._eat("ID").value
            subject = None
            if self._check("OP", "("):
                self._advance()
                subject = self._expr()
                self._eat("OP", ")")
            self._eat("ID", "as")
            binding = self._eat("ID").value
            body = self._block()
            return A.CatchStmt(event_type=event_type, subject=subject,
                               binding=binding, body=body)

    def _case_stmt(self):
        self._eat("KW", "case")
        self._eat("OP", "(")
        expr = self._expr()
        self._eat("OP", ")")
        self._eat("ID", "as")
        binding = self._eat("ID").value
        self._eat("OP", "{")
        arms = []
        default_body = None
        while not self._check("OP", "}"):
            if self._check("KW", "default"):
                self._advance()
                self._eat("OP", ":")
                default_body = self._block()
            else:
                variant = self._eat("ID").value
                self._eat("OP", ":")
                arm_body = self._block()
                arms.append((variant, arm_body))
        self._eat("OP", "}")
        return A.CaseStmt(expr, binding, arms, default_body)

    def _if_stmt(self):
        self._eat("KW", "if")
        self._eat("OP", "(")
        cond = self._expr()
        self._eat("OP", ")")
        then_body = self._block()
        else_body = []
        if self._check("KW", "else"):
            self._advance()
            else_body = self._block()
        return A.IfStmt(cond, then_body, else_body)

    def _retry_block_stmt(self):
        self._eat("KW", "retry")
        self._eat("OP", "(")
        n = int(self._eat("INT").value)
        self._eat("OP", ")")
        body = self._block()
        return A.RetryBlockStmt(n, body)

    def _return_stmt(self):
        self._eat("KW", "return")
        expr = self._expr()
        self._eat("OP", ";")
        return A.ReturnStmt(expr)

    def _emit_stmt(self):
        self._eat("KW", "emit")
        event_type = self._eat("ID").value
        self._eat("OP", "(")
        payload = self._expr()
        self._eat("OP", ")")
        self._eat("OP", ";")
        return A.EmitStmt(event_type, payload)

    def _verify_as_stmt(self):
        self._eat("KW", "verify")
        # Parse left only up to addition level so ~ and == are NOT consumed by
        # _cmp_expr.  They must remain for verify to treat as the verify operator.
        left = self._postfix_expr()
        op = None
        right = None
        if self._check("OP", "~") or self._check("OP", "=="):
            op = self._advance().value
            right = self._postfix_expr()
        self._eat("OP", ";")
        return A.VerifyStmt(left, op, right)

    def _find_stmt(self):
        self._eat("KW", "find")
        binding = self._eat("ID").value
        self._eat("KW", "where")
        self._eat("OP", "{")
        pattern = []
        while not self._check("OP", "}"):
            # Triple: SUBJECT PREDICATE OBJECT  (all identifiers)
            subj = self._eat("ID").value
            pred = self._eat("ID").value
            obj  = self._eat("ID").value
            pattern.append((subj, pred, obj))
            if self._check("OP", ";"):
                self._advance()
        self._eat("OP", "}")
        self._eat("OP", ";")
        return A.FindStmt(binding, pattern)

    def _select_stmt(self):
        # select COL, COL, … from AGENT where { … };
        self._eat("KW", "select")
        cols = [self._eat("ID").value]
        while self._check("OP", ","):
            self._advance()
            cols.append(self._eat("ID").value)
        self._eat("KW", "from")
        agent = self._eat("ID").value
        self._eat("KW", "where")
        # Consume the where block as raw tokens (POC stub)
        self._eat("OP", "{")
        depth = 1
        while depth > 0:
            if self._check("OP", "{"):
                depth += 1
            elif self._check("OP", "}"):
                depth -= 1
            if depth > 0:
                self._advance()
        self._eat("OP", "}")
        self._eat("OP", ";")
        return A.SelectStmt(cols, agent, raw="<stub>")

    def _match_stmt(self):
        # match { BINDING: EXPR } > THRESHOLD;
        self._eat("KW", "match")
        self._eat("OP", "{")
        binding = self._eat("ID").value
        self._eat("OP", ":")
        query = self._expr()
        self._eat("OP", "}")
        self._eat("OP", ">")
        t = self._cur()
        if t.kind == "FLOAT":
            threshold = float(self._advance().value)
        elif t.kind == "INT":
            threshold = float(self._advance().value)
        else:
            raise ParseError(f"expected threshold number, got {t}")
        self._eat("OP", ";")
        return A.MatchStmt(binding, query, threshold)

    # ── block ────────────────────────────────────────────────────────────────

    def _block(self) -> list:
        self._eat("OP", "{")
        stmts = []
        while not self._check("OP", "}"):
            stmts.append(self._stmt())
        self._eat("OP", "}")
        return stmts

    def _parse_params(self) -> list[tuple]:
        self._eat("OP", "(")
        params = []
        if not self._check("OP", ")"):
            type_node = self._parse_type()
            name = self._eat("ID").value
            params.append((type_node, name))
            while self._check("OP", ","):
                self._advance()
                type_node = self._parse_type()
                name = self._eat("ID").value
                params.append((type_node, name))
        self._eat("OP", ")")
        return params

    # ── expression grammar ───────────────────────────────────────────────────
    # Precedence (low → high):
    #   expr > pipe > entail > cmp > add > mul > unary > postfix > primary
    # The send operator "<-" is at the expr level (lowest).

    def _expr(self):
        left = self._pipe_expr()
        if self._check("OP", "<-"):
            self._advance()
            payload = self._expr()
            retry_n = 0
            retry_body = []
            if self._check("KW", "retry"):
                self._advance()
                self._eat("OP", "(")
                retry_n = int(self._eat("INT").value)
                self._eat("OP", ")")
                retry_body = self._block()
            if not isinstance(left, A.Name):
                raise ParseError(f"left of <- must be a name, got {left!r}")
            return A.SendExpr(dest=left.ident, payload=payload,
                              retry_n=retry_n, retry_body=retry_body)
        return left

    def _pipe_expr(self):
        left = self._entail_expr()
        while self._check("OP", "|>"):
            self._advance()
            right = self._entail_expr()
            left = A.PipeExpr(left, right)
        return left

    def _entail_expr(self):
        left = self._cmp_expr()
        if self._check("KW", "entail"):
            self._advance()
            right = self._cmp_expr()
            return A.EntailExpr(left, right)
        return left

    def _cmp_expr(self):
        left = self._add_expr()
        if self._check("OP") and self._cur().value in ("==", "!=", "<", ">", "<=", ">=", "~"):
            op = self._advance().value
            right = self._add_expr()
            return A.BinOp(op, left, right)
        return left

    def _add_expr(self):
        left = self._mul_expr()
        while self._check("OP") and self._cur().value in ("+", "-"):
            op = self._advance().value
            right = self._mul_expr()
            left = A.BinOp(op, left, right)
        return left

    def _mul_expr(self):
        left = self._unary_expr()
        while self._check("OP") and self._cur().value in ("*", "/"):
            op = self._advance().value
            right = self._unary_expr()
            left = A.BinOp(op, left, right)
        return left

    def _unary_expr(self):
        if self._check("OP", "!"):
            self._advance()
            return A.UnaryOp("!", self._unary_expr())
        return self._postfix_expr()

    def _postfix_expr(self):
        left = self._primary()
        while self._check("OP", "."):
            self._advance()
            prop = self._eat("ID").value
            left = A.MemberAccess(left, prop)
        return left

    def _primary(self):
        t = self._cur()

        if t.kind == "INT":
            self._advance()
            return A.IntLit(int(t.value))
        if t.kind == "FLOAT":
            self._advance()
            return A.FloatLit(float(t.value))
        if t.kind == "STR":
            self._advance()
            return A.StrLit(t.value)
        if t.kind == "FSTR":
            self._advance()
            return A.FStrLit(t.value)
        if t.kind == "KW" and t.value == "true":
            self._advance()
            return A.BoolLit(True)
        if t.kind == "KW" and t.value == "false":
            self._advance()
            return A.BoolLit(False)
        if t.kind == "KW" and t.value == "null":
            self._advance()
            return A.NullLit()
        if t.kind == "KW" and t.value == "self":
            self._advance()
            return A.Name("self")
        if t.kind == "OP" and t.value == "(":
            self._advance()
            e = self._expr()
            self._eat("OP", ")")
            return e
        # Built-in aggregation keywords used as calls: all(...), any(...)
        if t.kind == "KW" and t.value in ("all", "any"):
            func_name = self._advance().value
            if self._check("OP", "("):
                return self._call_args(A.Name(func_name))
            return A.Name(func_name)
        # Identifier: could be a call or a name
        if t.kind == "ID":
            name = self._advance().value
            if self._check("OP", "("):
                return self._call_args(A.Name(name))
            return A.Name(name)

        raise ParseError(
            f"unexpected token {t.kind}({t.value!r}) in expression at {t.line}:{t.col}"
        )

    def _call_args(self, func):
        self._eat("OP", "(")
        args = []
        if not self._check("OP", ")"):
            args.append(self._expr())
            while self._check("OP", ","):
                self._advance()
                args.append(self._expr())
        self._eat("OP", ")")
        return A.Call(func, args)


# ── convenience entry point ──────────────────────────────────────────────────

def parse(source: str) -> list:
    tokens = lex(source)
    return Parser(tokens).parse()
