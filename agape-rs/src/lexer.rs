//! The Agape lexer (M1): source text → a flat stream of [`Token`]s.
//!
//! Tokenizes the SPEC-1.0 surface (§2). Notable v1.0 lexical rules:
//!
//! - There is exactly one communication arrow, `<-`. A `->` is a **`LexError`**
//!   (§2) — detected explicitly, not left to decompose into `-` `>`.
//! - There is no similarity operator. `~` still *lexes* (to an `Op` token) so the
//!   parser can reject it as a **`ParseError`** (`v1_lex_tilde_removed`), rather
//!   than the lexer failing on an "unexpected character".
//! - `calibrate` / `entail` are **not** keywords (they lex as ordinary
//!   identifiers); the parser rejects them in statement position (§2).
//! - `#!name` is a one-token module attribute (`Pragma`).

use crate::diag::{AgapeError, ErrorClass, Span};

/// The lexical category of a token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    /// A reserved word (`agent`, `verify`, `sync`, ...).
    Keyword,
    /// An identifier (variable / type / agent name / contextual word).
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
    /// A file/module attribute `#!name`; `value` is the name without `#!`.
    Pragma,
    /// End of input.
    Eof,
}

/// A single lexical token with its byte span and 1-based source position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub value: String,
    pub span: Span,
    pub line: usize,
    pub col: usize,
}

impl Token {
    /// True if this token is the operator `op`.
    pub fn is_op(&self, op: &str) -> bool {
        self.kind == TokenKind::Op && self.value == op
    }
    /// True if this token is the keyword `kw`.
    pub fn is_kw(&self, kw: &str) -> bool {
        self.kind == TokenKind::Keyword && self.value == kw
    }
    /// True if this token is the identifier `name` (used for contextual words).
    pub fn is_ident(&self, name: &str) -> bool {
        self.kind == TokenKind::Ident && self.value == name
    }
}

/// Reserved words of SPEC-1.0 §2. A bare identifier matching one of these lexes
/// as a keyword. Deliberately EXCLUDED (so they lex as identifiers): the
/// contextual words (`as`, `by`, `reach`, `use`, `origin`, `expires`, `of`,
/// `margin`), the prelude identifiers (`Credence`, `Principal`, `Rule`,
/// `Verification`, `Entailment`, `say`, ...), and the retired words
/// (`entail`, `calibrate`).
pub const KEYWORDS: &[&str] = &[
    // types + spine wrapper + somatic aggregate
    "int", "float", "bool", "text", "null", "event", "array",
    // declarations + marked color
    "agent", "extend", "sync", "struct", "enum",
    // capability typing (§13) + tool declaration + effect class (§6b)
    "grants", "authority", "tool", "read", "write",
    // lifecycle + external input sensor (§5, §5b)
    "spawn", "awake", "sleep", "self", "on", "prompt",
    // identity seam (§13)
    "principal",
    // control / reactive
    "when", "catch", "case", "if", "else", "return", "retry", "default",
    // gate / spine emit / action perform (v1.0); verify/decide are legacy
    "verify", "decide", "emit", "endorse", "attest", "perform", "abstain", "action", "policy",
    // queries (§10)
    "find", "where", "select", "from", "match",
    // aggregation + dependence declaration + quorum (§12)
    "all", "any", "quorum", "independent", "dependent",
    // bool literals
    "true", "false",
    // somatic kernel (§15.2)
    "while", "break", "import",
];

/// Operators, longest-first so multi-char operators win over their prefixes.
/// `~` lexes on purpose (the parser, not the lexer, rejects it as a ParseError, §2).
/// `->` deliberately does NOT lex: Agape has exactly one communication arrow, `<-`,
/// and a `->` is a `LexError` (§2). It is detected explicitly above, before this
/// list, so it never decomposes into `-` `>`. Tools use a prefix return type
/// (`tool T f();`), like a function signature — no arrow.
const OPERATORS: &[&str] = &[
    "<-", "|>", ">=", "<=", "==", "!=", //
    "{", "}", "(", ")", "[", "]", //
    ";", ",", ".", ":", //
    "=", "+", "-", "*", "/", "<", ">", "!", "~",
];

fn is_keyword(word: &str) -> bool {
    KEYWORDS.contains(&word)
}

/// Tokenize `src` into a token list terminated by `Eof`, or the first
/// [`AgapeError`] (class `Lex`).
pub fn lex(src: &str) -> Result<Vec<Token>, AgapeError> {
    let chars: Vec<char> = src.chars().collect();
    let n = chars.len();
    let mut toks: Vec<Token> = Vec::new();
    let mut i = 0usize; // char index
    let mut byte = 0usize; // byte offset (for spans)
    let mut line = 1usize;
    let mut col = 1usize;

    // advance one character, keeping byte/line/col in sync
    macro_rules! bump {
        () => {{
            byte += chars[i].len_utf8();
            i += 1;
            col += 1;
        }};
    }

    while i < n {
        let c = chars[i];

        if c == '\n' {
            byte += 1;
            i += 1;
            line += 1;
            col = 1;
            continue;
        }
        if c == ' ' || c == '\t' || c == '\r' {
            bump!();
            continue;
        }

        // line comment: // ...
        if c == '/' && i + 1 < n && chars[i + 1] == '/' {
            while i < n && chars[i] != '\n' {
                byte += chars[i].len_utf8();
                i += 1;
            }
            continue;
        }

        // module attribute: #!name  (one Pragma token)
        if c == '#' && i + 1 < n && chars[i + 1] == '!' {
            let (start_byte, start_col) = (byte, col);
            bump!();
            bump!();
            let mut name = String::new();
            while i < n && (chars[i].is_alphanumeric() || chars[i] == '_') {
                name.push(chars[i]);
                bump!();
            }
            toks.push(Token { kind: TokenKind::Pragma, value: name, span: Span::new(start_byte, byte), line, col: start_col });
            continue;
        }

        // f-string: f"..."  (lexed whole; {expr} parsed by the parser)
        if c == 'f' && i + 1 < n && chars[i + 1] == '"' {
            let (start_byte, start_line, start_col) = (byte, line, col);
            bump!();
            bump!();
            let mut buf = String::new();
            while i < n && chars[i] != '"' {
                if chars[i] == '\n' {
                    return Err(AgapeError::at(ErrorClass::Lex, Span::new(start_byte, byte), format!("unterminated f-string at line {start_line}")));
                }
                buf.push(chars[i]);
                bump!();
            }
            if i >= n {
                return Err(AgapeError::at(ErrorClass::Lex, Span::new(start_byte, byte), format!("unterminated f-string at line {start_line}")));
            }
            bump!(); // closing quote
            toks.push(Token { kind: TokenKind::FStr, value: buf, span: Span::new(start_byte, byte), line: start_line, col: start_col });
            continue;
        }

        // string literal
        if c == '"' {
            let (start_byte, start_line, start_col) = (byte, line, col);
            bump!();
            let mut buf = String::new();
            while i < n && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < n {
                    let resolved = match chars[i + 1] {
                        'n' => '\n',
                        't' => '\t',
                        '"' => '"',
                        '\\' => '\\',
                        other => other,
                    };
                    buf.push(resolved);
                    bump!();
                    bump!();
                    continue;
                }
                if chars[i] == '\n' {
                    return Err(AgapeError::at(ErrorClass::Lex, Span::new(start_byte, byte), format!("unterminated string at line {start_line}")));
                }
                buf.push(chars[i]);
                bump!();
            }
            if i >= n {
                return Err(AgapeError::at(ErrorClass::Lex, Span::new(start_byte, byte), format!("unterminated string at line {start_line}")));
            }
            bump!(); // closing quote
            toks.push(Token { kind: TokenKind::Str, value: buf, span: Span::new(start_byte, byte), line: start_line, col: start_col });
            continue;
        }

        // number (int or float)
        if c.is_ascii_digit() {
            let (start_byte, start_line, start_col) = (byte, line, col);
            let mut buf = String::new();
            let mut is_float = false;
            while i < n && (chars[i].is_ascii_digit() || chars[i] == '.') {
                if chars[i] == '.' {
                    // a second dot, or a dot not followed by a digit, ends the number
                    if is_float || !(i + 1 < n && chars[i + 1].is_ascii_digit()) {
                        break;
                    }
                    is_float = true;
                }
                buf.push(chars[i]);
                bump!();
            }
            let kind = if is_float { TokenKind::Float } else { TokenKind::Int };
            toks.push(Token { kind, value: buf, span: Span::new(start_byte, byte), line: start_line, col: start_col });
            continue;
        }

        // identifier or keyword
        if c.is_alphabetic() || c == '_' {
            let (start_byte, start_line, start_col) = (byte, line, col);
            let mut buf = String::new();
            while i < n && (chars[i].is_alphanumeric() || chars[i] == '_') {
                buf.push(chars[i]);
                bump!();
            }
            let kind = if is_keyword(&buf) { TokenKind::Keyword } else { TokenKind::Ident };
            toks.push(Token { kind, value: buf, span: Span::new(start_byte, byte), line: start_line, col: start_col });
            continue;
        }

        // `->` is retired (§2): exactly one communication arrow, `<-`. Detect it
        // explicitly so it is a `LexError`, never a `-` `>` decomposition.
        if c == '-' && i + 1 < n && chars[i + 1] == '>' {
            return Err(AgapeError::at(
                ErrorClass::Lex,
                Span::new(byte, byte + 2),
                format!("`->` is not a token; Agape has exactly one communication arrow `<-` (§2), at line {line} col {col}"),
            ));
        }

        // operators (longest match first)
        let mut matched = false;
        for op in OPERATORS {
            if starts_with_at(&chars, i, op) {
                let (start_byte, start_col) = (byte, col);
                let len = op.chars().count();
                for _ in 0..len {
                    bump!();
                }
                toks.push(Token { kind: TokenKind::Op, value: (*op).to_string(), span: Span::new(start_byte, byte), line, col: start_col });
                matched = true;
                break;
            }
        }
        if matched {
            continue;
        }

        return Err(AgapeError::at(
            ErrorClass::Lex,
            Span::new(byte, byte + c.len_utf8()),
            format!("unexpected character {c:?} at line {line} col {col}"),
        ));
    }

    toks.push(Token { kind: TokenKind::Eof, value: String::new(), span: Span::new(byte, byte), line, col });
    Ok(toks)
}

/// True if `pat` matches the characters of `chars` starting at index `i`.
fn starts_with_at(chars: &[char], i: usize, pat: &str) -> bool {
    let mut j = i;
    for pc in pat.chars() {
        if j >= chars.len() || chars[j] != pc {
            return false;
        }
        j += 1;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(src: &str) -> Vec<(TokenKind, String)> {
        lex(src).unwrap().into_iter().map(|t| (t.kind, t.value)).collect()
    }

    #[test]
    fn var_decl() {
        let k = kinds("int a = 2 + 3;");
        assert_eq!(k[0], (TokenKind::Keyword, "int".into()));
        assert_eq!(k[1], (TokenKind::Ident, "a".into()));
        assert_eq!(k[2], (TokenKind::Op, "=".into()));
        assert_eq!(k[3], (TokenKind::Int, "2".into()));
        assert_eq!(k.last().unwrap().0, TokenKind::Eof);
    }

    #[test]
    fn send_arrow_one_token() {
        let toks = lex("self <- \"hi\";").unwrap();
        assert!(toks.iter().any(|t| t.is_op("<-")));
        assert!(!toks.iter().any(|t| t.is_op("->")));
    }

    #[test]
    fn right_arrow_is_lex_error() {
        // `->` is retired (§2): exactly one communication arrow, `<-`.
        assert!(lex("a -> b").is_err());
        // tools now use a prefix return type — no arrow, lexes cleanly.
        assert!(lex("read tool text search(text q);").is_ok());
    }

    #[test]
    fn tilde_lexes_as_op() {
        // `~` must lex (so the parser, not the lexer, rejects it).
        let toks = lex("\"a\" ~ \"b\"").unwrap();
        assert!(toks.iter().any(|t| t.is_op("~")));
    }

    #[test]
    fn calibrate_and_entail_are_identifiers() {
        let toks = lex("calibrate entail").unwrap();
        assert_eq!(toks[0].kind, TokenKind::Ident);
        assert_eq!(toks[1].kind, TokenKind::Ident);
    }

    #[test]
    fn v1_keywords() {
        for kw in ["struct", "enum", "tool", "principal", "decide", "quorum", "independent", "dependent"] {
            let toks = lex(kw).unwrap();
            assert!(toks[0].is_kw(kw), "{kw} should be a keyword");
        }
    }

    #[test]
    fn contextual_words_are_idents() {
        for w in ["as", "by", "reach", "use", "origin", "of", "margin"] {
            let toks = lex(w).unwrap();
            assert_eq!(toks[0].kind, TokenKind::Ident, "{w} should lex as an identifier");
        }
    }

    #[test]
    fn fstring_whole() {
        let toks = lex("f\"a={a}\"").unwrap();
        assert_eq!(toks[0].kind, TokenKind::FStr);
        assert_eq!(toks[0].value, "a={a}");
    }

    #[test]
    fn float_vs_int_and_member() {
        let k = kinds("7.0 / 2");
        assert_eq!(k[0], (TokenKind::Float, "7.0".into()));
        assert_eq!(k[2], (TokenKind::Int, "2".into()));
        // a dot not followed by a digit is a member access, not part of a number
        let k2 = kinds("m.to");
        assert_eq!(k2[0], (TokenKind::Ident, "m".into()));
        assert_eq!(k2[1], (TokenKind::Op, ".".into()));
        assert_eq!(k2[2], (TokenKind::Ident, "to".into()));
    }

    #[test]
    fn pragma() {
        let toks = lex("#!somatic").unwrap();
        assert_eq!(toks[0].kind, TokenKind::Pragma);
        assert_eq!(toks[0].value, "somatic");
    }
}
