from dataclasses import dataclass
from enum import Enum, auto


class T(Enum):
    # literals / names
    IDENT = auto()      # HelloWorld, X, Y
    STRING = auto()     # "what is your name?"
    # keywords
    AGENT = auto()      # agent
    MEM = auto()        # mem
    EVENT = auto()      # event
    VERIFY = auto()     # verify
    # operators / punctuation
    ARROW = auto()      # <-
    STAR = auto()       # *
    EQUALS = auto()     # =
    LPAREN = auto()     # (
    RPAREN = auto()     # )
    COMMA = auto()      # ,
    SEMI = auto()       # ;
    EOF = auto()        # end of input


KEYWORDS = {
    "agent": T.AGENT,
    "mem": T.MEM,
    "event": T.EVENT,
    "verify": T.VERIFY,
}


@dataclass
class Token:
    type: T
    value: str
    pos: int        # index in source where this token starts


class Lexer:
    def __init__(self, source):
        self.src = source
        self.i = 0                  # current read position
        self.tokens = []

    def lex(self):
        while self.i < len(self.src):
            c = self.src[self.i]

            if c.isspace():
                self.i += 1
                continue

            if c == '"':
                self._string()
                continue

            if c == '<' and self._peek() == '-':
                self.tokens.append(Token(T.ARROW, "<-", self.i))
                self.i += 2
                continue

            single = {
                '*': T.STAR, '=': T.EQUALS, '(': T.LPAREN,
                ')': T.RPAREN, ',': T.COMMA, ';': T.SEMI,
            }
            if c in single:
                self.tokens.append(Token(single[c], c, self.i))
                self.i += 1
                continue

            if c.isalpha() or c == '_':
                self._ident()
                continue

            raise SyntaxError(f"unexpected character {c!r} at position {self.i}")

        self.tokens.append(Token(T.EOF, "", self.i))
        return self.tokens

    def _peek(self):
        nxt = self.i + 1
        return self.src[nxt] if nxt < len(self.src) else ""

    def _string(self):
        start = self.i
        self.i += 1                 # skip opening quote
        chars = []
        while self.i < len(self.src) and self.src[self.i] != '"':
            chars.append(self.src[self.i])
            self.i += 1
        if self.i >= len(self.src):
            raise SyntaxError(f"unterminated string starting at position {start}")
        self.i += 1                 # skip closing quote
        self.tokens.append(Token(T.STRING, "".join(chars), start))

    def _ident(self):
        start = self.i
        while self.i < len(self.src) and (self.src[self.i].isalnum() or self.src[self.i] == '_'):
            self.i += 1
        word = self.src[start:self.i]
        ttype = KEYWORDS.get(word, T.IDENT)
        self.tokens.append(Token(ttype, word, start))
