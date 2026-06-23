//! Agape — a compiled language for multi-agent systems.
//!
//! This crate is the real (non-POC) implementation. Today it provides the
//! front-end (lexer, AST, parser) plus the runtime foundations (the event
//! spine and the provider seam). The type checker and code generator are the
//! road ahead — see `README.md` → Roadmap.

pub mod ast;
pub mod lexer;
pub mod parser;
pub mod provider;
pub mod spine;
pub mod token;

pub use lexer::{lex, LexError};
pub use parser::{parse, ParseError};
