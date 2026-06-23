//! The Agape lexer: source text → a flat stream of [`Token`]s.
//!
//! This is a faithful port of the POC lexer (`poc/lexer.py`), which is verified
//! to tokenize `hello.ag` cleanly. It handles `//` line comments, whitespace,
//! string literals with escapes, f-strings (lexed whole), int/float numbers,
//! identifiers/keywords, and the operator set — including the multi-char
//! operators `<- |> >= <= == !=`. There is exactly one send arrow, `<-`; there
//! is no `->`.

use crate::token::{Token, TokenKind};

/// Reserved words. A bare identifier matching one of these lexes as a keyword.
pub const KEYWORDS: &[&str] = &[
    // types
    "int", "float", "bool", "text", "null", "event",
    // declarations
    "agent", "extend", "sync",
    // lifecycle
    "spawn", "awake", "sleep", "self", "on",
    // control / reactive
    "when", "catch", "case", "if", "else", "return", "retry", "default",
    // semantic checks
    "verify", "entail", "emit",
    // queries
    "find", "where", "select", "from", "match",
    // aggregation
    "all", "any",
    // literals
    "true", "false",
    // builtins that read like keywords
    "say",
];

/// Operators, longest-first so multi-char operators win over their prefixes.
const OPERATORS: &[&str] = &[
    "<-", "|>", ">=", "<=", "==", "!=",
    "{", "}", "(", ")", "[", "]",
    ";", ",", ".", ":",
    "=", "+", "-", "*", "/", "<", ">", "~", "!",
];

/// A lexing failure, carrying a human-readable message with source position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LexError(pub String);

impl std::fmt::Display for LexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "lex error: {}", self.0)
    }
}

impl std::error::Error for LexError {}

fn is_keyword(word: &str) -> bool {
    KEYWORDS.contains(&word)
}

/// Tokenize `src`, returning the token list (terminated by an `Eof` token) or a
/// [`LexError`] on the first unexpected character.
pub fn lex(src: &str) -> Result<Vec<Token>, LexError> {
    let chars: Vec<char> = src.chars().collect();
    let n = chars.len();
    let mut toks: Vec<Token> = Vec::new();
    let mut i = 0usize;
    let mut line = 1usize;
    let mut col = 1usize;

    while i < n {
        let c = chars[i];

        // newline
        if c == '\n' {
            i += 1;
            line += 1;
            col = 1;
            continue;
        }

        // whitespace
        if c == ' ' || c == '\t' || c == '\r' {
            i += 1;
            col += 1;
            continue;
        }

        // line comment: //...
        if c == '/' && i + 1 < n && chars[i + 1] == '/' {
            while i < n && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }

        // f-string: f"..."  (lexed whole; interpolation handled by the parser)
        if c == 'f' && i + 1 < n && chars[i + 1] == '"' {
            let (start_line, start_col) = (line, col);
            i += 2;
            col += 2;
            let mut buf = String::new();
            while i < n && chars[i] != '"' {
                if chars[i] == '\n' {
                    return Err(LexError(format!("unterminated f-string at line {start_line}")));
                }
                buf.push(chars[i]);
                i += 1;
                col += 1;
            }
            if i >= n {
                return Err(LexError(format!("unterminated f-string at line {start_line}")));
            }
            i += 1; // closing quote
            col += 1;
            toks.push(Token::new(TokenKind::FStr, buf, start_line, start_col));
            continue;
        }

        // string literal
        if c == '"' {
            let (start_line, start_col) = (line, col);
            i += 1;
            col += 1;
            let mut buf = String::new();
            while i < n && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < n {
                    let nxt = chars[i + 1];
                    let resolved = match nxt {
                        'n' => '\n',
                        't' => '\t',
                        '"' => '"',
                        '\\' => '\\',
                        other => other,
                    };
                    buf.push(resolved);
                    i += 2;
                    col += 2;
                    continue;
                }
                if chars[i] == '\n' {
                    return Err(LexError(format!("unterminated string at line {start_line}")));
                }
                buf.push(chars[i]);
                i += 1;
                col += 1;
            }
            if i >= n {
                return Err(LexError(format!("unterminated string at line {start_line}")));
            }
            i += 1; // closing quote
            col += 1;
            toks.push(Token::new(TokenKind::Str, buf, start_line, start_col));
            continue;
        }

        // number (int or float)
        if c.is_ascii_digit() {
            let (start_line, start_col) = (line, col);
            let mut buf = String::new();
            let mut is_float = false;
            while i < n && (chars[i].is_ascii_digit() || chars[i] == '.') {
                if chars[i] == '.' {
                    if is_float {
                        break;
                    }
                    is_float = true;
                }
                buf.push(chars[i]);
                i += 1;
                col += 1;
            }
            let kind = if is_float { TokenKind::Float } else { TokenKind::Int };
            toks.push(Token::new(kind, buf, start_line, start_col));
            continue;
        }

        // identifier or keyword
        if c.is_alphabetic() || c == '_' {
            let (start_line, start_col) = (line, col);
            let mut buf = String::new();
            while i < n && (chars[i].is_alphanumeric() || chars[i] == '_') {
                buf.push(chars[i]);
                i += 1;
                col += 1;
            }
            let kind = if is_keyword(&buf) { TokenKind::Keyword } else { TokenKind::Ident };
            toks.push(Token::new(kind, buf, start_line, start_col));
            continue;
        }

        // operators (longest match first)
        let mut matched = false;
        for op in OPERATORS {
            if starts_with_at(&chars, i, op) {
                toks.push(Token::new(TokenKind::Op, *op, line, col));
                let len = op.chars().count();
                i += len;
                col += len;
                matched = true;
                break;
            }
        }
        if matched {
            continue;
        }

        return Err(LexError(format!("unexpected character {c:?} at line {line} col {col}")));
    }

    toks.push(Token::new(TokenKind::Eof, "", line, col));
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

    #[test]
    fn lexes_var_decl() {
        let toks = lex("int a = 2 + 3;").unwrap();
        let kinds: Vec<_> = toks.iter().map(|t| (&t.kind, t.value.as_str())).collect();
        assert_eq!(kinds[0], (&TokenKind::Keyword, "int"));
        assert_eq!(kinds[1], (&TokenKind::Ident, "a"));
        assert_eq!(kinds[2], (&TokenKind::Op, "="));
        assert_eq!(kinds[3], (&TokenKind::Int, "2"));
        assert_eq!(kinds[4], (&TokenKind::Op, "+"));
        assert_eq!(kinds[5], (&TokenKind::Int, "3"));
        assert_eq!(kinds[6], (&TokenKind::Op, ";"));
        assert_eq!(toks.last().unwrap().kind, TokenKind::Eof);
    }

    #[test]
    fn send_arrow_is_one_token() {
        let toks = lex("self <- \"hi\";").unwrap();
        assert!(toks.iter().any(|t| t.is_op("<-")));
        // and there is no spurious `<` or `-` swallowing it
        assert!(!toks.iter().any(|t| t.is_op("->")));
    }

    #[test]
    fn float_vs_int() {
        let toks = lex("7.0 / 2").unwrap();
        assert_eq!(toks[0].kind, TokenKind::Float);
        assert_eq!(toks[0].value, "7.0");
        assert_eq!(toks[2].kind, TokenKind::Int);
    }

    #[test]
    fn fstring_lexed_whole() {
        let toks = lex("text s = f\"a={a}\";").unwrap();
        let fstr = toks.iter().find(|t| t.kind == TokenKind::FStr).unwrap();
        assert_eq!(fstr.value, "a={a}");
    }

    #[test]
    fn string_escapes_resolved() {
        let toks = lex("\"line\\nbreak\"").unwrap();
        assert_eq!(toks[0].value, "line\nbreak");
    }

    #[test]
    fn line_comments_skipped() {
        let toks = lex("int a = 1; // a comment\nint b = 2;").unwrap();
        let idents: Vec<_> = toks.iter().filter(|t| t.kind == TokenKind::Ident).map(|t| t.value.as_str()).collect();
        assert_eq!(idents, vec!["a", "b"]);
    }

    #[test]
    fn keyword_vs_ident() {
        let toks = lex("agent Coach").unwrap();
        assert!(toks[0].is_kw("agent"));
        assert_eq!(toks[1].kind, TokenKind::Ident);
    }
}
