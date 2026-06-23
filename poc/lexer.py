"""
lexer.py — turns Agape source text into a flat list of Tokens.

Handles: // line comments, whitespace, string literals, f-strings (lexed as a
single FSTRING token; interpolation parsed later), numbers, identifiers/keywords,
and the operator set including the two-char operators <- |> >= <= == != .
"""

from __future__ import annotations
from dataclasses import dataclass


KEYWORDS = {
    # types
    "int", "float", "bool", "text", "null", "event",
    # prelude verdict types are NOT keywords (they're prelude identifiers): Verification, Verdict
    # declarations
    "agent", "extend", "sync",          # `sync` marks cognition-free fns; async is default
    # lifecycle
    "spawn", "awake", "sleep", "self", "on",
    # control / reactive
    "when", "catch", "case", "if", "else", "return", "retry", "default",
    # semantic checks
    "verify", "entail", "emit",
    # queries
    "find", "where", "select", "from", "match",
    # aggregation
    "all", "any",
    # literals
    "true", "false",
    # builtins that read like keywords
    "say",
}

# Multi-char operators must be tried before single-char.
OPERATORS = [
    "<-", "|>", ">=", "<=", "==", "!=",
    "{", "}", "(", ")", "[", "]",
    ";", ",", ".", ":",
    "=", "+", "-", "*", "/", "<", ">", "~", "!",
]


@dataclass
class Token:
    kind: str       # 'KW','ID','INT','FLOAT','STR','FSTR','OP','EOF'
    value: str
    line: int
    col: int

    def __repr__(self):
        return f"{self.kind}({self.value!r})@{self.line}:{self.col}"


class LexError(Exception):
    pass


def lex(src: str) -> list[Token]:
    toks: list[Token] = []
    i = 0
    line = 1
    col = 1
    n = len(src)

    def adv(k=1):
        nonlocal i, col
        i += k
        col += k

    while i < n:
        c = src[i]

        # newline
        if c == "\n":
            i += 1
            line += 1
            col = 1
            continue

        # whitespace
        if c in " \t\r":
            adv()
            continue

        # line comment
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue

        # f-string: f"..."  (lexed whole; interpolation handled by parser)
        if c == "f" and i + 1 < n and src[i + 1] == '"':
            start_line, start_col = line, col
            adv(2)  # consume f"
            buf = []
            while i < n and src[i] != '"':
                if src[i] == "\n":
                    raise LexError(f"unterminated f-string at line {start_line}")
                buf.append(src[i])
                adv()
            if i >= n:
                raise LexError(f"unterminated f-string at line {start_line}")
            adv()  # closing "
            toks.append(Token("FSTR", "".join(buf), start_line, start_col))
            continue

        # string literal
        if c == '"':
            start_line, start_col = line, col
            adv()
            buf = []
            while i < n and src[i] != '"':
                if src[i] == "\\" and i + 1 < n:
                    nxt = src[i + 1]
                    buf.append({"n": "\n", "t": "\t", '"': '"', "\\": "\\"}.get(nxt, nxt))
                    adv(2)
                    continue
                if src[i] == "\n":
                    raise LexError(f"unterminated string at line {start_line}")
                buf.append(src[i])
                adv()
            if i >= n:
                raise LexError(f"unterminated string at line {start_line}")
            adv()  # closing "
            toks.append(Token("STR", "".join(buf), start_line, start_col))
            continue

        # number
        if c.isdigit():
            start_line, start_col = line, col
            buf = []
            is_float = False
            while i < n and (src[i].isdigit() or src[i] == "."):
                if src[i] == ".":
                    if is_float:
                        break
                    is_float = True
                buf.append(src[i])
                adv()
            toks.append(Token("FLOAT" if is_float else "INT", "".join(buf),
                              start_line, start_col))
            continue

        # identifier or keyword
        if c.isalpha() or c == "_":
            start_line, start_col = line, col
            buf = []
            while i < n and (src[i].isalnum() or src[i] == "_"):
                buf.append(src[i])
                adv()
            word = "".join(buf)
            kind = "KW" if word in KEYWORDS else "ID"
            toks.append(Token(kind, word, start_line, start_col))
            continue

        # operators
        matched = False
        for op in OPERATORS:
            if src.startswith(op, i):
                toks.append(Token("OP", op, line, col))
                adv(len(op))
                matched = True
                break
        if matched:
            continue

        raise LexError(f"unexpected character {c!r} at line {line} col {col}")

    toks.append(Token("EOF", "", line, col))
    return toks
