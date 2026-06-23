//! The `agape` command-line driver.
//!
//! Subcommands:
//!   agape lex   <file.ag>   — tokenize and print the token stream
//!   agape parse <file.ag>   — parse and print the AST (one top-level node/line)
//!   agape check <file.ag>   — lex + parse, report success/failure only
//!
//! Running a program end-to-end (spine + provider seam) is the next milestone.

use std::process::ExitCode;

use agape::{lex, parse};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: agape <lex|parse|check> <file.ag>");
        return ExitCode::from(2);
    }
    let cmd = args[1].as_str();
    let path = &args[2];

    let src = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: cannot read {path}: {e}");
            return ExitCode::from(2);
        }
    };

    match cmd {
        "lex" => run_lex(&src),
        "parse" => run_parse(&src),
        "check" => run_check(&src),
        other => {
            eprintln!("error: unknown subcommand {other:?} (expected lex|parse|check)");
            ExitCode::from(2)
        }
    }
}

fn run_lex(src: &str) -> ExitCode {
    match lex(src) {
        Ok(toks) => {
            for t in &toks {
                println!("{t}");
            }
            println!("\n{} tokens.", toks.len());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

fn run_parse(src: &str) -> ExitCode {
    let toks = match lex(src) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    match parse(toks) {
        Ok(stmts) => {
            for s in &stmts {
                println!("{s:?}");
            }
            println!("\n{} top-level statement(s).", stmts.len());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

fn run_check(src: &str) -> ExitCode {
    let toks = match lex(src) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("lex failed: {e}");
            return ExitCode::FAILURE;
        }
    };
    let ntoks = toks.len();
    match parse(toks) {
        Ok(stmts) => {
            println!("ok: {ntoks} tokens, {} top-level statement(s).", stmts.len());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("parse failed: {e}");
            ExitCode::FAILURE
        }
    }
}
