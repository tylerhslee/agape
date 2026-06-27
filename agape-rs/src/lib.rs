//! agape-rs — a clean-room Rust implementation of the Agape language, built to
//! pass the v1.0 conformance suite (`../agape-conformance`).
//!
//! Pipeline (filled in milestone by milestone):
//!
//! ```text
//! source ──▶ lexer (M1) ──▶ parser/AST (M2) ──▶ checker (M3) ──▶ interp+spine (M4)
//! ```
//!
//! `process` is the single entry point the conformance harness drives: it runs a
//! source string through the whole pipeline and returns either the produced spine
//! (accept) or the first `AgapeError` (reject, carrying the asserted error class).

pub mod ast; // M2
pub mod check; // M3
pub mod conformance;
pub mod diag;
pub mod hash; // SHA-256 for the spine hash-chain (§16.2)
pub mod interp; // M4
pub mod lexer; // M1
pub mod parser; // M2
pub mod spine;

use diag::AgapeError;
use interp::HarnessConfig;
use spine::Spine;

pub use interp::{HarnessConfig as Config, ProviderMode};

/// Run a program through the entire pipeline:
/// `lex` → `parse` → `check` → `interp`. A program that passes the static checks
/// is executed to quiescence on the runtime (with deterministic mock seams), and
/// the produced spine is returned — which the conformance harness matches against
/// each test's `spine:`/`contains:`/`absent:` assertions.
pub fn process(source: &str) -> Result<Spine, AgapeError> {
    process_with_config(source, &HarnessConfig::default())
}

/// As [`process`], but with an injected seam configuration (§17.5 test-mode): a
/// scripted provider distribution, an empty/schema-violating provider, a denying
/// identity seam, or the eager-internalize memory trigger.
pub fn process_with_config(source: &str, config: &HarnessConfig) -> Result<Spine, AgapeError> {
    let tokens = lexer::lex(source)?;
    let ast = parser::parse(tokens)?;
    check::check(&ast)?;
    Ok(interp::run_with(&ast, config))
}
