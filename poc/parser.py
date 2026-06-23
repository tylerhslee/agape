from lexer import T
import ast_nodes as A


class Parser:
    """Tokens -> AST (recursive descent).

    The parser knows GRAMMAR, not MEANING. Inside a query pattern it records
    identifier text by position and does NOT decide whether a name is a bound
    value, a type, or a fresh variable — that resolution is deferred to the
    evaluator. Each stage knows exactly one more thing than the last.
    """

    def __init__(self, tokens):
        self.toks = tokens
        self.i = 0

    # ---- token helpers ----

    def _cur(self):
        return self.toks[self.i]

    def _peek_at(self, offset):
        idx = self.i + offset
        return self.toks[idx] if idx < len(self.toks) else self.toks[-1]

    def _at(self, *ttypes):
        return self._cur().type in ttypes

    def _advance(self):
        tok = self.toks[self.i]
        self.i += 1
        return tok

    def _expect(self, ttype):
        tok = self._cur()
        if tok.type != ttype:
            raise SyntaxError(
                f"expected {ttype.name} but found {tok.type.name} "
                f"({tok.value!r}) at position {tok.pos}"
            )
        return self._advance()

    # ---- entry point ----

    def parse(self):
        stmts = []
        while not self._at(T.EOF):
            stmts.append(self._statement())
        return stmts

    # ---- statements ----

    def _statement(self):
        t = self._cur().type
        if t == T.AGENT:   return self._agent_decl()
        if t == T.SPAWN:   return self._spawn_stmt()
        if t == T.AWAKE:   return self._awake_stmt()
        if t == T.SLEEP:   return self._sleep_stmt()
        if t == T.FN:      return self._fn_decl()
        if t == T.EVENT:   return self._event_decl()
        if t == T.VERIFY:  return self._verify_stmt()
        if t == T.CATCH:   return self._catch_stmt()
        if t == T.WHEN:    return self._when_stmt()
        if t == T.FIND:    return self._find_stmt()
        if t == T.RETURN:  return self._return_stmt()
        if t == T.EMIT:    return self._emit_stmt()
        if t == T.EXTEND:  return self._extend_stmt()
        if t == T.IF:      return self._if_stmt()
        if t == T.IDENT:   return self._ident_stmt()
        expr = self._expression()
        self._expect(T.SEMI)
        return A.ExprStmt(expr)

    def _ident_stmt(self):
        """Disambiguate the three IDENT-led statement forms:
          IDENT DOT IDENT EQUALS          -> PropertyAssign
          IDENT IDENT EQUALS              -> TypedDecl  (Type name = expr)
          IDENT LBRACKET RBRACKET IDENT EQUALS -> TypedDecl array (Type[] name = expr)
          otherwise                       -> ExprStmt
        """
        if (self._peek_at(1).type == T.DOT and
                self._peek_at(2).type == T.IDENT and
                self._peek_at(3).type == T.EQUALS):
            obj  = self._expect(T.IDENT).value
            self._expect(T.DOT)
            prop = self._expect(T.IDENT).value
            self._expect(T.EQUALS)
            val  = self._expression()
            self._expect(T.SEMI)
            return A.PropertyAssign(obj, prop, val)

        if (self._peek_at(1).type == T.IDENT and
                self._peek_at(2).type == T.EQUALS):
            type_name = self._expect(T.IDENT).value
            name      = self._expect(T.IDENT).value
            self._expect(T.EQUALS)
            expr = self._expression()
            self._expect(T.SEMI)
            return A.TypedDecl(type_name, False, name, expr)

        if (self._peek_at(1).type == T.LBRACKET and
                self._peek_at(2).type == T.RBRACKET and
                self._peek_at(3).type == T.IDENT and
                self._peek_at(4).type == T.EQUALS):
            type_name = self._expect(T.IDENT).value
            self._expect(T.LBRACKET); self._expect(T.RBRACKET)
            name      = self._expect(T.IDENT).value
            self._expect(T.EQUALS)
            expr = self._expression()
            self._expect(T.SEMI)
            return A.TypedDecl(type_name, True, name, expr)

        expr = self._expression()
        self._expect(T.SEMI)
        return A.ExprStmt(expr)

    def _agent_decl(self):
        self._expect(T.AGENT)
        name   = self._expect(T.IDENT).value
        params = self._param_list()
        body   = self._block()
        return A.AgentDecl(name, params, body)

    def _spawn_stmt(self):
        self._expect(T.SPAWN)
        agent_type = self._expect(T.IDENT).value
        name       = self._expect(T.IDENT).value
        self._expect(T.LPAREN)
        args = self._arg_list()
        self._expect(T.RPAREN)
        self._expect(T.SEMI)
        return A.SpawnStmt(agent_type, name, args)

    def _awake_stmt(self):
        self._expect(T.AWAKE)
        name = self._expect(T.IDENT).value
        self._expect(T.SEMI)
        return A.AwakeStmt(name)

    def _sleep_stmt(self):
        self._expect(T.SLEEP)
        name = self._expect(T.IDENT).value
        self._expect(T.SEMI)
        return A.SleepStmt(name)

    def _fn_decl(self):
        self._expect(T.FN)
        return_type = self._expect(T.IDENT).value
        name        = self._expect(T.IDENT).value
        params      = self._param_list()
        body        = self._block()
        return A.FnDecl(return_type, name, params, body)

    def _event_decl(self):
        """event<T> name;  or  event<T> name = expr;
        Special form: event<Verification> ve = verify expr;
        captures the Verification event produced by verify as a value.
        """
        self._expect(T.EVENT)
        self._expect(T.LT)
        event_type = self._expect(T.IDENT).value
        self._expect(T.GT)
        name = self._expect(T.IDENT).value
        expr = None
        if self._at(T.EQUALS):
            self._advance()
            if self._at(T.VERIFY):
                # verify used as expression: run it and capture the event
                self._advance()
                check = self._expression()
                expr  = A.VerifyStmt(check)
            else:
                expr = self._expression()
        self._expect(T.SEMI)
        return A.EventDecl(event_type, name, expr)

    def _verify_stmt(self):
        self._expect(T.VERIFY)
        check = self._expression()
        self._expect(T.SEMI)
        return A.VerifyStmt(check)

    def _catch_stmt(self):
        """Two forms:
          catch EventType(source) as binding { body }   -- explicit event type
          catch (source) as binding { body }             -- type inferred from source
        Disambiguated by what follows CATCH: LPAREN = inferred, IDENT = explicit.
        """
        self._expect(T.CATCH)
        if self._at(T.LPAREN):
            self._advance()
            source  = self._expression()
            self._expect(T.RPAREN)
            self._expect(T.AS)
            binding = self._expect(T.IDENT).value
            body    = self._block()
            return A.Catch(None, source, binding, body)
        else:
            event_type = self._expect(T.IDENT).value
            self._expect(T.LPAREN)
            source     = self._expression()
            self._expect(T.RPAREN)
            self._expect(T.AS)
            binding    = self._expect(T.IDENT).value
            body       = self._block()
            return A.Catch(event_type, source, binding, body)

    def _when_stmt(self):
        """when (event_expr) { body }
        Special form: when (sleep self) { body } is the agent destructor.
        """
        self._expect(T.WHEN)
        self._expect(T.LPAREN)
        if self._at(T.SLEEP):
            self._advance()
            agent_name = self._expect(T.IDENT).value
            self._expect(T.RPAREN)
            body = self._block()
            return A.WhenStmt(A.SleepStmt(agent_name), body)
        event_expr = self._expression()
        self._expect(T.RPAREN)
        body = self._block()
        return A.WhenStmt(event_expr, body)

    def _emit_stmt(self):
        self._expect(T.EMIT)
        event_type = self._expect(T.IDENT).value
        self._expect(T.LPAREN)
        msg = self._expression()
        self._expect(T.RPAREN)
        self._expect(T.SEMI)
        return A.EmitStmt(event_type, msg)

    def _extend_stmt(self):
        self._expect(T.EXTEND)
        parent = self._expect(T.IDENT).value
        self._expect(T.LPAREN)
        args = self._arg_list()
        self._expect(T.RPAREN)
        self._expect(T.SEMI)
        return A.ExtendStmt(parent, args)

    def _if_stmt(self):
        # Condition is a plain expression — parentheses are part of the expression,
        # not a mandatory wrapper. This lets `if !(x)` and `if (x ~ y)` both work.
        self._expect(T.IF)
        cond  = self._expression()
        then  = self._block()
        else_ = []
        if self._at(T.ELSE):
            self._advance()
            else_ = self._block()
        return A.IfStmt(cond, then, else_)

    def _return_stmt(self):
        self._expect(T.RETURN)
        expr = self._expression()
        self._expect(T.SEMI)
        return A.ReturnStmt(expr)

    def _find_stmt(self):
        self._expect(T.FIND)
        result = self._expect(T.IDENT).value
        self._expect(T.WHERE)
        self._expect(T.LBRACE)
        pattern = self._pattern()
        self._expect(T.RBRACE)
        self._expect(T.SEMI)
        return A.Find(result, pattern)

    def _block(self):
        self._expect(T.LBRACE)
        stmts = []
        while not self._at(T.RBRACE):
            stmts.append(self._statement())
        self._expect(T.RBRACE)
        return stmts

    # ---- parameter and argument lists ----

    def _param_list(self):
        """(TypeName param, ...) — for agent and fn declarations."""
        params = []
        if self._at(T.LPAREN):
            self._advance()
            while not self._at(T.RPAREN):
                type_name  = self._expect(T.IDENT).value
                param_name = self._expect(T.IDENT).value
                params.append((type_name, param_name))
                if self._at(T.COMMA): self._advance()
            self._expect(T.RPAREN)
        return params

    def _arg_list(self):
        """Comma-separated expressions inside ()."""
        args = []
        if not self._at(T.RPAREN):
            args.append(self._expression())
            while self._at(T.COMMA):
                self._advance()
                args.append(self._expression())
        return args

    # ---- query patterns ----

    def _pattern(self):
        triples = []
        while not self._at(T.RBRACE):
            self._chain(triples)
            if self._at(T.COMMA): self._advance()
        return triples

    def _chain(self, triples):
        # node (edge node)+ -> chain of triples sharing intermediate nodes.
        prev = self._node_atom()
        while not (self._at(T.COMMA) or self._at(T.RBRACE)):
            pred = self._expect(T.IDENT).value
            nxt  = self._node_atom()
            triples.append(A.TriplePattern(prev, pred, nxt))
            prev = nxt

    def _node_atom(self):
        if self._at(T.STRING): return self._advance().value
        return self._expect(T.IDENT).value

    # ---- expressions (precedence: send > compare > pipe > unary > postfix > primary) ----

    def _expression(self):
        return self._send_expr()

    def _send_expr(self):
        left = self._compare_expr()
        if self._at(T.ARROW):                       # left <- right
            self._advance()
            right = self._expression()
            if not isinstance(left, A.Name):
                raise SyntaxError("left of <- must be an agent name")
            return A.Send(left.ident, right)
        if self._at(T.RARROW):                      # left -> right (right is target)
            self._advance()
            right = self._primary()
            if not isinstance(right, A.Name):
                raise SyntaxError("right of -> must be an agent name")
            return A.Send(right.ident, left)
        return left

    def _compare_expr(self):
        left = self._pipe_expr()
        if self._at(T.EQEQ):
            self._advance()
            return A.Compare(left, "exact",    self._pipe_expr())
        if self._at(T.TILDE):
            self._advance()
            return A.Compare(left, "semantic", self._pipe_expr())
        if self._at(T.IS):
            self._advance()
            return A.Compare(left, "identity", self._pipe_expr())
        return left

    def _pipe_expr(self):
        left = self._unary()
        if self._at(T.PIPEARROW):
            self._advance()
            func = self._pipe_rhs()
            return A.PipeExpr(left, func)
        return left

    def _pipe_rhs(self):
        """After |>: lambda (x: expr) or function reference (Name)."""
        if self._at(T.IDENT) and self._peek_at(1).type == T.COLON:
            param = self._expect(T.IDENT).value
            self._expect(T.COLON)
            body  = self._unary()
            return A.Lambda(param, body)
        return self._primary()

    def _unary(self):
        if self._at(T.BANG):
            self._advance()
            return A.UnaryOp("not", self._unary())
        return self._postfix()

    def _postfix(self):
        node = self._primary()
        while self._at(T.DOT):
            self._advance()
            prop = self._expect(T.IDENT).value
            node = A.PropertyAccess(node, prop)
        return node

    def _primary(self):
        tok = self._cur()
        if tok.type == T.STRING:
            self._advance()
            return A.StringLit(tok.value)
        if tok.type == T.FSTRING:
            self._advance()
            return A.FStringLit(tok.value)
        if tok.type == T.LBRACKET:
            return self._array_lit()
        if tok.type == T.LPAREN:
            self._advance()
            expr = self._expression()
            self._expect(T.RPAREN)
            return expr
        if tok.type == T.IDENT:
            self._advance()
            if self._at(T.LPAREN):
                return self._call(tok.value)
            return A.Name(tok.value)
        raise SyntaxError(
            f"unexpected {tok.type.name} ({tok.value!r}) at position {tok.pos}"
        )

    def _call(self, func):
        self._expect(T.LPAREN)
        args = self._arg_list()
        self._expect(T.RPAREN)
        return A.Call(func, args)

    def _array_lit(self):
        self._expect(T.LBRACKET)
        elements = []
        if not self._at(T.RBRACKET):
            elements.append(self._expression())
            while self._at(T.COMMA):
                self._advance()
                elements.append(self._expression())
        self._expect(T.RBRACKET)
        return A.ArrayLit(elements)
