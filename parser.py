from lexer import T
import ast_nodes as A


class Parser:
    def __init__(self, tokens):
        self.toks = tokens
        self.i = 0

    # --- small helpers over the token stream ---

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
        if self._at(T.AGENT):
            return self._agent_decl()
        if self._at(T.MEM):
            return self._binding(A.MemBind, T.MEM)
        if self._at(T.EVENT):
            return self._binding(A.EventBind, T.EVENT)
        # otherwise: a bare expression statement
        expr = self._expression()
        self._expect(T.SEMI)
        return A.ExprStmt(expr)

    def _agent_decl(self):
        self._expect(T.AGENT)
        name = self._expect(T.IDENT).value
        self._expect(T.SEMI)
        return A.AgentDecl(name)

    def _binding(self, node_cls, keyword):
        self._expect(keyword)
        name = self._expect(T.IDENT).value
        self._expect(T.EQUALS)
        expr = self._expression()
        self._expect(T.SEMI)
        return node_cls(name, expr)

    # --- expressions ---

    def _expression(self):
        # handle the binary send:  TARGET <- EXPR
        left = self._primary()
        if self._at(T.ARROW):
            self._advance()
            if not isinstance(left, A.Name):
                raise SyntaxError("left of <- must be a name (an agent or mem)")
            payload = self._expression()      # right-associative: a <- b <- c
            return A.Send(left.ident, payload)
        return left

    def _primary(self):
        tok = self._cur()

        if tok.type == T.STRING:
            self._advance()
            return A.StringLit(tok.value)

        if tok.type == T.STAR:
            self._advance()
            ident = self._expect(T.IDENT).value
            return A.Ref(ident)

        if tok.type == T.VERIFY:
            return self._verify()

        if tok.type == T.IDENT:
            self._advance()
            return A.Name(tok.value)

        raise SyntaxError(
            f"unexpected {tok.type.name} ({tok.value!r}) at position {tok.pos}"
        )

    def _verify(self):
        self._expect(T.VERIFY)
        self._expect(T.LPAREN)
        event = self._expression()
        self._expect(T.COMMA)
        expected = self._expression()
        self._expect(T.RPAREN)
        return A.Verify(event, expected)
