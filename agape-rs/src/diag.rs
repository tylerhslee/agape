//! Diagnostics — the error-class taxonomy the conformance suite asserts.
//!
//! A `reject` test names the error CLASS the implementation must raise (not the
//! message text). The suite's classes (README "Error classes"):
//!   LexError · ParseError · TypeError · ColorViolation · TaintViolation ·
//!   AuthorityViolation · ExhaustivenessError · ConfigError
//!
//! We may use richer internal names, but every failure must MAP to one of these.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    Lex,
    Parse,
    Type,
    Color,
    Taint,
    Authority,
    Exhaustiveness,
    /// Project/dependency configuration is missing or invalid (§17).
    Config,
    /// Import resolution: unresolved, cyclic, or ambiguous names (§19.2).
    Module,
    /// Naming a non-`pub` declaration, or a `pub` signature exposing a private type (§19.4).
    Visibility,
    /// An `agent : Iface` that fails the nominal conformance check (§19.5).
    Interface,
    /// A `decide` with a non-reversible arm and no reachable principal (§20.3).
    Gate,
    /// Not a suite class — used while a milestone is unimplemented so the
    /// scoreboard stays honest (matches no asserted `error:`, so a `reject` test
    /// can't accidentally "pass" against a stub).
    Unimplemented,
}

impl ErrorClass {
    /// Parse the suite's spelling ("LexError", "ColorViolation", ...).
    pub fn from_suite(s: &str) -> Option<ErrorClass> {
        Some(match s.trim() {
            "LexError" => ErrorClass::Lex,
            "ParseError" => ErrorClass::Parse,
            "TypeError" => ErrorClass::Type,
            "ColorViolation" => ErrorClass::Color,
            "TaintViolation" => ErrorClass::Taint,
            "AuthorityViolation" => ErrorClass::Authority,
            "ExhaustivenessError" => ErrorClass::Exhaustiveness,
            "ConfigError" => ErrorClass::Config,
            "ModuleError" => ErrorClass::Module,
            "VisibilityError" => ErrorClass::Visibility,
            "InterfaceError" => ErrorClass::Interface,
            "GateError" => ErrorClass::Gate,
            _ => return None,
        })
    }

    /// The suite's spelling, for reporting.
    pub fn as_suite(self) -> &'static str {
        match self {
            ErrorClass::Lex => "LexError",
            ErrorClass::Parse => "ParseError",
            ErrorClass::Type => "TypeError",
            ErrorClass::Color => "ColorViolation",
            ErrorClass::Taint => "TaintViolation",
            ErrorClass::Authority => "AuthorityViolation",
            ErrorClass::Exhaustiveness => "ExhaustivenessError",
            ErrorClass::Config => "ConfigError",
            ErrorClass::Module => "ModuleError",
            ErrorClass::Visibility => "VisibilityError",
            ErrorClass::Interface => "InterfaceError",
            ErrorClass::Gate => "GateError",
            ErrorClass::Unimplemented => "Unimplemented",
        }
    }
}

impl fmt::Display for ErrorClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_suite())
    }
}

/// A diagnostic raised by any pipeline stage. `class` is what the suite asserts;
/// `message` and `span` are for humans.
#[derive(Debug, Clone)]
pub struct AgapeError {
    pub class: ErrorClass,
    pub message: String,
    pub span: Option<Span>,
}

impl AgapeError {
    pub fn new(class: ErrorClass, message: impl Into<String>) -> Self {
        AgapeError { class, message: message.into(), span: None }
    }

    pub fn at(class: ErrorClass, span: Span, message: impl Into<String>) -> Self {
        AgapeError { class, message: message.into(), span: Some(span) }
    }
}

impl fmt::Display for AgapeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.span {
            Some(s) => write!(f, "{} at {}..{}: {}", self.class, s.start, s.end, self.message),
            None => write!(f, "{}: {}", self.class, self.message),
        }
    }
}

/// A byte range in the source, for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn new(start: usize, end: usize) -> Self {
        Span { start, end }
    }
}
