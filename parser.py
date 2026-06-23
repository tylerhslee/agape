from lexer import T
import ast_nodes as A


class Parser:
    """Tokens -> AST (recursive descent).

    Design note: the parser stays as dumb about MEANING as the lexer was about
    grammar. Inside a query pattern it records identifier *text* by position and
    does NOT decide whether a name is a bound value, a type, or a fresh variable
    — that resolution happens later, in the evaluator, by what the name denotes
    in scope. Each stage knows exactly one more thing than the last.
    """

    def __init__(self, tokens):
        self.toks = tokens
        self.i = 0

    # --- token helpers ---
    def _cur(self):
        return self.toks[self.i]

    def _at(self, ttype):
        return self._cur().type == ttype

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

    # --- entry point ---
    def parse(self):
        stmts = []
        while not self._at(T.EOF):
            stmts.append(self._statement())
        return stmts

    # --- statements ---
    def _statement(self):
        if self._at(T.AGENT):  return self._agent_decl()
        if self._at(T.EVENT):  return self._event_bind()
        if self._at(T.VERIFY): return self._verify_stmt()
        if self._at(T.CATCH):  return self._catch_stmt()
        if self._at(T.FIND):   return self._find_stmt()
        # otherwise: a bare expression statement (a send or a call)
        expr = self._expression()
        self._expect(T.SEMI)
        return A.ExprStmt(expr)

    def _agent_decl(self):
        self._expect(T.AGENT)
        name = self._expect(T.IDENT).value
        prompt = None
        if self._at(T.LPAREN):                  # constructor arg (system prompt)
            self._advance()
            if not self._at(T.RPAREN):
                prompt = self._expression()
            self._expect(T.RPAREN)
        if self._at(T.LBRACE):                  # body block ends the decl (no ;)
            body = self._block()
        else:
            body = []
            self._expect(T.SEMI)                # bodyless form still needs ;
        return A.AgentDecl(name, prompt, body)

    def _event_bind(self):
        self._expect(T.EVENT)
        name = self._expect(T.IDENT).value
        self._expect(T.EQUALS)
        expr = self._expression()
        self._expect(T.SEMI)
        return A.EventBind(name, expr)

    def _verify_stmt(self):
        self._expect(T.VERIFY)
        check = self._expression()              # expected: a Compare
        self._expect(T.SEMI)
        return A.VerifyStmt(check)

    def _catch_stmt(self):
        self._expect(T.CATCH)
        event_type = self._expect(T.IDENT).value
        self._expect(T.LPAREN)
        source = self._expect(T.IDENT).value
        self._expect(T.RPAREN)
        self._expect(T.AS)
        binding = self._expect(T.IDENT).value
        body = self._block()
        return A.Catch(event_type, source, binding, body)

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

    # --- query patterns: a flat run of names read POSITIONALLY into triples ---
    def _pattern(self):
        triples = []
        while not self._at(T.RBRACE):
            self._chain(triples)
            if self._at(T.COMMA):               # comma separates AND-ed terms
                self._advance()
        return triples

    def _chain(self, triples):
        # node (edge node)+  ->  a chain of triples sharing intermediate nodes.
        prev = self._node_atom()
        while not (self._at(T.COMMA) or self._at(T.RBRACE)):
            pred = self._expect(T.IDENT).value
            nxt = self._node_atom()
            triples.append(A.TriplePattern(prev, pred, nxt))
            prev = nxt

    def _node_atom(self):
        # a node slot: an identifier (value/type/variable — resolved later) or
        # a string literal.
        if self._at(T.STRING):
            return self._advance().value
        return self._expect(T.IDENT).value

    # --- expressions ---
    def _expression(self):
        left = self._primary()
        if self._at(T.ARROW):                   # target <- payload
            self._advance()
            payload = self._expression()
            if not isinstance(left, A.Name):
                raise SyntaxError("left of <- must be a name (an agent)")
            return A.Send(left.ident, payload)
        if self._at(T.RARROW):                  # payload -> target
            self._advance()
            target = self._primary()
            if not isinstance(target, A.Name):
                raise SyntaxError("right of -> must be a name (an agent)")
            return A.Send(target.ident, left)
        if self._at(T.EQEQ):
            self._advance()
            return A.Compare(left, "exact", self._primary())
        if self._at(T.TILDE):
            self._advance()
            return A.Compare(left, "semantic", self._primary())
        if self._at(T.IS):
            self._advance()
            return A.Compare(left, "identity", self._primary())
        return left

    def _primary(self):
        tok = self._cur()
        if tok.type == T.STRING:
            self._advance()
            return A.StringLit(tok.value)
        if tok.type == T.LPAREN:                # grouping
            self._advance()
            expr = self._expression()
            self._expect(T.RPAREN)
            return expr
        if tok.type == T.IDENT:
            self._advance()
            if self._at(T.LPAREN):              # a call, e.g. say(e)
                return self._call(tok.value)
            return A.Name(tok.value)
        raise SyntaxError(
            f"unexpected {tok.type.name} ({tok.value!r}) at position {tok.pos}"
        )

    def _call(self, func):
        self._expect(T.LPAREN)
        args = []
        if not self._at(T.RPAREN):
            args.append(self._expression())
            while self._at(T.COMMA):
                self._advance()
                args.append(self._expression())
        self._expect(T.RPAREN)
        return A.Call(func, args)
