//! agape-rs — a clean-room Rust implementation of the Agape language, built to
//! pass the v1.0 conformance suite (`../agape-conformance`).
//!
//! Pipeline (filled in milestone by milestone):
//!
//! ```text
//! source ──▶ lexer (M1) ──▶ parser/AST (M2) ──▶ checker (M3) ──▶ interp+ledger (M4)
//! ```
//!
//! `process` is the single entry point the conformance harness drives: it runs a
//! source string through the whole pipeline and returns either the produced ledger
//! (accept) or the first `AgapeError` (reject, carrying the asserted error class).

pub mod ast; // M2
pub mod check; // M3
pub mod conformance;
pub mod diag;
pub mod hash; // SHA-256 for the ledger hash-chain (§16.2)
pub mod interp; // M4
pub mod ledger;
pub mod lexer; // M1
pub mod parser; // M2

use ast::Stmt;
use diag::AgapeError;
use ledger::Ledger;

pub use interp::{HarnessConfig, ProviderMode};

/// One compiled module: its fully-qualified path (the root module's path is its
/// `module` header, or `""` if it has none) and its top-level statements (§19.2).
#[derive(Debug, Clone)]
pub struct Module {
    pub path: String,
    pub stmts: Vec<Stmt>,
}

/// Lex + parse one source string into a [`Module`]; the path is taken from its
/// `module` header (else `fallback`).
pub fn parse_module(source: &str, fallback: &str) -> Result<Module, AgapeError> {
    let tokens = lexer::lex(source)?;
    let stmts = parser::parse(tokens)?;
    let path = stmts
        .iter()
        .find_map(|s| match s {
            Stmt::ModuleDecl { path } => Some(path.clone()),
            _ => None,
        })
        .unwrap_or_else(|| fallback.to_string());
    Ok(Module { path, stmts })
}

/// Run a multi-module program (the root plus its companion modules) through the
/// whole pipeline (§19). The first module is the root (the program entry).
pub fn process_modules(modules: &[Module], config: &HarnessConfig) -> Result<Ledger, AgapeError> {
    check::check_program(modules)?;
    Ok(interp::run_program(modules, config))
}

/// Run a program through the entire pipeline:
/// `lex` → `parse` → `check` → `interp`. A program that passes the static checks
/// is executed to quiescence on the runtime (with deterministic mock seams), and
/// the produced ledger is returned — which the conformance harness matches against
/// each test's `ledger:`/`contains:`/`absent:` assertions.
pub fn process(source: &str) -> Result<Ledger, AgapeError> {
    process_with_config(source, &HarnessConfig::default())
}

/// As [`process`], but with an injected seam configuration (§17.5 test-mode): a
/// scripted provider distribution, an empty/schema-violating provider, a denying
/// identity seam, or the eager-internalize memory trigger.
pub fn process_with_config(source: &str, config: &HarnessConfig) -> Result<Ledger, AgapeError> {
    let root = parse_module(source, "")?;
    process_modules(&[root], config)
}
