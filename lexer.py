from dataclasses import dataclass
from enum import Enum, auto


class T(Enum):
    # literals / names
    IDENT = auto()        # HelloWorld, Coach, n, is_named
    STRING = auto()       # "what is your name?"
    FSTRING = auto()      # f"Your name is {n}."  (template preserved verbatim)
    # keywords
    AGENT = auto()        # agent
    MEM = auto()          # mem        (legacy; kept so old programs still run)
    EVENT = auto()        # event
    VERIFY = auto()       # verify
    CATCH = auto()        # catch
    AS = auto()           # as
    FIND = auto()         # find
    WHERE = auto()        # where
    IS = auto()           # is         (identity equality)
    WHEN = auto()         # when       (reactive block: fires on success)
    EMIT = auto()         # emit       (programmer-controlled event emission)
    EXTEND = auto()       # extend     (agent inheritance)
    IF = auto()           # if
    ELSE = auto()         # else
    FN = auto()           # fn         (named function declaration)
    RETURN = auto()       # return
    SPAWN = auto()        # spawn      (create an agent instance)
    AWAKE = auto()        # awake      (open agent mailbox)
    SLEEP = auto()        # sleep      (close agent mailbox / GC when unreferenced)
    # operators / punctuation
    ARROW = auto()        # <-   send (target on the right)
    RARROW = auto()       # ->   send (target on the left); both directions valid
    PIPEARROW = auto()    # |>   pipe operator for functional composition
    STAR = auto()         # *    (somatic pointer — quarantined to unsafe context)
    EQUALS = auto()       # =    binding
    EQEQ = auto()         # ==   exact equality
    TILDE = auto()        # ~    semantic equality
    SLASH = auto()        # /    path-traversal sugar
    DOT = auto()          # .    structural field access
    COLON = auto()        # :    lambda parameter separator (x: expr)
    BANG = auto()         # !    boolean negation
    LPAREN = auto()       # (
    RPAREN = auto()       # )
    LBRACE = auto()       # {
    RBRACE = auto()       # }
    LBRACKET = auto()     # [    array literal open
    RBRACKET = auto()     # ]    array literal close
    LT = auto()           # <    generic type open  (event<T>)
    GT = auto()           # >    generic type close
    COMMA = auto()        # ,
    SEMI = auto()         # ;
    EOF = auto()          # end of input


KEYWORDS = {
    "agent":  T.AGENT,
    "mem":    T.MEM,
    "event":  T.EVENT,
    "verify": T.VERIFY,
    "catch":  T.CATCH,
    "as":     T.AS,
    "find":   T.FIND,
    "where":  T.WHERE,
    "is":     T.IS,
    "when":   T.WHEN,
    "emit":   T.EMIT,
    "extend": T.EXTEND,
    "if":     T.IF,
    "else":   T.ELSE,
    "fn":     T.FN,
    "return": T.RETURN,
    "spawn":  T.SPAWN,
    "awake":  T.AWAKE,
    "sleep":  T.SLEEP,
}


@dataclass
class Token:
    type: T
    value: str
    pos: int        # index in source where this token starts


class Lexer:
    """Text -> flat token stream.

    The lexer knows TOKENS, not grammar. It emits `when`, `|>`, `f"..."` etc.
    without any idea how they combine — that's the parser's job.

    Key decisions:
    - Two-char operators are checked BEFORE single-char (so `==` isn't two `=`,
      `<-` isn't `<` then `-`, and `|>` isn't `|` then `>`).
    - `<` is LT only after confirming it is NOT `<-` (ARROW).
    - `f"..."` is lexed as a single FSTRING token; the raw template string
      (including `{var}` markers) is the value. The evaluator resolves
      interpolation at runtime by looking up variable names in scope.
    - `sleep` is a keyword even though it matches a Unix command — the language
      owns its own namespace and the shell never sees .ag source.
    - `all`/`any` are NOT keywords — they are built-in function names, parsed
      as ordinary calls: `all(expr)`. No special token needed.
    """

    def __init__(self, source):
        self.src = source
        self.i = 0
        self.tokens = []

    def lex(self):
        while self.i < len(self.src):
            c = self.src[self.i]

            if c.isspace():
                self.i += 1
                continue

            # line comments: `//` to end of line — comments never reach parser
            if c == '/' and self._peek() == '/':
                while self.i < len(self.src) and self.src[self.i] != '\n':
                    self.i += 1
                continue

            # f-strings: must check BEFORE the plain-string `"` and BEFORE the
            # identifier path, so `f"..."` is one FSTRING token, not IDENT("f")
            # followed by STRING.
            if c == 'f' and self._peek() == '"':
                self._fstring()
                continue

            if c == '"':
                self._string()
                continue

            # TWO-char operators — checked BEFORE single-char counterparts
            if c == '<' and self._peek() == '-':
                self._emit(T.ARROW,     "<-", 2); continue
            if c == '-' and self._peek() == '>':
                self._emit(T.RARROW,    "->", 2); continue
            if c == '=' and self._peek() == '=':
                self._emit(T.EQEQ,      "==", 2); continue
            if c == '|' and self._peek() == '>':
                self._emit(T.PIPEARROW, "|>", 2); continue

            single = {
                '*': T.STAR,     '=': T.EQUALS,   '~': T.TILDE,
                '/': T.SLASH,    '.': T.DOT,       ':': T.COLON,
                '!': T.BANG,
                '(': T.LPAREN,   ')': T.RPAREN,
                '{': T.LBRACE,   '}': T.RBRACE,
                '[': T.LBRACKET, ']': T.RBRACKET,
                '<': T.LT,       '>': T.GT,
                ',': T.COMMA,    ';': T.SEMI,
            }
            if c in single:
                self._emit(single[c], c, 1); continue

            if c.isalpha() or c == '_':
                self._ident()
                continue

            raise SyntaxError(f"unexpected character {c!r} at position {self.i}")

        self.tokens.append(Token(T.EOF, "", self.i))
        return self.tokens

    # ---- helpers ----

    def _emit(self, ttype, value, length):
        self.tokens.append(Token(ttype, value, self.i))
        self.i += length

    def _peek(self):
        nxt = self.i + 1
        return self.src[nxt] if nxt < len(self.src) else ""

    def _string(self):
        start = self.i
        self.i += 1                 # skip opening "
        chars = []
        while self.i < len(self.src) and self.src[self.i] != '"':
            chars.append(self.src[self.i])
            self.i += 1
        if self.i >= len(self.src):
            raise SyntaxError(f"unterminated string starting at position {start}")
        self.i += 1                 # skip closing "
        self.tokens.append(Token(T.STRING, "".join(chars), start))

    def _fstring(self):
        """Lex f"..." as a single FSTRING token.

        The value is the raw template with {varname} markers intact.
        Example: f"Your name is {n}." -> Token(FSTRING, "Your name is {n}.")
        Interpolation is resolved by the evaluator, not the lexer.
        """
        start = self.i
        self.i += 2                 # skip f"
        chars = []
        while self.i < len(self.src) and self.src[self.i] != '"':
            chars.append(self.src[self.i])
            self.i += 1
        if self.i >= len(self.src):
            raise SyntaxError(f"unterminated f-string starting at position {start}")
        self.i += 1                 # skip closing "
        self.tokens.append(Token(T.FSTRING, "".join(chars), start))

    def _ident(self):
        start = self.i
        while self.i < len(self.src) and (self.src[self.i].isalnum() or self.src[self.i] == '_'):
            self.i += 1
        word = self.src[start:self.i]
        # Maximal munch THEN keyword lookup, so `is_named` stays one IDENT.
        ttype = KEYWORDS.get(word, T.IDENT)
        self.tokens.append(Token(ttype, word, start))
