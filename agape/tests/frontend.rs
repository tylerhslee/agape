//! Integration tests for the front-end against the example programs.

use agape::{lex, parse};

#[test]
fn lexes_full_hello_ag() {
    // The Rust lexer must agree with the verified POC lexer on the canonical
    // program. (Cross-checked token-for-token against poc/lexer.py.)
    let src = include_str!("../examples/hello.ag");
    let toks = lex(src).expect("hello.ag should lex cleanly");
    assert_eq!(toks.len(), 645, "token count drift in hello.ag");
}

#[test]
fn parses_basics_ag_fully() {
    // basics.ag is the slice the current parser supports end to end.
    let src = include_str!("../examples/basics.ag");
    let toks = lex(src).expect("basics.ag should lex");
    let stmts = parse(toks).expect("basics.ag should parse");
    assert!(stmts.len() >= 12, "expected the full basics.ag program, got {}", stmts.len());
}
