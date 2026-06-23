//! Tokens produced by the lexer.

use std::fmt;

/// The lexical category of a token. Mirrors the POC lexer's token kinds so that
/// the two front-ends agree on what the language's surface looks like.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenKind {
    /// A reserved word (`agent`, `verify`, `sync`, ...).
    Keyword,
    /// An identifier (variable / type / agent name).
    Ident,
    /// An integer literal.
    Int,
    /// A floating-point literal.
    Float,
    /// A string literal (escapes already resolved).
    Str,
    /// An f-string literal (raw template text; interpolation parsed later).
    FStr,
    /// An operator or punctuation token.
    Op,
    /// End of input.
    Eof,
}

/// A single lexical token, with the source position of its first character.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub value: String,
    pub line: usize,
    pub col: usize,
}

impl Token {
    pub fn new(kind: TokenKind, value: impl Into<String>, line: usize, col: usize) -> Self {
        Token { kind, value: value.into(), line, col }
    }

    /// True if this token is the operator `op`.
    pub fn is_op(&self, op: &str) -> bool {
        self.kind == TokenKind::Op && self.value == op
    }

    /// True if this token is the keyword `kw`.
    pub fn is_kw(&self, kw: &str) -> bool {
        self.kind == TokenKind::Keyword && self.value == kw
    }
}

impl fmt::Display for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}({:?})@{}:{}", self.kind, self.value, self.line, self.col)
    }
}
